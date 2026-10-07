mod auth;
mod error;
mod handlers;
mod rbac;
mod state;

use axum::{
    Router,
    http::{HeaderValue, Method, header},
    routing::{delete, get, patch, post},
};
use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use tower_http::{
    cors::{AllowHeaders, CorsLayer},
    trace::TraceLayer,
};
use uuid::Uuid;

use state::AppState;

fn router(state: AppState) -> Router {
    let authed = Router::new()
        .route("/api/auth/logout", post(handlers::logout))
        .route("/api/me", get(handlers::me))
        .route("/api/projects", get(handlers::list_projects).post(handlers::create_project))
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
    Router::new()
        .route("/api/auth/login", post(handlers::login))
        .route("/sdk/v1/config", get(handlers::sdk_config))
        .merge(authed)
        .with_state(state)
}

fn cors(origin: &str) -> CorsLayer {
    CorsLayer::new()
        .allow_origin(
            origin
                .parse::<HeaderValue>()
                .expect("DASHBOARD_ORIGIN must be a valid origin"),
        )
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
        .allow_headers(AllowHeaders::list(vec![
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::IF_NONE_MATCH,
        ]))
        .allow_credentials(true)
}

async fn pool() -> Result<sqlx::PgPool, String> {
    let url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is not set".to_string())?;
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&url)
        .await
        .map_err(|e| format!("cannot connect to Postgres: {e}"))?;
    sqlx::migrate!().run(&pool).await.map_err(|e| format!("migration failed: {e}"))?;
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
    let origin = std::env::var("DASHBOARD_ORIGIN").unwrap_or_else(|_| "http://localhost:3000".to_string());
    let secure = std::env::var("COOKIE_SECURE").map(|v| v == "1" || v == "true").unwrap_or(false);
    let state = AppState { pool, dashboard_origin: origin.clone(), secure_cookies: secure };
    let app = router(state).layer(cors(&origin)).layer(TraceLayer::new_for_http());
    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    println!("switchyard-server listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}

// ---------------------------------------------------------------------------
// Integration test: full flow against a live Postgres.
// Runs only when DATABASE_URL is set; otherwise it reports SKIP and passes,
// so `cargo test` stays green on machines without a database.
// ---------------------------------------------------------------------------

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
            dashboard_origin: "http://localhost:3000".into(),
            secure_cookies: false,
        };
        let app = super::router(state).layer(super::cors("http://localhost:3000"));
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
            .post("/api/auth/login", &serde_json::json!({"email": email, "password": "password123"}))
            .await;
        let cookie = client.last_set_cookie.clone().expect("session cookie");
        assert!(me["id"].as_str().is_some());

        // create project (creator becomes admin)
        let proj: serde_json::Value = client
            .post_cookie("/api/projects", &cookie, &serde_json::json!({"key": "p1", "name": "P1"}))
            .await;
        assert_eq!(proj["key"], "p1");

        // create environment + flag
        let env: serde_json::Value = client
            .post_cookie("/api/projects/p1/environments", &cookie, &serde_json::json!({"key": "prod", "name": "Prod"}))
            .await;
        assert_eq!(env["version"], 1);
        let flag: serde_json::Value = client
            .post_cookie("/api/projects/p1/flags", &cookie, &serde_json::json!({"key": "new-checkout", "type": "bool"}))
            .await;
        assert_eq!(flag["key"], "new-checkout");
        // creating the flag bumped the env version 1 -> 2
        let envs: serde_json::Value = client.get_cookie("/api/projects/p1/environments", &cookie).await;
        assert_eq!(envs[0]["version"], 2);

        // read config (revision 1), then update with the right revision
        let cfg: serde_json::Value = client
            .get_cookie("/api/projects/p1/environments/prod/flags/new-checkout", &cookie)
            .await;
        assert_eq!(cfg["revision"], 1);
        let upd: serde_json::Value = client
            .put_cookie(
                "/api/projects/p1/environments/prod/flags/new-checkout",
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
                "/api/projects/p1/environments/prod/flags/new-checkout",
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
                "/api/projects/p1/environments/prod/flags/new-checkout",
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
        let audit: serde_json::Value =
            client.get_cookie("/api/projects/p1/audit?limit=5", &cookie).await;
        assert!(audit.as_array().unwrap().len() >= 2);
        assert_eq!(audit[0]["action"], "config.update");

        // sdk key -> config with ETag, then 304
        let created: serde_json::Value = client
            .post_cookie("/api/projects/p1/environments/prod/sdk-keys", &cookie, &serde_json::json!({"name": "k1"}))
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
            .delete_cookie(&format!("/api/projects/p1/environments/prod/sdk-keys/{kid}"), &cookie)
            .await;
        assert_eq!(status, 204);
        let (status, _) = client.sdk_config_raw(&sdk_key, None).await;
        assert_eq!(status, 401);
    }

    // Minimal in-process HTTP client over the router (no network socket).
    struct TestClient {
        app: axum::Router,
        pub last_set_cookie: Option<String>,
    }

    impl TestClient {
        fn new(app: axum::Router) -> Self {
            Self { app, last_set_cookie: None }
        }

        async fn call(
            &mut self,
            method: &str,
            path: &str,
            cookie: Option<&str>,
            extra: &[(&str, &str)],
            body: Option<&serde_json::Value>,
        ) -> (u16, serde_json::Value, axum::http::HeaderMap) {
            use axum::http::{Request, header};
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
            if let Some(sc) = headers.get(header::SET_COOKIE).and_then(|v| v.to_str().ok()) {
                // Keep only the `name=value` pair for reuse as a Cookie header.
                let pair = sc.split(';').next().unwrap_or("").trim().to_string();
                self.last_set_cookie = Some(pair);
            }
            let bytes = axum::body::to_bytes(resp.into_body(), 10 * 1024 * 1024).await.unwrap();
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

        async fn post_cookie(&mut self, path: &str, cookie: &str, body: &serde_json::Value) -> serde_json::Value {
            let (s, j, _) = self.call("POST", path, Some(cookie), &[], Some(body)).await;
            assert!((200..300).contains(&s), "POST {path} -> {s} {j}");
            j
        }

        async fn put_cookie(&mut self, path: &str, cookie: &str, body: &serde_json::Value) -> serde_json::Value {
            let (s, j, _) = self.call("PUT", path, Some(cookie), &[], Some(body)).await;
            assert!((200..300).contains(&s), "PUT {path} -> {s} {j}");
            j
        }

        async fn put_cookie_raw(&mut self, path: &str, cookie: &str, body: &serde_json::Value) -> (u16, serde_json::Value) {
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

        async fn sdk_config(&mut self, key: &str, etag: Option<&str>) -> (String, serde_json::Value) {
            let auth = format!("Bearer {key}");
            let mut headers = vec![("authorization", auth.as_str())];
            let etag_owned;
            if let Some(e) = etag {
                etag_owned = e.to_string();
                headers.push(("if-none-match", etag_owned.as_str()));
            }
            let (s, j, h) = self.call("GET", "/sdk/v1/config", None, &headers, None).await;
            assert_eq!(s, 200, "sdk config -> {s} {j}");
            let out_etag = h.get("etag").unwrap().to_str().unwrap().to_string();
            (out_etag, j)
        }

        async fn sdk_config_raw(&mut self, key: &str, etag: Option<&str>) -> (u16, serde_json::Value) {
            let auth = format!("Bearer {key}");
            let mut headers = vec![("authorization", auth.as_str())];
            let etag_owned;
            if let Some(e) = etag {
                etag_owned = e.to_string();
                headers.push(("if-none-match", etag_owned.as_str()));
            }
            let (s, j, _) = self.call("GET", "/sdk/v1/config", None, &headers, None).await;
            (s, j)
        }
    }
}
