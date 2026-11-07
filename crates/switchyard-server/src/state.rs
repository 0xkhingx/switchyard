use sqlx::PgPool;
use std::sync::Arc;

use crate::ratelimit::LoginLimiter;

/// Shared server state.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// Set Secure on session cookies (true in production).
    pub secure_cookies: bool,
    /// Per-IP and per-email login throttle (in-memory, per process).
    pub login_limiter: Arc<LoginLimiter>,
}
