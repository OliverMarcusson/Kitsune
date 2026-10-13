use kitsune_core::{
    DownloadObserver, DownloadSession, Downloader,
    controls::{Concurrency, RateLimiter},
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct Fixture {
    url: String,
    version: Arc<AtomicUsize>,
    ignored: Arc<AtomicBool>,
    truncated: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server(data: Vec<u8>) -> Fixture {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/file.bin", listener.local_addr().unwrap());
    let data = Arc::new(data);
    let version = Arc::new(AtomicUsize::new(1));
    let ignored = Arc::new(AtomicBool::new(false));
    let truncated = Arc::new(AtomicBool::new(false));
    let (v, ignore, truncate) = (version.clone(), ignored.clone(), truncated.clone());
    let task = tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let (data, v, ignore, truncate) =
                (data.clone(), v.clone(), ignore.clone(), truncate.clone());
            tokio::spawn(async move {
                let mut input = vec![0; 8192];
                let count = stream.read(&mut input).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&input[..count]).to_lowercase();
                if data.is_empty() {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nETag: \"v1\"\r\nConnection: close\r\n\r\n").await;
                    return;
                }
                let range = request
                    .lines()
                    .find_map(|line| line.strip_prefix("range: bytes="));
                let (start, end) = range
                    .and_then(|value| value.split_once('-'))
                    .map(|(a, b)| (a.parse::<usize>().unwrap(), b.parse::<usize>().unwrap()))
                    .unwrap_or((0, data.len() - 1));
                let (start, end, status) = if ignore.load(Ordering::Relaxed) {
                    (0, data.len() - 1, "200 OK")
                } else {
                    (start, end, "206 Partial Content")
                };
                let body = &data[start..=end];
                let headers = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nETag: \"v{}\"\r\nConnection: close\r\n\r\n",
                    body.len(),
                    data.len(),
                    v.load(Ordering::Relaxed)
                );
                if stream.write_all(headers.as_bytes()).await.is_err() {
                    return;
                }
                let length = if truncate.load(Ordering::Relaxed) && body.len() > 1 {
                    body.len() / 2
                } else {
                    body.len()
                };
                let _ = stream.write_all(&body[..length]).await;
            });
        }
    });
    Fixture {
        url,
        version,
        ignored,
        truncated,
        task,
    }
}

fn output(label: &str) -> std::path::PathBuf {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    std::env::temp_dir().join(format!(
        "kitsune-test-{}-{label}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ))
}

#[tokio::test]
async fn empty_and_non_range_files_download_without_invalid_offsets() {
    let downloader = Downloader::new("test").unwrap();
    for data in [vec![], vec![5; 17]] {
        let fixture = server(data.clone()).await;
        fixture.ignored.store(true, Ordering::Relaxed);
        let path = output("single");
        let mut session = downloader
            .init_download(&fixture.url, Some(path.clone()), 16)
            .await
            .unwrap();
        downloader
            .run(&mut session, None, None, None)
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(&path).await.unwrap(), data);
        tokio::fs::remove_file(path).await.unwrap();
    }
}

#[tokio::test]
async fn ranged_download_matches_source_and_saves_complete_session() {
    let data: Vec<u8> = (0..3 * 1024 * 1024 + 17).map(|n| (n % 251) as u8).collect();
    let fixture = server(data.clone()).await;
    let downloader = Downloader::new("test").unwrap();
    let path = output("complete");
    let checkpoint = path.with_extension("kitsune");
    let mut session = downloader
        .init_download(&fixture.url, Some(path.clone()), 8)
        .await
        .unwrap();
    assert!(session.parts.len() > 1);
    downloader
        .run(&mut session, None, Some(checkpoint.clone()), None)
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), data);
    assert!(
        DownloadSession::load(&checkpoint)
            .await
            .unwrap()
            .parts
            .iter()
            .all(|p| p.completed)
    );
    tokio::fs::remove_file(path).await.unwrap();
    tokio::fs::remove_file(checkpoint).await.unwrap();
}

#[tokio::test]
async fn changed_version_and_legacy_checkpoint_are_rejected_without_writing() {
    let fixture = server(vec![7; 1024]).await;
    let downloader = Downloader::new("test").unwrap();
    let path = output("version");
    tokio::fs::write(&path, vec![7; 1024]).await.unwrap();
    let mut session = downloader
        .init_download(&fixture.url, Some(path.clone()), 8)
        .await
        .unwrap();
    session.parts[0].current_byte = 128;
    fixture.version.store(2, Ordering::Relaxed);
    let previous = session.url.clone();
    assert!(
        downloader
            .validate_resume(&mut session, &(fixture.url.clone() + "?fresh"))
            .await
            .is_err()
    );
    assert_eq!(session.url, previous);
    assert_eq!(tokio::fs::read(&path).await.unwrap(), vec![7; 1024]);
    fixture.version.store(1, Ordering::Relaxed);
    session.etag = None;
    assert!(
        downloader
            .validate_resume(&mut session, &fixture.url)
            .await
            .is_err()
    );
    tokio::fs::remove_file(path).await.unwrap();
}

#[tokio::test]
async fn fresh_url_preserves_offsets_and_resumes_same_file() {
    let fixture = server(vec![31; 2048]).await;
    let downloader = Downloader::new("test").unwrap();
    let path = output("repair");
    tokio::fs::write(&path, vec![31; 512]).await.unwrap();
    let mut session = downloader
        .init_download(&fixture.url, Some(path.clone()), 4)
        .await
        .unwrap();
    session.parts[0].current_byte = 512;
    let fresh = format!("{}?fresh", fixture.url);
    downloader
        .validate_resume(&mut session, &fresh)
        .await
        .unwrap();
    assert_eq!(session.parts[0].current_byte, 512);
    assert_eq!(session.url, fresh);
    downloader
        .run(&mut session, None, None, None)
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), vec![31; 2048]);
    tokio::fs::remove_file(path).await.unwrap();
}

#[tokio::test]
async fn ignored_range_is_not_written_into_a_partial_file() {
    let fixture = server(vec![9; 2048]).await;
    let downloader = Downloader::new("test").unwrap();
    let path = output("ignored");
    tokio::fs::write(&path, vec![9; 512]).await.unwrap();
    let mut session = downloader
        .init_download(&fixture.url, Some(path.clone()), 4)
        .await
        .unwrap();
    session.parts[0].current_byte = 512;
    fixture.ignored.store(true, Ordering::Relaxed);
    assert!(
        downloader
            .run(&mut session, None, None, None)
            .await
            .is_err()
    );
    assert_eq!(tokio::fs::read(&path).await.unwrap().len(), 512);
    tokio::fs::remove_file(path).await.unwrap();
}

#[tokio::test]
async fn truncated_response_is_not_reported_as_complete() {
    let fixture = server(vec![19; 4096]).await;
    let downloader = Downloader::new("test").unwrap();
    let path = output("truncated");
    let mut session = downloader
        .init_download(&fixture.url, Some(path.clone()), 1)
        .await
        .unwrap();
    fixture.truncated.store(true, Ordering::Relaxed);
    let result = tokio::time::timeout(
        Duration::from_millis(200),
        downloader.run(&mut session, None, None, None),
    )
    .await;
    assert!(
        result.is_err(),
        "A truncated response must retry instead of completing"
    );
    assert!(!session.parts[0].completed);
    tokio::fs::remove_file(path).await.unwrap();
}

struct CancelAfterProgress(Arc<AtomicBool>);
impl DownloadObserver for CancelAfterProgress {
    fn on_progress(&self, _: u8, bytes: u64, _: usize) {
        if bytes > 0 {
            self.0.store(true, Ordering::Relaxed);
        }
    }
}

#[tokio::test]
async fn pause_stops_writers_saves_offsets_and_resumes() {
    let data = vec![43; 1024 * 1024];
    let fixture = server(data.clone()).await;
    let limiter = Arc::new(RateLimiter::default());
    limiter.set_rate(128 * 1024);
    let downloader = Downloader::new("test")
        .unwrap()
        .with_limiter(limiter.clone());
    let path = output("pause");
    let checkpoint = path.with_extension("kitsune");
    let mut session = downloader
        .init_download(&fixture.url, Some(path.clone()), 1)
        .await
        .unwrap();
    let flag = Arc::new(AtomicBool::new(false));
    let result = downloader
        .run(
            &mut session,
            Some(Arc::new(CancelAfterProgress(flag.clone()))),
            Some(checkpoint.clone()),
            Some(flag),
        )
        .await;
    assert_eq!(result.unwrap_err().to_string(), "cancelled");
    let saved = DownloadSession::load(&checkpoint).await.unwrap();
    assert!(saved.parts[0].current_byte > 0 && saved.parts[0].current_byte < data.len() as u64);
    let paused = tokio::fs::read(&path).await.unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(paused, tokio::fs::read(&path).await.unwrap());
    limiter.set_rate(0);
    downloader
        .run(&mut session, None, None, None)
        .await
        .unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), data);
    tokio::fs::remove_file(path).await.unwrap();
    tokio::fs::remove_file(checkpoint).await.unwrap();
}

#[tokio::test]
async fn limiter_is_shared_and_updates_while_waiting() {
    let limiter = Arc::new(RateLimiter::default());
    limiter.set_rate(100);
    limiter.acquire(100).await;
    let waiting = tokio::spawn({
        let limiter = limiter.clone();
        async move { limiter.acquire(100).await }
    });
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(!waiting.is_finished());
    limiter.set_rate(0);
    tokio::time::timeout(Duration::from_millis(200), waiting)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn refused_connections_wait_for_the_lower_ceiling() {
    let mut concurrency = Concurrency::new(8);
    let a = concurrency.acquire().unwrap();
    let b = concurrency.acquire().unwrap();
    concurrency.refused();
    concurrency.refused();
    assert_eq!(concurrency.ceiling, 2);
    assert!(concurrency.acquire().is_none());
    drop(a);
    assert!(concurrency.acquire().is_some());
    drop(b);
    concurrency.successful();
    assert_eq!(concurrency.ceiling, 2);
}
