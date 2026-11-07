mod auth;
mod error;
mod handlers;
mod ratelimit;
mod rbac;
mod state;

use axum::{
    http::{header, HeaderValue, Method},
    routing::{delete, get, patch, post},
    Router,
};
use sqlx::postgres::PgPoolOptions;
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tower_http::{
    cors::{AllowHeaders, AllowOrigin, CorsLayer, ExposeHeaders},
    trace::TraceLayer,
};
use uuid::Uuid;

use state::AppState;

/// Dashboard API (credentialed CORS for the one dashboard origin) plus the
/// public SDK endpoint (its own open, credential-less CORS policy).
fn router(state: AppState, dashboard_origin: &str) -> Router {
    let authed = Router::new()
        .route("/api/auth/logout", post(handlers::logout))
        .route("/api/me", get(handlers::me))
        .route(
            "/api/projects",
            get(handlers::list_projects).post(handlers::create_project),
        )
        .route(
            "/api/projects/:p/environments",
            get(handlers::list_environments).post(handlers::create_environment),
        )
        .route(
            "/api/projects/:p/flags",
            get(handlers::list_flags).post(handlers::create_flag),
        )
        .route("/api/projects/:p/flags/:key", patch(handlers::patch_flag))
        .route(
            "/api/projects/:p/environments/:e/flags/:key",
            get(handlers::get_flag_config).put(handlers::put_flag_config),
        )
        .route("/api/evaluate", post(handlers::post_evaluate))
        .route(
            "/api/projects/:p/environments/:e/sdk-keys",
            get(handlers::list_sdk_keys).post(handlers::create_sdk_key),
        )
        .route(
            "/api/projects/:p/environments/:e/sdk-keys/:id",
            delete(handlers::delete_sdk_key),
        )
        .route(
            "/api/projects/:p/members",
            get(handlers::list_members).post(handlers::add_member),
        )
        .route("/api/projects/:p/audit", get(handlers::list_audit));
    // Note: /api/auth/login is intentionally outside the session guard.
    let dashboard = Router::new()
        .route("/api/auth/login", post(handlers::login))
        .merge(authed)
        .layer(dashboard_cors(dashboard_origin));
    let sdk = Router::new()
        .route("/sdk/v1/config", get(handlers::sdk_config))
        .layer(sdk_cors());
    dashboard.merge(sdk).with_state(state)
}

/// Credentialed CORS for the dashboard origin. Exposes X-Total-Count (audit
/// pagination) and ETag so browser code can read them.
fn dashboard_cors(origin: &str) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(
            origin
                .parse::<HeaderValue>()
                .expect("DASHBOARD_ORIGIN must be a valid origin"),
        )
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_headers(AllowHeaders::list(vec![
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::IF_NONE_MATCH,
        ]))
        .expose_headers(ExposeHeaders::list(vec![
            header::HeaderName::from_static("x-total-count"),
            header::ETAG,
            // Login throttling: the dashboard reads it to say when to retry.
            header::RETRY_AFTER,
        ]))
        .allow_credentials(true)
}

/// SDK CORS: browser SDKs run on any customer origin and authenticate with a
/// Bearer key, never cookies, so any origin is allowed without credentials.
fn sdk_cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::any())
        .allow_methods([Method::GET])
        .allow_headers(AllowHeaders::list(vec![
            header::AUTHORIZATION,
            header::IF_NONE_MATCH,
        ]))
        .expose_headers(ExposeHeaders::list(vec![header::ETAG]))
        .allow_credentials(false)
}

/// Secure session cookies: explicit COOKIE_SECURE (1/true/0/false) wins;
/// otherwise on whenever the dashboard is served over https.
fn cookie_secure(dashboard_origin: &str, cookie_secure_env: Option<&str>) -> bool {
    match cookie_secure_env.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if v == "1" || v == "true" => true,
        Some(v) if v == "0" || v == "false" => false,
        _ => dashboard_origin
            .trim()
            .to_ascii_lowercase()
            .starts_with("https://"),
    }
}

/// Resolves on Ctrl-C, or SIGTERM on unix (what Docker/k8s send).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
    println!("shutting down: draining in-flight requests");
}

/// Hourly housekeeping: purge expired sessions and stale throttle entries.
fn spawn_cleanup(state: AppState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            match sqlx::query("DELETE FROM sessions WHERE expires_at <= now()")
                .execute(&state.pool)
                .await
            {
                Ok(r) => tracing::debug!(purged = r.rows_affected(), "expired sessions purged"),
                Err(e) => tracing::warn!(error = %e, "session purge failed"),
            }
            state.login_limiter.prune();
        }
    });
}

async fn pool() -> Result<sqlx::PgPool, String> {
    let url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is not set".to_string())?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&url)
        .await
        .map_err(|e| format!("cannot connect to Postgres: {e}"))?;
    sqlx::migrate!()
        .run(&pool)
        .await
        .map_err(|e| format!("migration failed: {e}"))?;
    Ok(pool)
}

async fn create_user(args: &[String]) -> Result<(), String> {
    // Usage: switchyard-server create-user --email E --password P [--admin] [--project-key K --project-name N]
    let get = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let email = get("--email").ok_or("--email is required")?.to_lowercase();
    let password = get("--password").ok_or("--password is required")?;
    if password.len() < 8 {
        return Err("password must be at least 8 characters".into());
    }
    let admin = args.iter().any(|a| a == "--admin");
    let pool = pool().await?;
    let existing: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&pool)
        .await
        .map_err(|e| e.to_string())?;
    if existing.is_some() {
        return Err("user already exists".into());
    }
    let id = Uuid::new_v4();
    let hash = auth::hash_password(&password).map_err(|e| format!("{e:?}"))?;
    sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(&email)
        .bind(&hash)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    // Bootstrap convenience: make the user admin of a project (created if needed)
    // so the first login has somewhere to go.
    let project_key = get("--project-key").unwrap_or_else(|| "default".to_string());
    let project_name = get("--project-name").unwrap_or_else(|| "Default".to_string());
    let proj: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM projects WHERE key = $1")
        .bind(&project_key)
        .fetch_optional(&pool)
        .await
        .map_err(|e| e.to_string())?;
    let project_id = match proj {
        Some((pid,)) => pid,
        None => {
            let pid = Uuid::new_v4();
            sqlx::query("INSERT INTO projects (id, key, name) VALUES ($1, $2, $3)")
                .bind(pid)
                .bind(&project_key)
                .bind(&project_name)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())?;
            pid
        }
    };
    let role = if admin { "admin" } else { "viewer" };
    sqlx::query(
        "INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(project_id)
    .bind(id)
    .bind(role)
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;
    println!("created user {email} with role {role} on project {project_key}");
    Ok(())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("create-user") {
        match create_user(&args).await {
            Ok(()) => {}
            Err(e) => {
                eprintln!("create-user failed: {e}");
                std::process::exit(1);
            }
        }
        return;
    }
    let pool = match pool().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("startup failed: {e}");
            std::process::exit(1);
        }
    };
    let origin =
        std::env::var("DASHBOARD_ORIGIN").unwrap_or_else(|_| "http://localhost:3000".to_string());
    let secure = cookie_secure(&origin, std::env::var("COOKIE_SECURE").ok().as_deref());
    // Warm the dummy hash so the first unknown-email login is not faster.
    let _ = auth::dummy_hash();
    let state = AppState {
        pool,
        secure_cookies: secure,
        login_limiter: Arc::new(ratelimit::LoginLimiter::default()),
    };
    spawn_cleanup(state.clone());
    let app = router(state, &origin).layer(TraceLayer::new_for_http());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("switchyard-server listening on {addr} (secure cookies: {secure})");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .expect("serve");
}

// ---------------------------------------------------------------------------
// Integration test: full flow against a live Postgres.
// Runs only when DATABASE_URL is set; otherwise it reports SKIP and passes,
// so `cargo test` stays green on machines without a database.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::cookie_secure;

    #[test]
    fn cookie_secure_defaults_from_origin_with_override() {
        assert!(!cookie_secure("http://localhost:3000", None));
        assert!(cookie_secure("https://flags.example.com", None));
        assert!(cookie_secure("HTTPS://flags.example.com", None));
        assert!(!cookie_secure("https://flags.example.com", Some("false")));
        assert!(!cookie_secure("https://flags.example.com", Some("0")));
        assert!(cookie_secure("http://localhost:3000", Some("1")));
        assert!(cookie_secure("http://localhost:3000", Some("true")));
        // Unrecognised values fall back to the origin-based default.
        assert!(cookie_secure("https://x.example", Some("maybe")));
    }
}

#[cfg(test)]
mod db_tests {
    use uuid::Uuid;

    async fn live_pool() -> Option<sqlx::PgPool> {
        let url = std::env::var("DATABASE_URL").ok()?;
        let pool = sqlx::PgPool::connect(&url).await.ok()?;
        sqlx::migrate!().run(&pool).await.ok()?;
        Some(pool)
    }

    #[tokio::test]
    async fn full_flow() {
        let Some(pool) = live_pool().await else {
            eprintln!("SKIP db_tests::full_flow (DATABASE_URL not set)");
            return;
        };
        let state = super::AppState {
            pool: pool.clone(),
            secure_cookies: false,
            login_limiter: std::sync::Arc::new(super::ratelimit::LoginLimiter::default()),
        };
        let app = super::router(state, "http://localhost:3000");
        let mut client = TestClient::new(app);

        // Bootstrap directly in the DB (mirrors the create-user CLI path).
        let email = format!("admin-{}@example.com", Uuid::new_v4());
        let hash = super::auth::hash_password("password123").unwrap();
        let uid = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)")
            .bind(uid)
            .bind(&email)
            .bind(&hash)
            .execute(&pool)
            .await
            .unwrap();

        // login
        let me: serde_json::Value = client
            .post(
                "/api/auth/login",
                &serde_json::json!({"email": email, "password": "password123"}),
            )
            .await;
        let cookie = client.last_set_cookie.clone().expect("session cookie");
        assert!(me["id"].as_str().is_some());

        // create project (creator becomes admin); unique key per run so the
        // test is repeatable against a persistent database.
        let pkey = format!("p1-{}", &Uuid::new_v4().simple().to_string()[..8]);
        let proj: serde_json::Value = client
            .post_cookie(
                "/api/projects",
                &cookie,
                &serde_json::json!({"key": pkey, "name": "P1"}),
            )
            .await;
        assert_eq!(proj["key"], pkey.as_str());

        // create environment + flag
        let env: serde_json::Value = client
            .post_cookie(
                &format!("/api/projects/{pkey}/environments"),
                &cookie,
                &serde_json::json!({"key": "prod", "name": "Prod"}),
            )
            .await;
        assert_eq!(env["version"], 1);
        let flag: serde_json::Value = client
            .post_cookie(
                &format!("/api/projects/{pkey}/flags"),
                &cookie,
                &serde_json::json!({"key": "new-checkout", "type": "bool"}),
            )
            .await;
        assert_eq!(flag["key"], "new-checkout");
        // creating the flag bumped the env version 1 -> 2
        let envs: serde_json::Value = client
            .get_cookie(&format!("/api/projects/{pkey}/environments"), &cookie)
            .await;
        assert_eq!(envs[0]["version"], 2);

        // read config (revision 1), then update with the right revision
        let cfg: serde_json::Value = client
            .get_cookie(
                &format!("/api/projects/{pkey}/environments/prod/flags/new-checkout"),
                &cookie,
            )
            .await;
        assert_eq!(cfg["revision"], 1);
        let upd: serde_json::Value = client
            .put_cookie(
                &format!("/api/projects/{pkey}/environments/prod/flags/new-checkout"),
                &cookie,
                &serde_json::json!({
                    "expectedRevision": 1, "enabled": true, "offValue": false,
                    "rules": [{"id": "r1",
                        "conditions": [{"attribute": "country", "op": "in", "values": ["NG"]}],
                        "serve": {"fixed": true}}],
                    "fallthrough": {"fixed": false}}),
            )
            .await;
        assert_eq!(upd["revision"], 2);
        assert_eq!(upd["version"], 3);

        // stale revision -> 409
        let (status, _) = client
            .put_cookie_raw(
                &format!("/api/projects/{pkey}/environments/prod/flags/new-checkout"),
                &cookie,
                &serde_json::json!({
                    "expectedRevision": 1, "enabled": true, "offValue": false,
                    "rules": [], "fallthrough": {"fixed": false}}),
            )
            .await;
        assert_eq!(status, 409);

        // invalid config -> 422 with path list
        let (status, body) = client
            .put_cookie_raw(
                &format!("/api/projects/{pkey}/environments/prod/flags/new-checkout"),
                &cookie,
                &serde_json::json!({
                    "expectedRevision": 2, "enabled": true, "offValue": false,
                    "rules": [{"id": "bad", "conditions": [],
                        "serve": {"rollout": [{"value": true, "weight": 100}]}}],
                    "fallthrough": {"fixed": false}}),
            )
            .await;
        assert_eq!(status, 422);
        assert!(body["errors"].as_array().is_some());

        // audit has rows, newest first
        let audit: serde_json::Value = client
            .get_cookie(&format!("/api/projects/{pkey}/audit?limit=5"), &cookie)
            .await;
        assert!(audit.as_array().unwrap().len() >= 2);
        assert_eq!(audit[0]["action"], "config.update");

        // sdk key -> config with ETag, then 304
        let created: serde_json::Value = client
            .post_cookie(
                &format!("/api/projects/{pkey}/environments/prod/sdk-keys"),
                &cookie,
                &serde_json::json!({"name": "k1"}),
            )
            .await;
        let sdk_key = created["key"].as_str().unwrap().to_string();
        let (etag, body) = client.sdk_config(&sdk_key, None).await;
        assert!(etag.starts_with("\"v"));
        assert_eq!(body["version"], 3);
        assert!(body["flags"]["new-checkout"]["enabled"].as_bool().unwrap());
        let (status, _) = client.sdk_config_raw(&sdk_key, Some(&etag)).await;
        assert_eq!(status, 304);

        // revoked key -> 401 on sdk endpoint
        let kid = created["id"].as_str().unwrap();
        let (status, _) = client
            .delete_cookie(
                &format!("/api/projects/{pkey}/environments/prod/sdk-keys/{kid}"),
                &cookie,
            )
            .await;
        assert_eq!(status, 204);
        let (status, _) = client.sdk_config_raw(&sdk_key, None).await;
        assert_eq!(status, 401);

        // sdk key lifecycle left audit rows, newest first
        let audit2: serde_json::Value = client
            .get_cookie(&format!("/api/projects/{pkey}/audit?limit=3"), &cookie)
            .await;
        let actions: Vec<&str> = audit2
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a["action"].as_str().unwrap())
            .collect();
        assert!(actions.contains(&"sdk-key.revoke"));
        assert!(actions.contains(&"sdk-key.create"));

        // --- CORS: dashboard origin can read X-Total-Count and ETag.
        let origin = [("origin", "http://localhost:3000")];
        let (s, _, h) = client
            .call(
                "GET",
                &format!("/api/projects/{pkey}/audit?limit=1"),
                Some(&cookie),
                &origin,
                None,
            )
            .await;
        assert_eq!(s, 200);
        assert_eq!(h["access-control-allow-origin"], "http://localhost:3000");
        assert_eq!(h["access-control-allow-credentials"], "true");
        let exposed = h["access-control-expose-headers"]
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        assert!(
            exposed.contains("x-total-count")
                && exposed.contains("etag")
                && exposed.contains("retry-after"),
            "{exposed}"
        );
        let total: i64 = h["x-total-count"].to_str().unwrap().parse().unwrap();
        assert!(total >= 5);

        // --- CORS: SDK endpoint accepts any origin, no credentials, Authorization allowed.
        let (s, _, h) = client
            .call(
                "OPTIONS",
                "/sdk/v1/config",
                None,
                &[
                    ("origin", "https://shop.example"),
                    ("access-control-request-method", "GET"),
                    (
                        "access-control-request-headers",
                        "authorization,if-none-match",
                    ),
                ],
                None,
            )
            .await;
        assert!((200..300).contains(&s), "sdk preflight -> {s}");
        assert_eq!(h["access-control-allow-origin"], "*");
        assert!(h.get("access-control-allow-credentials").is_none());
        let allowed = h["access-control-allow-headers"]
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        assert!(
            allowed.contains("authorization") && allowed.contains("if-none-match"),
            "{allowed}"
        );
        let k2: serde_json::Value = client
            .post_cookie(
                &format!("/api/projects/{pkey}/environments/prod/sdk-keys"),
                &cookie,
                &serde_json::json!({"name": "k2"}),
            )
            .await;
        let bearer = format!("Bearer {}", k2["key"].as_str().unwrap());
        let (s, _, h) = client
            .call(
                "GET",
                "/sdk/v1/config",
                None,
                &[
                    ("origin", "https://shop.example"),
                    ("authorization", bearer.as_str()),
                ],
                None,
            )
            .await;
        assert_eq!(s, 200);
        assert_eq!(h["access-control-allow-origin"], "*");
        assert!(h["access-control-expose-headers"]
            .to_str()
            .unwrap()
            .to_ascii_lowercase()
            .contains("etag"));
        // The dashboard policy does not leak onto the SDK route or vice versa.
        let (_, _, h) = client
            .call(
                "GET",
                "/api/me",
                Some(&cookie),
                &[("origin", "https://shop.example")],
                None,
            )
            .await;
        // (A fixed-origin policy always names the dashboard origin, which a
        // browser on any other origin rejects.)
        assert_eq!(h["access-control-allow-origin"], "http://localhost:3000");

        // --- last_used_at is written at most once a minute.
        let (s, _, _) = client
            .call(
                "GET",
                "/sdk/v1/config",
                None,
                &[("authorization", bearer.as_str())],
                None,
            )
            .await;
        assert_eq!(s, 200);
        let (lu1,): (chrono::DateTime<chrono::Utc>,) =
            sqlx::query_as("SELECT last_used_at FROM sdk_keys WHERE id = $1")
                .bind(k2["id"].as_str().unwrap().parse::<Uuid>().unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
        let (s, _, _) = client
            .call(
                "GET",
                "/sdk/v1/config",
                None,
                &[("authorization", bearer.as_str())],
                None,
            )
            .await;
        assert_eq!(s, 200);
        let (lu2,): (chrono::DateTime<chrono::Utc>,) =
            sqlx::query_as("SELECT last_used_at FROM sdk_keys WHERE id = $1")
                .bind(k2["id"].as_str().unwrap().parse::<Uuid>().unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            lu1, lu2,
            "second poll within a minute must not rewrite last_used_at"
        );

        // --- Flag description edit is audited.
        let (s, _, _) = client
            .call(
                "PATCH",
                &format!("/api/projects/{pkey}/flags/new-checkout"),
                Some(&cookie),
                &[],
                Some(&serde_json::json!({"description": "New checkout flow"})),
            )
            .await;
        assert_eq!(s, 200);

        // --- Last-admin protection: the only admin cannot demote themself.
        let (s, body) = client
            .post_cookie_raw(
                &format!("/api/projects/{pkey}/members"),
                &cookie,
                &serde_json::json!({"email": email, "role": "editor"}),
            )
            .await;
        assert_eq!(s, 409, "{body}");
        assert!(body["error"].as_str().unwrap().contains("last admin"));
        // Add a second admin, then the demotion is allowed.
        let email2 = format!("member-{}@example.com", Uuid::new_v4());
        let (s, _) = client
            .post_cookie_raw(
                &format!("/api/projects/{pkey}/members"),
                &cookie,
                &serde_json::json!({"email": email2, "password": "password456", "role": "admin"}),
            )
            .await;
        assert_eq!(s, 200);
        let (s, _) = client
            .post_cookie_raw(
                &format!("/api/projects/{pkey}/members"),
                &cookie,
                &serde_json::json!({"email": email2, "role": "viewer"}),
            )
            .await;
        assert_eq!(s, 200);
        // Now the original admin is the last one again.
        let (s, _) = client
            .post_cookie_raw(
                &format!("/api/projects/{pkey}/members"),
                &cookie,
                &serde_json::json!({"email": email, "role": "viewer"}),
            )
            .await;
        assert_eq!(s, 409);

        // --- New audit rows: project.create, flag.create (project-level),
        // flag.update, member.add, member.role-change.
        let all: serde_json::Value = client
            .get_cookie(&format!("/api/projects/{pkey}/audit?limit=200"), &cookie)
            .await;
        let rows = all.as_array().unwrap();
        let find = |action: &str| rows.iter().find(|r| r["action"] == action).cloned();
        let pc = find("project.create").expect("project.create row");
        assert_eq!(pc["after"]["key"], pkey.as_str());
        let fc: Vec<_> = rows
            .iter()
            .filter(|r| r["action"] == "flag.create")
            .collect();
        assert_eq!(fc.len(), 1, "flag.create is one project-level row");
        assert!(fc[0]["environment_id"].is_null());
        let fu = find("flag.update").expect("flag.update row");
        assert_eq!(fu["before"]["description"], "");
        assert_eq!(fu["after"]["description"], "New checkout flow");
        let ma = find("member.add").expect("member.add row");
        assert_eq!(ma["after"]["email"], email2.as_str());
        assert_eq!(ma["after"]["role"], "admin");
        let rc = find("member.role-change").expect("member.role-change row");
        assert_eq!(rc["before"]["role"], "admin");
        assert_eq!(rc["after"]["role"], "viewer");
        // Search treats % and _ literally (no wildcard match-all).
        let (s, none, _) = client
            .call(
                "GET",
                &format!("/api/projects/{pkey}/audit?q=%25"),
                Some(&cookie),
                &[],
                None,
            )
            .await;
        assert_eq!(s, 200);
        assert_eq!(none.as_array().unwrap().len(), 0);
        let (_, hits, _) = client
            .call(
                "GET",
                &format!("/api/projects/{pkey}/audit?q=member."),
                Some(&cookie),
                &[],
                None,
            )
            .await;
        assert_eq!(hits.as_array().unwrap().len(), 2);

        // --- Zero-environment project still audits flag creation.
        let pkey2 = format!("p2-{}", &Uuid::new_v4().simple().to_string()[..8]);
        client
            .post_cookie(
                "/api/projects",
                &cookie,
                &serde_json::json!({"key": pkey2, "name": "P2"}),
            )
            .await;
        client
            .post_cookie(
                &format!("/api/projects/{pkey2}/flags"),
                &cookie,
                &serde_json::json!({"key": "solo", "type": "bool"}),
            )
            .await;
        let a2: serde_json::Value = client
            .get_cookie(&format!("/api/projects/{pkey2}/audit"), &cookie)
            .await;
        assert!(a2
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["action"] == "flag.create" && r["flag_key"] == "solo"));
        // Duplicate keys -> 409.
        let (s, _) = client
            .post_cookie_raw(
                "/api/projects",
                &cookie,
                &serde_json::json!({"key": pkey2, "name": "dup"}),
            )
            .await;
        assert_eq!(s, 409);
        let (s, _) = client
            .post_cookie_raw(
                &format!("/api/projects/{pkey2}/flags"),
                &cookie,
                &serde_json::json!({"key": "solo", "type": "bool"}),
            )
            .await;
        assert_eq!(s, 409);

        // --- Non-members get 404 (not 403) for projects, envs and flags.
        let mut outsider = TestClient::new(client.app.clone());
        let out_email = format!("outsider-{}@example.com", Uuid::new_v4());
        let out_hash = super::auth::hash_password("password789").unwrap();
        sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)")
            .bind(Uuid::new_v4())
            .bind(&out_email)
            .bind(&out_hash)
            .execute(&pool)
            .await
            .unwrap();
        outsider
            .post(
                "/api/auth/login",
                &serde_json::json!({"email": out_email, "password": "password789"}),
            )
            .await;
        let oc = outsider.last_set_cookie.clone().unwrap();
        for path in [
            format!("/api/projects/{pkey}/environments"),
            format!("/api/projects/{pkey}/environments/prod/flags/new-checkout"),
            format!("/api/projects/{pkey}/environments/nope/flags/nope"),
            format!("/api/projects/{pkey}/audit"),
        ] {
            let (s, _, _) = outsider.call("GET", &path, Some(&oc), &[], None).await;
            assert_eq!(s, 404, "{path}");
        }
        // A viewer (a member, but below the required role) still gets 403.
        let mut viewer = TestClient::new(client.app.clone());
        viewer
            .post(
                "/api/auth/login",
                &serde_json::json!({"email": email2, "password": "password456"}),
            )
            .await;
        let vc = viewer.last_set_cookie.clone().unwrap();
        let (s, _, _) = viewer
            .call(
                "GET",
                &format!("/api/projects/{pkey}/environments/prod/sdk-keys"),
                Some(&vc),
                &[],
                None,
            )
            .await;
        assert_eq!(s, 403);
        let (s, _, _) = viewer
            .call(
                "GET",
                &format!("/api/projects/{pkey}/environments"),
                Some(&vc),
                &[],
                None,
            )
            .await;
        assert_eq!(s, 200);
    }

    #[tokio::test]
    async fn login_throttle() {
        let Some(pool) = live_pool().await else {
            eprintln!("SKIP db_tests::login_throttle (DATABASE_URL not set)");
            return;
        };
        let state = super::AppState {
            pool: pool.clone(),
            secure_cookies: false,
            login_limiter: std::sync::Arc::new(super::ratelimit::LoginLimiter::default()),
        };
        let mut client = TestClient::new(super::router(state, "http://localhost:3000"));
        let email = format!("throttle-{}@example.com", Uuid::new_v4());
        let hash = super::auth::hash_password("password123").unwrap();
        sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)")
            .bind(Uuid::new_v4())
            .bind(&email)
            .bind(&hash)
            .execute(&pool)
            .await
            .unwrap();
        // Unknown email: plain 401 (argon2 still runs against the dummy hash).
        let (s, _, _) = client
            .call(
                "POST",
                "/api/auth/login",
                None,
                &[],
                Some(&serde_json::json!({"email": "nobody@example.com", "password": "x"})),
            )
            .await;
        assert_eq!(s, 401);
        for i in 0..super::ratelimit::MAX_FAILURES {
            let (s, _, _) = client
                .call(
                    "POST",
                    "/api/auth/login",
                    None,
                    &[],
                    Some(&serde_json::json!({"email": email, "password": "wrong"})),
                )
                .await;
            // The unknown-email failure above shares the (test) IP bucket.
            if i + 1 < super::ratelimit::MAX_FAILURES {
                assert_eq!(s, 401, "attempt {i}");
            }
        }
        // Over budget: even the right password is refused with 429 + Retry-After.
        let (s, body, h) = client
            .call(
                "POST",
                "/api/auth/login",
                None,
                &[],
                Some(&serde_json::json!({"email": email, "password": "password123"})),
            )
            .await;
        assert_eq!(s, 429, "{body}");
        let retry: u64 = h["retry-after"].to_str().unwrap().parse().unwrap();
        assert!((1..=900).contains(&retry));
        assert!(client.last_set_cookie.is_none());
    }

    // Minimal in-process HTTP client over the router (no network socket).
    struct TestClient {
        app: axum::Router,
        pub last_set_cookie: Option<String>,
    }

    impl TestClient {
        fn new(app: axum::Router) -> Self {
            Self {
                app,
                last_set_cookie: None,
            }
        }

        async fn call(
            &mut self,
            method: &str,
            path: &str,
            cookie: Option<&str>,
            extra: &[(&str, &str)],
            body: Option<&serde_json::Value>,
        ) -> (u16, serde_json::Value, axum::http::HeaderMap) {
            use axum::http::{header, Request};
            use tower_service::Service;
            let mut b = Request::builder().method(method).uri(path);
            if let Some(c) = cookie {
                b = b.header(header::COOKIE, c);
            }
            for (k, v) in extra {
                b = b.header(*k, *v);
            }
            let req = if let Some(json) = body {
                b.header(header::CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(json.to_string()))
                    .unwrap()
            } else {
                b.body(axum::body::Body::empty()).unwrap()
            };
            let resp = self.app.as_service().call(req).await.unwrap();
            let status = resp.status().as_u16();
            let headers = resp.headers().clone();
            if let Some(sc) = headers
                .get(header::SET_COOKIE)
                .and_then(|v| v.to_str().ok())
            {
                // Keep only the `name=value` pair for reuse as a Cookie header.
                let pair = sc.split(';').next().unwrap_or("").trim().to_string();
                self.last_set_cookie = Some(pair);
            }
            let bytes = axum::body::to_bytes(resp.into_body(), 10 * 1024 * 1024)
                .await
                .unwrap();
            let json = if bytes.is_empty() {
                serde_json::Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null)
            };
            (status, json, headers)
        }

        async fn post(&mut self, path: &str, body: &serde_json::Value) -> serde_json::Value {
            let (s, j, _) = self.call("POST", path, None, &[], Some(body)).await;
            assert!((200..300).contains(&s), "POST {path} -> {s} {j}");
            j
        }

        async fn post_cookie(
            &mut self,
            path: &str,
            cookie: &str,
            body: &serde_json::Value,
        ) -> serde_json::Value {
            let (s, j, _) = self.call("POST", path, Some(cookie), &[], Some(body)).await;
            assert!((200..300).contains(&s), "POST {path} -> {s} {j}");
            j
        }

        async fn put_cookie(
            &mut self,
            path: &str,
            cookie: &str,
            body: &serde_json::Value,
        ) -> serde_json::Value {
            let (s, j, _) = self.call("PUT", path, Some(cookie), &[], Some(body)).await;
            assert!((200..300).contains(&s), "PUT {path} -> {s} {j}");
            j
        }

        async fn post_cookie_raw(
            &mut self,
            path: &str,
            cookie: &str,
            body: &serde_json::Value,
        ) -> (u16, serde_json::Value) {
            let (s, j, _) = self.call("POST", path, Some(cookie), &[], Some(body)).await;
            (s, j)
        }

        async fn put_cookie_raw(
            &mut self,
            path: &str,
            cookie: &str,
            body: &serde_json::Value,
        ) -> (u16, serde_json::Value) {
            let (s, j, _) = self.call("PUT", path, Some(cookie), &[], Some(body)).await;
            (s, j)
        }

        async fn get_cookie(&mut self, path: &str, cookie: &str) -> serde_json::Value {
            let (s, j, _) = self.call("GET", path, Some(cookie), &[], None).await;
            assert!((200..300).contains(&s), "GET {path} -> {s} {j}");
            j
        }

        async fn delete_cookie(&mut self, path: &str, cookie: &str) -> (u16, serde_json::Value) {
            let (s, j, _) = self.call("DELETE", path, Some(cookie), &[], None).await;
            (s, j)
        }

        async fn sdk_config(
            &mut self,
            key: &str,
            etag: Option<&str>,
        ) -> (String, serde_json::Value) {
            let auth = format!("Bearer {key}");
            let mut headers = vec![("authorization", auth.as_str())];
            let etag_owned;
            if let Some(e) = etag {
                etag_owned = e.to_string();
                headers.push(("if-none-match", etag_owned.as_str()));
            }
            let (s, j, h) = self
                .call("GET", "/sdk/v1/config", None, &headers, None)
                .await;
            assert_eq!(s, 200, "sdk config -> {s} {j}");
            let out_etag = h.get("etag").unwrap().to_str().unwrap().to_string();
            (out_etag, j)
        }

        async fn sdk_config_raw(
            &mut self,
            key: &str,
            etag: Option<&str>,
        ) -> (u16, serde_json::Value) {
            let auth = format!("Bearer {key}");
            let mut headers = vec![("authorization", auth.as_str())];
            let etag_owned;
            if let Some(e) = etag {
                etag_owned = e.to_string();
                headers.push(("if-none-match", etag_owned.as_str()));
            }
            let (s, j, _) = self
                .call("GET", "/sdk/v1/config", None, &headers, None)
                .await;
            (s, j)
        }
    }
}
