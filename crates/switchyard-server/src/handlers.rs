//! Management + SDK handlers (SPEC.md sections 4.4 and 4.5).

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sqlx::{PgPool, Postgres, QueryBuilder, Transaction};
use switchyard_core::{
    Context, EnvConfig, Evaluation, FlagConfig, FlagType, Rule, Serve,
    Variant, evaluate, flag_key_valid, validate,
};
use uuid::Uuid;

use crate::{
    auth::{self, AuthUser, SdkCtx},
    error::ApiError,
    rbac::{self, Role},
    state::AppState,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn resolve_project(pool: &PgPool, p: &str) -> Result<(Uuid, String), ApiError> {
    // Accept either the UUID or the human key.
    if let Ok(id) = p.parse::<Uuid>() {
        let row: Option<(String,)> = sqlx::query_as("SELECT key FROM projects WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .map_err(ApiError::internal)?;
        return row
            .map(|(key,)| (id, key))
            .ok_or_else(|| ApiError::NotFound("project not found".into()));
    }
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM projects WHERE key = $1")
        .bind(p)
        .fetch_optional(pool)
        .await
        .map_err(ApiError::internal)?;
    row.map(|(id,)| (id, p.to_string()))
        .ok_or_else(|| ApiError::NotFound("project not found".into()))
}

struct EnvRef {
    id: Uuid,
    protected: bool,
}

async fn resolve_env(pool: &PgPool, project_id: Uuid, e: &str) -> Result<EnvRef, ApiError> {
    let row: Option<(Uuid, bool)> = if let Ok(id) = e.parse::<Uuid>() {
        sqlx::query_as("SELECT id, protected FROM environments WHERE id = $1 AND project_id = $2")
            .bind(id)
            .bind(project_id)
            .fetch_optional(pool)
            .await
            .map_err(ApiError::internal)?
    } else {
        sqlx::query_as("SELECT id, protected FROM environments WHERE project_id = $1 AND key = $2")
            .bind(project_id)
            .bind(e)
            .fetch_optional(pool)
            .await
            .map_err(ApiError::internal)?
    };
    row.map(|(id, protected)| EnvRef { id, protected })
        .ok_or_else(|| ApiError::NotFound("environment not found".into()))
}

async fn resolve_flag(
    pool: &PgPool,
    project_id: Uuid,
    key: &str,
) -> Result<(Uuid, FlagType), ApiError> {
    let row: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, type FROM flags WHERE project_id = $1 AND key = $2")
            .bind(project_id)
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(ApiError::internal)?;
    match row {
        None => Err(ApiError::NotFound("flag not found".into())),
        Some((id, t)) => Ok((
            id,
            match t.as_str() {
                "bool" => FlagType::Bool,
                "string" => FlagType::String,
                _ => return Err(ApiError::internal("unknown flag type in db")),
            },
        )),
    }
}

async fn insert_audit(
    tx: &mut Transaction<'_, Postgres>,
    project_id: Uuid,
    environment_id: Option<Uuid>,
    flag_key: Option<&str>,
    actor_id: Uuid,
    action: &str,
    before: Option<&JsonValue>,
    after: Option<&JsonValue>,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO audit_log (project_id, environment_id, flag_key, actor_id, action, before, after)
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(project_id)
    .bind(environment_id)
    .bind(flag_key)
    .bind(actor_id)
    .bind(action)
    .bind(before)
    .bind(after)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::internal)?;
    Ok(())
}

fn default_serve_json(kind: FlagType) -> (JsonValue, JsonValue, JsonValue) {
    // (off_value, fallthrough, rules) for a brand-new flag in an environment.
    match kind {
        FlagType::Bool => (
            JsonValue::Bool(false),
            serde_json::json!({"fixed": false}),
            JsonValue::Array(vec![]),
        ),
        FlagType::String => (
            JsonValue::String(String::new()),
            serde_json::json!({"fixed": ""}),
            JsonValue::Array(vec![]),
        ),
    }
}

fn etag_for(version: i64) -> String {
    format!("\"v{version}\"")
}

/// True when If-None-Match equals the current ETag (quoted or bare).
pub fn etag_matches(headers: &HeaderMap, etag: &str) -> bool {
    match headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
    {
        None => false,
        Some(v) => {
            let v = v.trim();
            v == etag || v == etag.trim_matches('"')
        }
    }
}

fn json_response(status: StatusCode, value: &JsonValue, extra: &[(header::HeaderName, String)]) -> Response {
    let mut b = Response::builder().status(status).header(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    for (k, v) in extra {
        b = b.header(k, HeaderValue::from_str(v).unwrap_or(HeaderValue::from_static("")));
    }
    b.body(Body::from(serde_json::to_string(value).unwrap()))
        .unwrap()
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct LoginBody {
    pub email: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct MeBody {
    pub id: Uuid,
    pub email: String,
}

pub async fn login(State(state): State<AppState>, Json(body): Json<LoginBody>) -> Result<Response, ApiError> {
    let email = body.email.to_lowercase();
    let row: Option<(Uuid, String, String)> =
        sqlx::query_as("SELECT id, email, password_hash FROM users WHERE email = $1")
            .bind(&email)
            .fetch_optional(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    let (id, email, hash) = row.ok_or(ApiError::Unauthorized)?;
    if !auth::verify_password(&hash, &body.password) {
        return Err(ApiError::Unauthorized);
    }
    let token = auth::random_token();
    let token_hash = auth::sha256_bytes(&token);
    sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => 604800))")
        .bind(&token_hash)
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    let cookie = auth::set_session_cookie(state.secure_cookies, &token);
    Ok(json_response(
        StatusCode::OK,
        &serde_json::to_value(MeBody { id, email }).unwrap(),
        &[(header::SET_COOKIE, cookie)],
    ))
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    if let Some(token) = auth::session_cookie_value(&headers) {
        let hash = auth::sha256_bytes(&token);
        sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(&hash)
            .execute(&state.pool)
            .await
            .map_err(ApiError::internal)?;
    }
    Ok(json_response(
        StatusCode::OK,
        &serde_json::json!({"ok": true}),
        &[(header::SET_COOKIE, auth::clear_session_cookie())],
    ))
}

pub async fn me(user: AuthUser) -> Json<MeBody> {
    Json(MeBody { id: user.id, email: user.email })
}

// ---------------------------------------------------------------------------
// Projects & environments
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ProjectBody {
    pub id: Uuid,
    pub key: String,
    pub name: String,
}

pub async fn list_projects(State(state): State<AppState>, user: AuthUser) -> Result<Json<Vec<ProjectBody>>, ApiError> {
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT p.id, p.key, p.name FROM projects p
         JOIN memberships m ON m.project_id = p.id
         WHERE m.user_id = $1 ORDER BY p.created_at",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, key, name)| ProjectBody { id, key, name })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct CreateProjectBody {
    pub key: String,
    pub name: String,
}

pub async fn create_project(
    State(state): State<AppState>,
    user: AuthUser,
    Json(body): Json<CreateProjectBody>,
) -> Result<(StatusCode, Json<ProjectBody>), ApiError> {
    if !flag_key_valid(&body.key) {
        return Err(ApiError::unprocessable("/key", "project key must match ^[a-z0-9][a-z0-9._-]{0,63}$"));
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let id = Uuid::new_v4();
    let exists: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM projects WHERE key = $1")
        .bind(&body.key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if exists.is_some() {
        return Err(ApiError::Conflict("project key already exists".into()));
    }
    sqlx::query("INSERT INTO projects (id, key, name) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(&body.key)
        .bind(&body.name)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    // The creator becomes admin so the project is never ownerless.
    sqlx::query("INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, 'admin')")
        .bind(id)
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok((
        StatusCode::CREATED,
        Json(ProjectBody { id, key: body.key, name: body.name }),
    ))
}

#[derive(Serialize)]
pub struct EnvBody {
    pub id: Uuid,
    pub key: String,
    pub name: String,
    pub protected: bool,
    pub version: i64,
}

pub async fn list_environments(
    State(state): State<AppState>,
    user: AuthUser,
    Path(p): Path<String>,
) -> Result<Json<Vec<EnvBody>>, ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Viewer).await?;
    let rows: Vec<(Uuid, String, String, bool, i64)> = sqlx::query_as(
        "SELECT id, key, name, protected, version FROM environments WHERE project_id = $1 ORDER BY key",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, key, name, protected, version)| EnvBody { id, key, name, protected, version })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct CreateEnvBody {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub protected: bool,
}

pub async fn create_environment(
    State(state): State<AppState>,
    user: AuthUser,
    Path(p): Path<String>,
    Json(body): Json<CreateEnvBody>,
) -> Result<(StatusCode, Json<EnvBody>), ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Admin).await?;
    if !flag_key_valid(&body.key) {
        return Err(ApiError::unprocessable("/key", "environment key must match ^[a-z0-9][a-z0-9._-]{0,63}$"));
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let dup: Option<(Uuid,)> = sqlx::query_as(
        "SELECT id FROM environments WHERE project_id = $1 AND key = $2",
    )
    .bind(project_id)
    .bind(&body.key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    if dup.is_some() {
        return Err(ApiError::Conflict("environment key already exists".into()));
    }
    let env_id = Uuid::new_v4();
    sqlx::query("INSERT INTO environments (id, project_id, key, name, protected) VALUES ($1, $2, $3, $4, $5)")
        .bind(env_id)
        .bind(project_id)
        .bind(&body.key)
        .bind(&body.name)
        .bind(body.protected)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    // Seed a disabled-by-default config for every existing flag.
    let flags: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT id, type FROM flags WHERE project_id = $1")
            .bind(project_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    for (flag_id, ftype) in flags {
        let kind = if ftype == "bool" { FlagType::Bool } else { FlagType::String };
        let (off, fall, rules) = default_serve_json(kind);
        sqlx::query(
            "INSERT INTO flag_configs (flag_id, environment_id, enabled, off_value, fallthrough, rules, updated_by)
             VALUES ($1, $2, false, $3, $4, $5, $6)",
        )
        .bind(flag_id)
        .bind(env_id)
        .bind(&off)
        .bind(&fall)
        .bind(&rules)
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    }
    insert_audit(
        &mut tx,
        project_id,
        Some(env_id),
        None,
        user.id,
        "environment.create",
        None,
        Some(&serde_json::json!({"key": body.key})),
    )
    .await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok((
        StatusCode::CREATED,
        Json(EnvBody { id: env_id, key: body.key, name: body.name, protected: body.protected, version: 1 }),
    ))
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct FlagBody {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub description: String,
    pub archived: bool,
    pub created_at: DateTime<Utc>,
}

pub async fn list_flags(
    State(state): State<AppState>,
    user: AuthUser,
    Path(p): Path<String>,
) -> Result<Json<Vec<FlagBody>>, ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Viewer).await?;
    let rows: Vec<(String, String, String, bool, DateTime<Utc>)> = sqlx::query_as(
        "SELECT key, type, description, archived, created_at FROM flags WHERE project_id = $1 ORDER BY key",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|(key, kind, description, archived, created_at)| FlagBody {
                key, kind, description, archived, created_at,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct CreateFlagBody {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: FlagType,
    #[serde(default)]
    pub description: String,
}

pub async fn create_flag(
    State(state): State<AppState>,
    user: AuthUser,
    Path(p): Path<String>,
    Json(body): Json<CreateFlagBody>,
) -> Result<(StatusCode, Json<FlagBody>), ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Editor).await?;
    if !flag_key_valid(&body.key) {
        return Err(ApiError::unprocessable("/key", "flag key must match ^[a-z0-9][a-z0-9._-]{0,63}$"));
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let dup: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM flags WHERE project_id = $1 AND key = $2")
        .bind(project_id)
        .bind(&body.key)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if dup.is_some() {
        return Err(ApiError::Conflict("flag key already exists".into()));
    }
    let flag_id = Uuid::new_v4();
    let kind_str = match body.kind {
        FlagType::Bool => "bool",
        FlagType::String => "string",
    };
    sqlx::query("INSERT INTO flags (id, project_id, key, type, description) VALUES ($1, $2, $3, $4, $5)")
        .bind(flag_id)
        .bind(project_id)
        .bind(&body.key)
        .bind(kind_str)
        .bind(&body.description)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    // Seed configs + bump every environment this flag touches.
    let envs: Vec<Uuid> = sqlx::query_as("SELECT id FROM environments WHERE project_id = $1")
        .bind(project_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(ApiError::internal)?
        .into_iter()
        .map(|(id,): (Uuid,)| id)
        .collect();
    let (off, fall, rules) = default_serve_json(body.kind);
    for env_id in &envs {
        sqlx::query(
            "INSERT INTO flag_configs (flag_id, environment_id, enabled, off_value, fallthrough, rules, updated_by)
             VALUES ($1, $2, false, $3, $4, $5, $6)",
        )
        .bind(flag_id)
        .bind(env_id)
        .bind(&off)
        .bind(&fall)
        .bind(&rules)
        .bind(user.id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
        sqlx::query("UPDATE environments SET version = version + 1 WHERE id = $1")
            .bind(env_id)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
        insert_audit(
            &mut tx,
            project_id,
            Some(*env_id),
            Some(&body.key),
            user.id,
            "flag.create",
            None,
            Some(&serde_json::json!({"type": kind_str})),
        )
        .await?;
    }
    tx.commit().await.map_err(ApiError::internal)?;
    Ok((
        StatusCode::CREATED,
        Json(FlagBody {
            key: body.key,
            kind: kind_str.to_string(),
            description: body.description,
            archived: false,
            created_at: Utc::now(),
        }),
    ))
}

#[derive(Deserialize)]
pub struct PatchFlagBody {
    pub description: Option<String>,
    pub archived: Option<bool>,
}

pub async fn patch_flag(
    State(state): State<AppState>,
    user: AuthUser,
    Path((p, key)): Path<(String, String)>,
    Json(body): Json<PatchFlagBody>,
) -> Result<Json<FlagBody>, ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Editor).await?;
    let (flag_id, kind) = resolve_flag(&state.pool, project_id, &key).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let row: Option<(String, bool)> =
        sqlx::query_as("SELECT description, archived FROM flags WHERE id = $1 FOR UPDATE")
            .bind(flag_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    let (mut description, mut archived) = row.ok_or_else(|| ApiError::NotFound("flag not found".into()))?;
    if let Some(d) = body.description {
        description = d;
    }
    let mut archived_changed = false;
    if let Some(a) = body.archived {
        if a != archived {
            archived = a;
            archived_changed = true;
        }
    }
    sqlx::query("UPDATE flags SET description = $1, archived = $2 WHERE id = $3")
        .bind(&description)
        .bind(archived)
        .bind(flag_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if archived_changed {
        // Archiving changes what SDKs download, so bump every environment.
        let envs: Vec<Uuid> = sqlx::query_as("SELECT id FROM environments WHERE project_id = $1")
            .bind(project_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(ApiError::internal)?
            .into_iter()
            .map(|(id,): (Uuid,)| id)
            .collect();
        for env_id in &envs {
            sqlx::query("UPDATE environments SET version = version + 1 WHERE id = $1")
                .bind(env_id)
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
            insert_audit(
                &mut tx,
                project_id,
                Some(*env_id),
                Some(&key),
                user.id,
                if archived { "flag.archive" } else { "flag.unarchive" },
                None,
                Some(&serde_json::json!({"archived": archived})),
            )
            .await?;
        }
    }
    tx.commit().await.map_err(ApiError::internal)?;
    let kind_str = match kind {
        FlagType::Bool => "bool",
        FlagType::String => "string",
    };
    Ok(Json(FlagBody {
        key,
        kind: kind_str.to_string(),
        description,
        archived,
        created_at: Utc::now(),
    }))
}

// ---------------------------------------------------------------------------
// Flag config read + versioned update (SPEC.md section 4.3)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct FlagConfigBody {
    pub revision: i64,
    pub enabled: bool,
    #[serde(rename = "offValue")]
    pub off_value: Variant,
    pub rules: Vec<Rule>,
    pub fallthrough: Serve,
    pub updated_at: DateTime<Utc>,
    pub updated_by: Option<Uuid>,
}

pub async fn get_flag_config(
    State(state): State<AppState>,
    user: AuthUser,
    Path((p, e, key)): Path<(String, String, String)>,
) -> Result<Json<FlagConfigBody>, ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Viewer).await?;
    let env = resolve_env(&state.pool, project_id, &e).await?;
    let (flag_id, _) = resolve_flag(&state.pool, project_id, &key).await?;
    let row: Option<(bool, JsonValue, JsonValue, JsonValue, i64, DateTime<Utc>, Option<Uuid>)> = sqlx::query_as(
        "SELECT enabled, off_value, rules, fallthrough, revision, updated_at, updated_by FROM flag_configs
         WHERE flag_id = $1 AND environment_id = $2",
    )
    .bind(flag_id)
    .bind(env.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    let (enabled, off_value, rules, fallthrough, revision, updated_at, updated_by) =
        row.ok_or_else(|| ApiError::NotFound("config not found".into()))?;
    Ok(Json(FlagConfigBody {
        revision,
        enabled,
        off_value: serde_json::from_value(off_value).map_err(ApiError::internal)?,
        rules: serde_json::from_value(rules).map_err(ApiError::internal)?,
        fallthrough: serde_json::from_value(fallthrough).map_err(ApiError::internal)?,
        updated_at,
        updated_by,
    }))
}

#[derive(Deserialize)]
pub struct PutConfigBody {
    #[serde(rename = "expectedRevision")]
    pub expected_revision: i64,
    pub enabled: bool,
    #[serde(rename = "offValue")]
    pub off_value: Variant,
    pub rules: Vec<Rule>,
    pub fallthrough: Serve,
}

#[derive(Serialize)]
pub struct PutConfigResponse {
    pub revision: i64,
    pub version: i64,
}

pub async fn put_flag_config(
    State(state): State<AppState>,
    user: AuthUser,
    Path((p, e, key)): Path<(String, String, String)>,
    Json(body): Json<PutConfigBody>,
) -> Result<Json<PutConfigResponse>, ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    let env = resolve_env(&state.pool, project_id, &e).await?;
    let (flag_id, kind) = resolve_flag(&state.pool, project_id, &key).await?;
    // Protected environments need admin; others need editor.
    let min = if env.protected { Role::Admin } else { Role::Editor };
    rbac::require_role(&state.pool, user.id, project_id, min).await?;

    // Validate before touching the database.
    let draft = FlagConfig {
        kind,
        enabled: body.enabled,
        off_value: body.off_value.clone(),
        rules: body.rules.clone(),
        fallthrough: body.fallthrough.clone(),
    };
    let single = EnvConfig {
        version: 0,
        flags: [(key.clone(), draft)].into_iter().collect(),
    };
    let errors = validate(&single);
    if !errors.is_empty() {
        return Err(ApiError::Unprocessable(errors));
    }

    // One transaction: guard revision, write row, bump env version, audit.
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let row: Option<(i64, bool, JsonValue, JsonValue, JsonValue)> = sqlx::query_as(
        "SELECT revision, enabled, off_value, rules, fallthrough FROM flag_configs
         WHERE flag_id = $1 AND environment_id = $2 FOR UPDATE",
    )
    .bind(flag_id)
    .bind(env.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let (revision, old_enabled, old_off, old_rules, old_fall) =
        row.ok_or_else(|| ApiError::NotFound("config not found".into()))?;
    if revision != body.expected_revision {
        return Err(ApiError::Conflict(
            "stale revision: someone else changed this flag; reload and retry".into(),
        ));
    }
    let before = serde_json::json!({
        "revision": revision, "enabled": old_enabled,
        "offValue": old_off, "rules": old_rules, "fallthrough": old_fall,
    });
    let off_json = serde_json::to_value(&body.off_value).map_err(ApiError::internal)?;
    let rules_json = serde_json::to_value(&body.rules).map_err(ApiError::internal)?;
    let fall_json = serde_json::to_value(&body.fallthrough).map_err(ApiError::internal)?;
    sqlx::query(
        "UPDATE flag_configs SET enabled = $1, off_value = $2, rules = $3, fallthrough = $4,
         revision = revision + 1, updated_at = now(), updated_by = $5
         WHERE flag_id = $6 AND environment_id = $7",
    )
    .bind(body.enabled)
    .bind(&off_json)
    .bind(&rules_json)
    .bind(&fall_json)
    .bind(user.id)
    .bind(flag_id)
    .bind(env.id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let (new_version,): (i64,) =
        sqlx::query_as("UPDATE environments SET version = version + 1 WHERE id = $1 RETURNING version")
            .bind(env.id)
            .fetch_one(&mut *tx)
            .await
            .map_err(ApiError::internal)?;
    let after = serde_json::json!({
        "revision": revision + 1, "enabled": body.enabled,
        "offValue": off_json, "rules": rules_json, "fallthrough": fall_json,
    });
    insert_audit(
        &mut tx,
        project_id,
        Some(env.id),
        Some(&key),
        user.id,
        "config.update",
        Some(&before),
        Some(&after),
    )
    .await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(PutConfigResponse { revision: revision + 1, version: new_version }))
}

// ---------------------------------------------------------------------------
// Dashboard test-panel evaluation
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct EvaluateBody {
    pub config: FlagConfig,
    #[serde(rename = "flagKey")]
    pub flag_key: String,
    pub context: Context,
}

pub async fn post_evaluate(
    _user: AuthUser,
    Json(body): Json<EvaluateBody>,
) -> Json<Evaluation> {
    let cfg = EnvConfig {
        version: 0,
        flags: [(body.flag_key.clone(), body.config)].into_iter().collect(),
    };
    Json(evaluate(&cfg, &body.flag_key, &body.context))
}

// ---------------------------------------------------------------------------
// SDK keys
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct SdkKeyBody {
    pub id: Uuid,
    pub name: String,
    pub prefix: String,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct SdkKeyCreated {
    #[serde(flatten)]
    pub meta: SdkKeyBody,
    /// The full key, shown exactly once.
    pub key: String,
}

pub async fn list_sdk_keys(
    State(state): State<AppState>,
    user: AuthUser,
    Path((p, e)): Path<(String, String)>,
) -> Result<Json<Vec<SdkKeyBody>>, ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Admin).await?;
    let env = resolve_env(&state.pool, project_id, &e).await?;
    let rows: Vec<(Uuid, String, String, DateTime<Utc>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, name, prefix, created_at, revoked_at FROM sdk_keys WHERE environment_id = $1 ORDER BY created_at",
    )
    .bind(env.id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(
        rows.into_iter()
            .map(|(id, name, prefix, created_at, revoked_at)| SdkKeyBody {
                id, name, prefix, created_at, revoked_at,
            })
            .collect(),
    ))
}

#[derive(Deserialize)]
pub struct CreateSdkKeyBody {
    pub name: String,
}

pub async fn create_sdk_key(
    State(state): State<AppState>,
    user: AuthUser,
    Path((p, e)): Path<(String, String)>,
    Json(body): Json<CreateSdkKeyBody>,
) -> Result<(StatusCode, Json<SdkKeyCreated>), ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Admin).await?;
    let env = resolve_env(&state.pool, project_id, &e).await?;
    let (full, hash, prefix) = auth::new_sdk_key();
    let id = Uuid::new_v4();
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let created: DateTime<Utc> = sqlx::query_as::<_, (DateTime<Utc>,)>(
        "INSERT INTO sdk_keys (id, environment_id, name, prefix, key_hash) VALUES ($1, $2, $3, $4, $5) RETURNING created_at",
    )
    .bind(id)
    .bind(env.id)
    .bind(&body.name)
    .bind(&prefix)
    .bind(&hash)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?
    .0;
    insert_audit(
        &mut tx,
        project_id,
        Some(env.id),
        None,
        user.id,
        "sdk-key.create",
        None,
        Some(&serde_json::json!({"name": body.name, "prefix": prefix})),
    )
    .await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok((
        StatusCode::CREATED,
        Json(SdkKeyCreated {
            meta: SdkKeyBody { id, name: body.name, prefix, created_at: created, revoked_at: None },
            key: full,
        }),
    ))
}

/// Revoke (DELETE per spec; the row is kept with revoked_at for auditability).
pub async fn delete_sdk_key(
    State(state): State<AppState>,
    user: AuthUser,
    Path((p, e, id)): Path<(String, String, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Admin).await?;
    let env = resolve_env(&state.pool, project_id, &e).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let row: Option<(String,)> = sqlx::query_as(
        "UPDATE sdk_keys SET revoked_at = now() WHERE id = $1 AND environment_id = $2 AND revoked_at IS NULL RETURNING name",
    )
    .bind(id)
    .bind(env.id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let (name,) = row.ok_or_else(|| ApiError::NotFound("sdk key not found".into()))?;
    insert_audit(
        &mut tx,
        project_id,
        Some(env.id),
        None,
        user.id,
        "sdk-key.revoke",
        None,
        Some(&serde_json::json!({"name": name})),
    )
    .await?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct MemberBody {
    pub id: Uuid,
    pub email: String,
    pub role: String,
}

pub async fn list_members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(p): Path<String>,
) -> Result<Json<Vec<MemberBody>>, ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Viewer).await?;
    let rows: Vec<(Uuid, String, String)> = sqlx::query_as(
        "SELECT u.id, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
         WHERE m.project_id = $1 ORDER BY u.email",
    )
    .bind(project_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(Json(
        rows.into_iter().map(|(id, email, role)| MemberBody { id, email, role }).collect(),
    ))
}

#[derive(Deserialize)]
pub struct AddMemberBody {
    pub email: String,
    pub password: Option<String>,
    pub role: String,
}

pub async fn add_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path(p): Path<String>,
    Json(body): Json<AddMemberBody>,
) -> Result<Json<MemberBody>, ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Admin).await?;
    let role = Role::parse(&body.role)
        .ok_or_else(|| ApiError::BadRequest("role must be admin, editor or viewer".into()))?;
    let email = body.email.to_lowercase();
    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    let existing: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE email = $1")
        .bind(&email)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let user_id = match existing {
        Some((id,)) => id, // Existing users keep their password; only the role changes.
        None => {
            let password = body
                .password
                .ok_or_else(|| ApiError::BadRequest("new members need an initial password".into()))?;
            if password.len() < 8 {
                return Err(ApiError::BadRequest("password must be at least 8 characters".into()));
            }
            let id = Uuid::new_v4();
            let hash = auth::hash_password(&password)?;
            sqlx::query("INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)")
                .bind(id)
                .bind(&email)
                .bind(&hash)
                .execute(&mut *tx)
                .await
                .map_err(ApiError::internal)?;
            id
        }
    };
    sqlx::query(
        "INSERT INTO memberships (project_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role",
    )
    .bind(project_id)
    .bind(user_id)
    .bind(role.as_str())
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;
    Ok(Json(MemberBody { id: user_id, email, role: role.as_str().to_string() }))
}

// ---------------------------------------------------------------------------
// Audit log (append-only: no update/delete endpoints)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AuditQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub environment_id: Option<Uuid>,
    pub flag_key: Option<String>,
    /// Display category: created, updated, enabled, disabled, archived,
    /// sdk_key_created, sdk_key_revoked. Unknown values are ignored.
    pub category: Option<String>,
    pub actor: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub q: Option<String>,
}

/// Push the shared WHERE clause for audit listing + counting.
fn audit_filters(
    qb: &mut sqlx::QueryBuilder<'_, Postgres>,
    project_id: Uuid,
    q: &AuditQuery,
) {
    qb.push("a.project_id = ");
    qb.push_bind(project_id);
    if let Some(env_id) = q.environment_id {
        qb.push(" AND a.environment_id = ");
        qb.push_bind(env_id);
    }
    if let Some(flag) = &q.flag_key {
        qb.push(" AND a.flag_key = ");
        qb.push_bind(flag.clone());
    }
    if let Some(actor) = &q.actor {
        qb.push(" AND u.email = ");
        qb.push_bind(actor.clone());
    }
    if let Some(since) = q.since {
        qb.push(" AND a.created_at >= ");
        qb.push_bind(since);
    }
    if let Some(term) = &q.q {
        qb.push(" AND (a.flag_key ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(" OR a.action ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(" OR u.email ILIKE ");
        qb.push_bind(format!("%{term}%"));
        qb.push(")");
    }
    // Display categories derived from the stored action + before/after.
    // Enabled/disabled are config updates whose enabled flag flipped.
    match q.category.as_deref() {
        Some("created") => {
            qb.push(" AND a.action IN ('flag.create','environment.create')");
        }
        Some("updated") => {
            qb.push(" AND (a.action = 'flag.unarchive' OR (a.action = 'config.update' AND NOT ((a.before->>'enabled')::boolean IS DISTINCT FROM (a.after->>'enabled')::boolean)))");
        }
        Some("enabled") => {
            qb.push(" AND a.action = 'config.update' AND (a.before->>'enabled')::boolean IS FALSE AND (a.after->>'enabled')::boolean IS TRUE");
        }
        Some("disabled") => {
            qb.push(" AND a.action = 'config.update' AND (a.before->>'enabled')::boolean IS TRUE AND (a.after->>'enabled')::boolean IS FALSE");
        }
        Some("archived") => {
            qb.push(" AND a.action = 'flag.archive'");
        }
        Some("sdk_key_created") => {
            qb.push(" AND a.action = 'sdk-key.create'");
        }
        Some("sdk_key_revoked") => {
            qb.push(" AND a.action = 'sdk-key.revoke'");
        }
        _ => {}
    }
}

#[derive(Serialize)]
pub struct AuditBody {
    pub id: i64,
    pub environment_id: Option<Uuid>,
    pub flag_key: Option<String>,
    pub actor_email: Option<String>,
    pub action: String,
    pub before: Option<JsonValue>,
    pub after: Option<JsonValue>,
    pub created_at: DateTime<Utc>,
}

pub async fn list_audit(
    State(state): State<AppState>,
    user: AuthUser,
    Path(p): Path<String>,
    Query(q): Query<AuditQuery>,
) -> Result<Response, ApiError> {
    let (project_id, _) = resolve_project(&state.pool, &p).await?;
    rbac::require_role(&state.pool, user.id, project_id, Role::Viewer).await?;
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);

    let mut count_qb: QueryBuilder<'_, Postgres> = QueryBuilder::new(
        "SELECT COUNT(*) FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ",
    );
    audit_filters(&mut count_qb, project_id, &q);
    let (total,): (i64,) = count_qb
        .build_query_as()
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::internal)?;

    let mut qb: QueryBuilder<'_, Postgres> = QueryBuilder::new(
        "SELECT a.id, a.environment_id, a.flag_key, u.email, a.action, a.before, a.after, a.created_at
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE ",
    );
    audit_filters(&mut qb, project_id, &q);
    qb.push(" ORDER BY a.id DESC LIMIT ");
    qb.push_bind(limit);
    qb.push(" OFFSET ");
    qb.push_bind(offset);
    let rows: Vec<(
        i64,
        Option<Uuid>,
        Option<String>,
        Option<String>,
        String,
        Option<JsonValue>,
        Option<JsonValue>,
        DateTime<Utc>,
    )> = qb
        .build_query_as()
        .fetch_all(&state.pool)
        .await
        .map_err(ApiError::internal)?;
    let body = rows
        .into_iter()
        .map(
            |(id, environment_id, flag_key, actor_email, action, before, after, created_at)| {
                AuditBody {
                    id,
                    environment_id,
                    flag_key,
                    actor_email,
                    action,
                    before,
                    after,
                    created_at,
                }
            },
        )
        .collect::<Vec<_>>();
    Ok(json_response(
        StatusCode::OK,
        &serde_json::to_value(&body).map_err(ApiError::internal)?,
        &[(header::HeaderName::from_static("x-total-count"), total.to_string())],
    ))
}

// ---------------------------------------------------------------------------
// SDK config (Bearer key, ETag polling)
// ---------------------------------------------------------------------------

async fn assemble_env_config(pool: &PgPool, project_id: Uuid, env_id: Uuid) -> Result<(i64, EnvConfig), ApiError> {
    let (version,): (i64,) = sqlx::query_as("SELECT version FROM environments WHERE id = $1")
        .bind(env_id)
        .fetch_one(pool)
        .await
        .map_err(ApiError::internal)?;
    let rows: Vec<(String, String, bool, JsonValue, JsonValue, JsonValue)> = sqlx::query_as(
        "SELECT f.key, f.type, c.enabled, c.off_value, c.rules, c.fallthrough
         FROM flags f JOIN flag_configs c ON c.flag_id = f.id
         WHERE f.project_id = $1 AND c.environment_id = $2 AND f.archived = false",
    )
    .bind(project_id)
    .bind(env_id)
    .fetch_all(pool)
    .await
    .map_err(ApiError::internal)?;
    let mut flags = std::collections::HashMap::new();
    for (key, ftype, enabled, off_value, rules, fallthrough) in rows {
        let kind = match ftype.as_str() {
            "bool" => FlagType::Bool,
            _ => FlagType::String,
        };
        flags.insert(
            key,
            FlagConfig {
                kind,
                enabled,
                off_value: serde_json::from_value(off_value).map_err(ApiError::internal)?,
                rules: serde_json::from_value(rules).map_err(ApiError::internal)?,
                fallthrough: serde_json::from_value(fallthrough).map_err(ApiError::internal)?,
            },
        );
    }
    Ok((
        version,
        EnvConfig { version: version as u64, flags },
    ))
}

pub async fn sdk_config(
    State(state): State<AppState>,
    sdk: SdkCtx,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let (version, config) = assemble_env_config(&state.pool, sdk.project_id, sdk.environment_id).await?;
    let etag = etag_for(version);
    // 304 without building the body when the SDK is already current.
    if etag_matches(&headers, &etag) {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, HeaderValue::from_str(&etag).unwrap())
            .body(Body::empty())
            .map_err(ApiError::internal);
    }
    let body = serde_json::to_string(&config).map_err(ApiError::internal)?;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HeaderValue::from_static("application/json"))
        .header(header::ETAG, HeaderValue::from_str(&etag).unwrap())
        .header(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"))
        .header(header::VARY, HeaderValue::from_static("Authorization"))
        .body(Body::from(body))
        .map_err(ApiError::internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etag_comparison() {
        let mut h = HeaderMap::new();
        h.insert(header::IF_NONE_MATCH, "\"v7\"".parse().unwrap());
        assert!(etag_matches(&h, "\"v7\""));
        assert!(!etag_matches(&h, "\"v8\""));
        // Bare (unquoted) values some clients send are accepted too.
        let mut h2 = HeaderMap::new();
        h2.insert(header::IF_NONE_MATCH, "v7".parse().unwrap());
        assert!(etag_matches(&h2, "\"v7\""));
        assert!(!etag_matches(&HeaderMap::new(), "\"v7\""));
    }
}
