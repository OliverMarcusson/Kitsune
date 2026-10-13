use std::sync::{
    Arc,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::Instant;

/// Shared across HTTP transfers; small reservations allow live limit changes.
#[derive(Default)]
pub struct RateLimiter {
    rate: AtomicU64,
    next: Mutex<Option<Instant>>,
}

impl RateLimiter {
    pub fn set_rate(&self, bytes_per_second: u64) {
        self.rate.store(bytes_per_second, Ordering::Relaxed);
    }

    pub async fn acquire(&self, bytes: usize) {
        loop {
            let rate = self.rate.load(Ordering::Relaxed);
            if rate == 0 {
                return;
            }
            let wait = {
                let mut next = self.next.lock().await;
                let now = Instant::now();
                let deadline = next.unwrap_or(now);
                if deadline <= now {
                    *next = Some(now + Duration::from_secs_f64(bytes as f64 / rate as f64));
                    return;
                }
                deadline.duration_since(now).min(Duration::from_millis(100))
            };
            tokio::time::sleep(wait).await;
        }
    }
}

pub struct Concurrency {
    pub ceiling: usize,
    max: usize,
    last_change: Instant,
    refused: bool,
    active: Arc<AtomicUsize>,
}

pub struct Permit(Arc<AtomicUsize>);
impl Drop for Permit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

impl Concurrency {
    pub fn new(max: usize) -> Self {
        Self {
            ceiling: max.min(8),
            max,
            last_change: Instant::now(),
            refused: false,
            active: Arc::new(AtomicUsize::new(0)),
        }
    }
    pub fn acquire(&self) -> Option<Permit> {
        if self.active.load(Ordering::Relaxed) >= self.ceiling {
            return None;
        }
        self.active.fetch_add(1, Ordering::Relaxed);
        Some(Permit(self.active.clone()))
    }
    pub fn refused(&mut self) {
        self.ceiling = (self.ceiling / 2).max(1);
        self.last_change = Instant::now();
        self.refused = true;
    }
    pub fn recover(&mut self) {
        if self.last_change.elapsed() >= Duration::from_secs(60) {
            self.ceiling = (self.ceiling + 1).min(self.max);
            self.last_change = Instant::now();
        }
    }
    pub fn successful(&mut self) {
        if !self.refused {
            self.ceiling = (self.ceiling + 1).min(self.max);
        }
    }
}
