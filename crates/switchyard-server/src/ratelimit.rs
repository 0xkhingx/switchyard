//! Login throttling: sliding-window counter of failed attempts, keyed by
//! client IP and by email.
//!
//! LIMITATION: state is in-memory and per process. It resets on restart and is
//! not shared between replicas, so behind N instances an attacker gets up to
//! N times the budget. That is acceptable for a single-instance deployment; a
//! multi-instance deployment should move this into Postgres or Redis (or rate
//! limit at the proxy).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Failed attempts allowed per key inside one window.
pub const MAX_FAILURES: usize = 10;
/// Sliding window length.
pub const WINDOW: Duration = Duration::from_secs(15 * 60);

pub struct LoginLimiter {
    max: usize,
    window: Duration,
    failures: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl Default for LoginLimiter {
    fn default() -> Self {
        Self::new(MAX_FAILURES, WINDOW)
    }
}

impl LoginLimiter {
    pub fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            failures: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, VecDeque<Instant>>> {
        // A poisoned lock only means another request panicked mid-update; the
        // map is still usable, so keep throttling rather than failing open.
        self.failures.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// `Err(retry_after_secs)` if any key is over budget, else `Ok(())`.
    pub fn check(&self, keys: &[&str]) -> Result<(), u64> {
        let now = Instant::now();
        let mut map = self.lock();
        let mut retry = 0u64;
        for key in keys {
            if let Some(q) = map.get_mut(*key) {
                while q
                    .front()
                    .is_some_and(|t| now.duration_since(*t) >= self.window)
                {
                    q.pop_front();
                }
                if q.len() >= self.max {
                    // The oldest failure in the window expires first.
                    let oldest = *q.front().expect("non-empty");
                    let wait = self.window.saturating_sub(now.duration_since(oldest));
                    retry = retry.max(wait.as_secs().max(1));
                }
            }
        }
        if retry > 0 {
            Err(retry)
        } else {
            Ok(())
        }
    }

    /// Record one failed attempt against every key.
    pub fn record_failure(&self, keys: &[&str]) {
        let now = Instant::now();
        let mut map = self.lock();
        for key in keys {
            let q = map.entry((*key).to_string()).or_default();
            q.push_back(now);
            // Bound memory per key even under a flood.
            while q.len() > self.max {
                q.pop_front();
            }
        }
    }

    /// Forget a key (e.g. the email after a successful login).
    pub fn clear(&self, key: &str) {
        self.lock().remove(key);
    }

    /// Drop keys whose failures have all aged out. Called periodically.
    pub fn prune(&self) {
        let now = Instant::now();
        let window = self.window;
        self.lock()
            .retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < window));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_after_budget_and_reports_retry_after() {
        let l = LoginLimiter::new(3, Duration::from_secs(60));
        let keys = ["ip:1.2.3.4", "email:a@x.com"];
        for _ in 0..3 {
            assert!(l.check(&keys).is_ok());
            l.record_failure(&keys);
        }
        let retry = l.check(&keys).unwrap_err();
        assert!((1..=60).contains(&retry));
        // A different email from a different IP is unaffected.
        assert!(l.check(&["ip:5.6.7.8", "email:b@x.com"]).is_ok());
        // Same email from another IP is still blocked (per-email limit).
        assert!(l.check(&["ip:5.6.7.8", "email:a@x.com"]).is_err());
        l.clear("email:a@x.com");
        assert!(l.check(&["ip:5.6.7.8", "email:a@x.com"]).is_ok());
    }

    #[test]
    fn window_expiry_and_prune() {
        let l = LoginLimiter::new(1, Duration::from_millis(20));
        l.record_failure(&["k"]);
        assert!(l.check(&["k"]).is_err());
        std::thread::sleep(Duration::from_millis(30));
        assert!(l.check(&["k"]).is_ok());
        l.prune();
        assert!(l.lock().is_empty());
    }
}
