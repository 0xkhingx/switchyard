use sqlx::PgPool;

/// Shared server state.
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// Dashboard origin allowed for credentialed CORS (e.g. http://localhost:3000).
    /// Kept on state for handlers/future middleware; CORS itself is built in main.
    #[allow(dead_code)]
    pub dashboard_origin: String,
    /// Set Secure on session cookies (true in production).
    pub secure_cookies: bool,
}
