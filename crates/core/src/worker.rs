use crate::controls::{Concurrency, RateLimiter};
use anyhow::{Result, bail};
use reqwest::{Client, StatusCode, header};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    fs::OpenOptions,
    io::{AsyncSeekExt, AsyncWriteExt, SeekFrom},
    sync::{Mutex, mpsc},
};

pub enum WorkerEvent {
    Progress(usize, u64),
    Finished(usize, Result<()>),
}

pub struct Worker {
    pub index: usize,
    pub url: String,
    pub range: (u64, u64),
    pub ranged: bool,
    pub validator: Option<String>,
    pub output_path: PathBuf,
    pub client: Client,
    pub tx: mpsc::Sender<WorkerEvent>,
    pub concurrency: Arc<Mutex<Concurrency>>,
    pub limiter: Arc<RateLimiter>,
}

impl Worker {
    pub async fn run(self) {
        let result = self.transfer().await;
        let _ = self
            .tx
            .send(WorkerEvent::Finished(self.index, result))
            .await;
    }

    async fn transfer(&self) -> Result<()> {
        let mut position = self.range.0;
        let mut retries = 0;
        loop {
            let permit = loop {
                if let Some(permit) = self.concurrency.lock().await.acquire() {
                    break permit;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            };
            let mut request = self
                .client
                .get(&self.url)
                .header(header::ACCEPT_ENCODING, "identity");
            if self.ranged {
                request =
                    request.header(header::RANGE, format!("bytes={position}-{}", self.range.1));
                if let Some(validator) = &self.validator {
                    request = request.header(header::IF_RANGE, validator);
                }
            }
            let mut delay = Duration::from_secs(1 << retries.min(5));
            match request.send().await {
                Ok(mut response) => {
                    let status = response.status();
                    if matches!(
                        status,
                        StatusCode::FORBIDDEN
                            | StatusCode::TOO_MANY_REQUESTS
                            | StatusCode::SERVICE_UNAVAILABLE
                    ) {
                        self.concurrency.lock().await.refused();
                        if let Some(seconds) = response
                            .headers()
                            .get(header::RETRY_AFTER)
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.parse::<u64>().ok())
                        {
                            delay = Duration::from_secs(seconds.min(300)).max(delay);
                        }
                    } else {
                        response.error_for_status_ref()?;
                        if self.ranged {
                            let expected = format!("bytes {position}-{}", self.range.1);
                            let actual = response
                                .headers()
                                .get(header::CONTENT_RANGE)
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("");
                            if status != StatusCode::PARTIAL_CONTENT
                                || actual.split('/').next() != Some(expected.as_str())
                            {
                                bail!(
                                    "Server changed the file or ignored the byte range; refusing to mix file versions"
                                );
                            }
                            if let Some(validator) = &self.validator {
                                let key = if validator.starts_with('"') {
                                    header::ETAG
                                } else {
                                    header::LAST_MODIFIED
                                };
                                if let Some(actual) =
                                    response.headers().get(key).and_then(|v| v.to_str().ok())
                                    && actual != validator
                                {
                                    bail!("File version changed during transfer");
                                }
                            }
                        }
                        let mut file = OpenOptions::new()
                            .write(true)
                            .open(&self.output_path)
                            .await?;
                        file.seek(SeekFrom::Start(position)).await?;
                        let mut interrupted = false;
                        loop {
                            match response.chunk().await {
                                Ok(Some(chunk)) => {
                                    for bytes in chunk.chunks(16 * 1024) {
                                        if self.ranged
                                            && bytes.len() as u64 > self.range.1 + 1 - position
                                        {
                                            bail!("Server sent more bytes than requested");
                                        }
                                        self.limiter.acquire(bytes.len()).await;
                                        file.write_all(bytes).await?;
                                        position += bytes.len() as u64;
                                        self.tx
                                            .send(WorkerEvent::Progress(
                                                self.index,
                                                bytes.len() as u64,
                                            ))
                                            .await?;
                                    }
                                }
                                Ok(None) => break,
                                Err(_) => {
                                    interrupted = true;
                                    break;
                                }
                            }
                        }
                        file.sync_data().await?;
                        if !interrupted && (!self.ranged || position == self.range.1 + 1) {
                            self.concurrency.lock().await.successful();
                            return Ok(());
                        }
                        if self.ranged && position == self.range.1 + 1 {
                            return Ok(());
                        }
                        if !self.ranged {
                            bail!("Stream interrupted; this server does not support safe resume");
                        }
                    }
                }
                Err(_) => self.concurrency.lock().await.refused(),
            }
            drop(permit);
            retries += 1;
            if retries >= 8 {
                bail!(
                    "Transfer refused or interrupted after eight retries; the link may have expired"
                );
            }
            tokio::time::sleep(delay).await;
        }
    }
}
