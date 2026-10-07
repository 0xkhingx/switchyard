use sqlx::PgPool;

/// Shared server state.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// Set Secure on session cookies (true in production).
    pub secure_cookies: bool,
}
