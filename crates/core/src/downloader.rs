use crate::{
    controls::{Concurrency, RateLimiter},
    session::{DownloadPart, DownloadSession, DownloadState},
    worker::{Worker, WorkerEvent},
};
use anyhow::{Result, bail};
use reqwest::{Client, StatusCode, header};
use std::{
    collections::{HashSet, VecDeque},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    fs::OpenOptions,
    sync::{Mutex, mpsc},
    task::JoinSet,
};

pub trait DownloadObserver: Send + Sync {
    fn on_progress(&self, worker_id: u8, bytes_downloaded: u64, active_workers: usize);
    fn on_started(&self, _downloaded: u64, _total: Option<u64>) {}
}
pub struct ChannelObserver {
    tx: mpsc::Sender<(u8, u64, usize)>,
}
impl ChannelObserver {
    pub fn new(tx: mpsc::Sender<(u8, u64, usize)>) -> Self {
        Self { tx }
    }
}
impl DownloadObserver for ChannelObserver {
    fn on_progress(&self, id: u8, bytes: u64, active: usize) {
        let _ = self.tx.try_send((id, bytes, active));
    }
}
struct Metadata {
    filename: String,
    size: Option<u64>,
    ranged: bool,
    etag: Option<String>,
    last_modified: Option<String>,
}
#[derive(Clone)]
pub struct Downloader {
    client: Client,
    limiter: Arc<RateLimiter>,
}
impl Downloader {
    pub fn new(user_agent: &str) -> Result<Self> {
        Ok(Self {
            client: Client::builder()
                .user_agent(user_agent)
                .connect_timeout(Duration::from_secs(30))
                .read_timeout(Duration::from_secs(30))
                .pool_max_idle_per_host(0)
                .build()?,
            limiter: Arc::new(RateLimiter::default()),
        })
    }
    pub fn with_limiter(mut self, limiter: Arc<RateLimiter>) -> Self {
        self.limiter = limiter;
        self
    }
    async fn metadata(&self, url: &str) -> Result<Metadata> {
        let response = self
            .client
            .get(url)
            .header(header::RANGE, "bytes=0-0")
            .header(header::ACCEPT_ENCODING, "identity")
            .send()
            .await?;
        response.error_for_status_ref()?;
        let headers = response.headers();
        let value = |name| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let ranged = response.status() == StatusCode::PARTIAL_CONTENT;
        let size = if ranged {
            value(header::CONTENT_RANGE).and_then(|v| v.split('/').next_back()?.parse().ok())
        } else {
            value(header::CONTENT_LENGTH).and_then(|v| v.parse().ok())
        };
        let ranged = ranged && size.is_some();
        let filename = value(header::CONTENT_DISPOSITION)
            .and_then(|cd| {
                cd.split(';').find_map(|part| {
                    part.trim()
                        .strip_prefix("filename=")
                        .map(|s| s.trim_matches('"').to_owned())
                })
            })
            .unwrap_or_else(|| {
                url.split('?')
                    .next()
                    .unwrap_or(url)
                    .rsplit('/')
                    .next()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("download.bin")
                    .to_owned()
            });
        let filename = filename
            .rsplit(['/', '\\'])
            .next()
            .filter(|s| !s.is_empty() && *s != "." && *s != "..")
            .unwrap_or("download.bin")
            .to_owned();
        Ok(Metadata {
            filename,
            size,
            ranged,
            etag: value(header::ETAG).filter(|s| !s.starts_with("W/")),
            last_modified: value(header::LAST_MODIFIED),
        })
    }
    pub async fn get_remote_metadata(&self, url: &str) -> Result<(String, Option<u64>, bool)> {
        let meta = self.metadata(url).await?;
        Ok((meta.filename, meta.size, meta.ranged))
    }
    pub async fn init_download(
        &self,
        url: &str,
        output_path: Option<PathBuf>,
        connections: u8,
    ) -> Result<DownloadSession> {
        let meta = self.metadata(url).await?;
        let mut session = DownloadSession::new(
            url.to_owned(),
            output_path
                .unwrap_or_else(|| crate::utils::fs::get_downloads_dir().join(meta.filename)),
            connections.clamp(1, 32),
        );
        session.total_size = meta.size;
        session.accepts_ranges = meta.ranged;
        session.etag = meta.etag;
        session.last_modified = meta.last_modified;
        if meta.ranged
            && let Some(size) = meta.size
        {
            let block_size =
                (size / (session.connections as u64 * 2)).clamp(1024 * 1024, 8 * 1024 * 1024);
            let mut start = 0;
            while start < size {
                let end = (start + block_size).min(size) - 1;
                session.parts.push(DownloadPart {
                    id: (session.parts.len() % 256) as u8,
                    start_byte: start,
                    end_byte: end,
                    current_byte: start,
                    completed: false,
                });
                start = end + 1;
            }
        } else if meta.size != Some(0) {
            session.parts.push(DownloadPart {
                id: 0,
                start_byte: 0,
                end_byte: meta.size.map(|n| n - 1).unwrap_or(u64::MAX),
                current_byte: 0,
                completed: false,
            });
            session.connections = 1;
        }
        Ok(session)
    }
    /// A replacement URL is committed only after proving that it is the same file.
    pub async fn validate_resume(&self, session: &mut DownloadSession, url: &str) -> Result<()> {
        let meta = self.metadata(url).await?;
        let progress = session.parts.iter().any(|p| p.current_byte > p.start_byte);
        if progress {
            if !session.output_path.exists() {
                bail!("Partial file is missing; start a new download");
            }
            let length = tokio::fs::metadata(&session.output_path).await?.len();
            if session
                .parts
                .iter()
                .any(|p| p.current_byte > p.start_byte && p.current_byte > length)
            {
                bail!("Partial file was truncated; start a new download");
            }
            if !meta.ranged {
                bail!("Server does not support safe resume; start a new download");
            }
            if session.total_size != meta.size {
                bail!("File size changed; refusing to resume a different file");
            }
            let matches = if let Some(etag) = &session.etag {
                meta.etag.as_ref() == Some(etag)
            } else if let Some(date) = &session.last_modified {
                meta.last_modified.as_ref() == Some(date)
            } else {
                false
            };
            if !matches {
                bail!("File version changed or cannot be verified; start a new download");
            }
        } else if session.total_size != meta.size {
            bail!("File size changed; start a new download");
        }
        if !meta.ranged && session.parts.len() > 1 {
            bail!("Server no longer supports parallel ranges; start a new download");
        }
        session.url = url.to_owned();
        session.etag = meta.etag;
        session.last_modified = meta.last_modified;
        session.accepts_ranges = meta.ranged;
        Ok(())
    }
    pub async fn run(
        &self,
        session: &mut DownloadSession,
        observer: Option<Arc<dyn DownloadObserver>>,
        session_file: Option<PathBuf>,
        cancel_flag: Option<Arc<AtomicBool>>,
    ) -> Result<()> {
        self.validate_resume(session, &session.url.clone()).await?;
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&session.output_path)
            .await?;
        if let Some(size) = session.total_size {
            file.set_len(size).await?;
        }
        session.state = DownloadState::Downloading;
        if let Some(obs) = &observer {
            obs.on_started(
                session
                    .parts
                    .iter()
                    .map(|p| p.current_byte - p.start_byte)
                    .sum(),
                session.total_size,
            );
        }
        let (tx, mut rx) = mpsc::channel(128);
        let concurrency = Arc::new(Mutex::new(Concurrency::new(session.connections as usize)));
        let mut tasks = JoinSet::new();
        let mut active = HashSet::new();
        for part in &mut session.parts {
            if session.accepts_ranges && part.current_byte > part.end_byte {
                part.completed = true;
            }
        }
        let mut pending: VecDeque<usize> = session
            .parts
            .iter()
            .enumerate()
            .filter(|(_, p)| !p.completed)
            .map(|(i, _)| i)
            .collect();
        let mut remaining = pending.len();
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        let mut last_save = tokio::time::Instant::now();
        let mut last_report = tokio::time::Instant::now();
        let mut pending_bytes = 0;
        let mut result = Ok(());
        loop {
            if cancel_flag
                .as_ref()
                .is_some_and(|f| f.load(Ordering::Relaxed))
            {
                result = Err(anyhow::anyhow!("cancelled"));
                break;
            }
            if remaining == 0 {
                break;
            }
            let ceiling = {
                let mut c = concurrency.lock().await;
                c.recover();
                c.ceiling
            };
            while active.len() < ceiling {
                let Some(index) = pending.pop_front() else {
                    break;
                };
                let part = &session.parts[index];
                active.insert(index);
                let worker = Worker {
                    index,
                    url: session.url.clone(),
                    range: (part.current_byte, part.end_byte),
                    ranged: session.accepts_ranges,
                    validator: session
                        .etag
                        .clone()
                        .or_else(|| session.last_modified.clone()),
                    output_path: session.output_path.clone(),
                    client: self.client.clone(),
                    tx: tx.clone(),
                    concurrency: concurrency.clone(),
                    limiter: self.limiter.clone(),
                };
                tasks.spawn(worker.run());
            }
            tokio::select! {
                _ = tick.tick() => {},
                event = rx.recv() => match event {
                    Some(WorkerEvent::Progress(index, bytes)) => {
                        session.parts[index].current_byte += bytes;
                        pending_bytes += bytes;
                    },
                    Some(WorkerEvent::Finished(index, outcome)) => {
                        active.remove(&index);
                        match outcome { Ok(()) => { session.parts[index].completed = true; remaining -= 1; }, Err(e) => { result = Err(e); break; } }
                    },
                    None => { result = Err(anyhow::anyhow!("Transfer workers stopped unexpectedly")); break; }
                }
            }
            if last_report.elapsed() >= Duration::from_millis(100) {
                if let Some(obs) = &observer {
                    obs.on_progress(0, pending_bytes, active.len());
                }
                pending_bytes = 0;
                last_report = tokio::time::Instant::now();
            }
            while let Some(joined) = tasks.try_join_next() {
                if let Err(e) = joined {
                    result = Err(e.into());
                    break;
                }
            }
            if result.is_err() {
                break;
            }
            if last_save.elapsed() >= Duration::from_secs(1) {
                if let Err(e) = file.sync_data().await {
                    result = Err(e.into());
                    break;
                }
                if let Some(path) = &session_file
                    && let Err(e) = session.save(path).await
                {
                    result = Err(e);
                    break;
                }
                last_save = tokio::time::Instant::now();
            }
        }
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        while let Ok(event) = rx.try_recv() {
            if let WorkerEvent::Progress(index, bytes) = event {
                session.parts[index].current_byte += bytes;
                pending_bytes += bytes;
            }
        }
        if let Some(obs) = &observer {
            obs.on_progress(0, pending_bytes, 0);
        }
        file.sync_data().await?;
        session.state = match &result {
            Ok(()) => DownloadState::Completed,
            Err(e) if e.to_string() == "cancelled" => DownloadState::Paused,
            Err(e) => DownloadState::Error(e.to_string()),
        };
        if let Some(path) = &session_file {
            session.save(path).await?;
        }
        result
    }
}
