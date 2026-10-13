//! Sidecar process exposing `kitsune-core` to the Electron app.
//!
//! Protocol: newline-delimited JSON on stdin/stdout. stdout carries protocol
//! traffic only — everything human-readable goes to stderr, which Electron
//! forwards to its own log.
//!
//! Requests are `{"id": "...", "cmd": "...", ...}` and are answered with either
//! `{"id": "...", "ok": <value>}` or `{"id": "...", "error": "..."}`. Progress
//! and lifecycle notifications arrive unsolicited as `{"event": "...", ...}`.

use kitsune_core::downloader::DownloadObserver;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

const USER_AGENT: &str = "Kitsune-DM/1.0";

#[derive(Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Command {
    GetMetadata {
        url: String,
    },
    StartDownload {
        download_id: String,
        url: String,
        path: String,
        connections: u8,
    },
    CancelDownload {
        download_id: String,
    },
    SetRate {
        bytes_per_second: u64,
    },
    ReplaceUrl {
        path: String,
        url: String,
    },
    Ping,
}

#[derive(Deserialize)]
struct Request {
    id: String,
    #[serde(flatten)]
    command: Command,
}

#[derive(Serialize)]
struct Metadata {
    filename: String,
    size: u64,
    url: String,
}

/// Anything written to stdout. Serialized by a single writer task so concurrent
/// downloads cannot interleave partial lines.
#[derive(Serialize)]
#[serde(untagged)]
enum Outgoing {
    Ok {
        id: String,
        ok: serde_json::Value,
    },
    Err {
        id: String,
        error: String,
    },
    Event {
        event: &'static str,
        #[serde(flatten)]
        body: serde_json::Value,
    },
}

type Writer = mpsc::UnboundedSender<Outgoing>;

/// Bridges `kitsune-core`'s observer callbacks onto the stdout channel.
struct StdoutObserver {
    writer: Writer,
    download_id: String,
}

impl DownloadObserver for StdoutObserver {
    fn on_started(&self, downloaded: u64, total: Option<u64>) {
        let _ = self.writer.send(Outgoing::Event {
            event: "download-started",
            body: serde_json::json!({ "downloadId": self.download_id, "downloadedBytes": downloaded, "totalSize": total.unwrap_or(0) }),
        });
    }
    fn on_progress(&self, _worker_id: u8, bytes_downloaded: u64, active_workers: usize) {
        let _ = self.writer.send(Outgoing::Event {
            event: "download-progress",
            body: serde_json::json!({
                "downloadId": self.download_id,
                "bytesDownloaded": bytes_downloaded,
                "activeWorkers": active_workers,
            }),
        });
    }
}

#[derive(Default)]
struct State {
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    limiter: Arc<kitsune_core::controls::RateLimiter>,
    shutting_down: AtomicBool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Outgoing>();

    // Single writer task owns stdout.
    let writer_task = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(msg) = rx.recv().await {
            match serde_json::to_string(&msg) {
                Ok(line) => {
                    if stdout.write_all(line.as_bytes()).await.is_err()
                        || stdout.write_all(b"\n").await.is_err()
                        || stdout.flush().await.is_err()
                    {
                        break;
                    }
                }
                Err(e) => eprintln!("[kitsune-daemon] failed to serialize message: {e}"),
            }
        }
    });

    let state = Arc::new(State::default());
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut requests = tokio::task::JoinSet::new();

    while let Some(line) = lines.next_line().await? {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[kitsune-daemon] malformed request: {e}");
                continue;
            }
        };

        // Each request is handled concurrently so a long download does not block
        // metadata lookups or cancellations.
        requests.spawn(handle(request, Arc::clone(&state), tx.clone()));
        while requests.try_join_next().is_some() {}
    }

    state.shutting_down.store(true, Ordering::Relaxed);
    for flag in state.cancel_flags.lock().unwrap().values() {
        flag.store(true, Ordering::Relaxed);
    }
    while requests.join_next().await.is_some() {}
    // All writers have stopped and saved their checkpoints before shutdown.
    drop(tx);
    let _ = writer_task.await;
    Ok(())
}

async fn handle(request: Request, state: Arc<State>, writer: Writer) {
    let Request { id, command } = request;

    match command {
        Command::SetRate { bytes_per_second } => {
            state.limiter.set_rate(bytes_per_second);
            let _ = writer.send(Outgoing::Ok {
                id,
                ok: serde_json::Value::Null,
            });
        }
        Command::ReplaceUrl { path, url } => {
            let result = async {
                let file = std::path::PathBuf::from(format!("{path}.kitsune"));
                if !file.exists() {
                    kitsune_core::Downloader::new(USER_AGENT)?
                        .get_remote_metadata(&url)
                        .await?;
                    return Ok(());
                }
                let mut session = kitsune_core::DownloadSession::load(&file).await?;
                kitsune_core::Downloader::new(USER_AGENT)?
                    .validate_resume(&mut session, &url)
                    .await?;
                session.save(&file).await
            }
            .await;
            let message = match result {
                Ok(()) => Outgoing::Ok {
                    id,
                    ok: serde_json::Value::Null,
                },
                Err(e) => Outgoing::Err {
                    id,
                    error: e.to_string(),
                },
            };
            let _ = writer.send(message);
        }
        Command::Ping => {
            let _ = writer.send(Outgoing::Ok {
                id,
                ok: serde_json::json!("pong"),
            });
        }

        Command::GetMetadata { url } => match get_metadata(&url).await {
            Ok(meta) => {
                let _ = writer.send(Outgoing::Ok {
                    id,
                    ok: serde_json::to_value(meta).unwrap_or(serde_json::Value::Null),
                });
            }
            Err(e) => {
                let _ = writer.send(Outgoing::Err {
                    id,
                    error: e.to_string(),
                });
            }
        },

        Command::CancelDownload { download_id } => {
            if let Ok(flags) = state.cancel_flags.lock()
                && let Some(flag) = flags.get(&download_id)
            {
                flag.store(true, Ordering::Relaxed);
            }
            let _ = writer.send(Outgoing::Ok {
                id,
                ok: serde_json::Value::Null,
            });
        }

        Command::StartDownload {
            download_id,
            url,
            path,
            connections,
        } => {
            let cancel_flag =
                Arc::new(AtomicBool::new(state.shutting_down.load(Ordering::Relaxed)));
            {
                let mut flags = state.cancel_flags.lock().unwrap();
                if flags.contains_key(&download_id) {
                    let _ = writer.send(Outgoing::Err {
                        id,
                        error: "Download is already running".into(),
                    });
                    return;
                }
                flags.insert(download_id.clone(), cancel_flag.clone());
            }
            // Acknowledge immediately; the download reports via events.
            let _ = writer.send(Outgoing::Ok {
                id,
                ok: serde_json::Value::Null,
            });
            run_download(
                download_id.clone(),
                url,
                path,
                connections,
                state.clone(),
                writer,
                cancel_flag,
            )
            .await;
            state.cancel_flags.lock().unwrap().remove(&download_id);
        }
    }
}

async fn get_metadata(url: &str) -> anyhow::Result<Metadata> {
    let downloader = kitsune_core::Downloader::new(USER_AGENT)?;
    let (filename, size, _) = downloader.get_remote_metadata(url).await?;
    Ok(Metadata {
        filename,
        size: size.unwrap_or(0),
        url: url.to_string(),
    })
}

async fn run_download(
    download_id: String,
    url: String,
    path: String,
    connections: u8,
    state: Arc<State>,
    writer: Writer,
    cancel_flag: Arc<AtomicBool>,
) {
    let downloader = match kitsune_core::Downloader::new(USER_AGENT) {
        Ok(d) => d.with_limiter(state.limiter.clone()),
        Err(e) => return emit_error(&writer, &download_id, &e.to_string()),
    };

    let output_path = std::path::PathBuf::from(&path);
    // Session file sits next to the output file, matching the Tauri behaviour so
    // in-progress downloads survive the migration.
    let session_file = std::path::PathBuf::from(format!("{path}.kitsune"));

    let mut session = if session_file.exists() {
        match kitsune_core::DownloadSession::load(&session_file).await {
            Ok(s) => s,
            Err(e) => return emit_error(&writer, &download_id, &e.to_string()),
        }
    } else {
        if output_path.exists() {
            return emit_error(
                &writer,
                &download_id,
                "Destination already exists; choose a different filename",
            );
        }
        match downloader
            .init_download(&url, Some(output_path), connections)
            .await
        {
            Ok(s) => s,
            Err(e) => return emit_error(&writer, &download_id, &e.to_string()),
        }
    };

    let observer = Arc::new(StdoutObserver {
        writer: writer.clone(),
        download_id: download_id.clone(),
    });

    let result = downloader
        .run(
            &mut session,
            Some(observer),
            Some(session_file.clone()),
            Some(cancel_flag),
        )
        .await;

    if let Ok(mut flags) = state.cancel_flags.lock() {
        flags.remove(&download_id);
    }

    match result {
        Err(e) if e.to_string() == "cancelled" => {
            let _ = writer.send(Outgoing::Event {
                event: "download-paused",
                body: serde_json::json!({ "downloadId": download_id }),
            });
        }
        Err(e) => emit_error(&writer, &download_id, &e.to_string()),
        Ok(()) => {
            let _ = writer.send(Outgoing::Event {
                event: "download-completed",
                body: serde_json::json!({ "downloadId": download_id, "url": session.url }),
            });
            if session_file.exists() {
                let _ = std::fs::remove_file(&session_file);
            }
        }
    }
}

fn emit_error(writer: &Writer, download_id: &str, error: &str) {
    let _ = writer.send(Outgoing::Event {
        event: "download-error",
        body: serde_json::json!({ "downloadId": download_id, "error": error }),
    });
}
