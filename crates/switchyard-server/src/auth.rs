//! Session + SDK-key auth (SPEC.md section 4.2).
//!
//! - Dashboard sessions: opaque 32-byte token in an HttpOnly SameSite=Lax
//!   cookie. Only SHA-256 of the token is stored. 7-day expiry. argon2id passwords.
//! - SDK keys: `sy_` + 32 random bytes base64url, shown once, stored as SHA-256.

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use axum::{
    async_trait,
    extract::FromRequestParts,
    http::{HeaderMap, StatusCode, header},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{error::ApiError, state::AppState};

pub const SESSION_COOKIE: &str = "sy_session";
const SESSION_TTL_SECS: i64 = 7 * 24 * 3600;

#[derive(Clone)]
pub struct AuthUser {
    pub id: Uuid,
    pub email: String,
}

pub struct SdkCtx {
    pub environment_id: Uuid,
    pub project_id: Uuid,
}

pub fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(ApiError::internal)
}

pub fn verify_password(hash: &str, password: &str) -> bool {
    let parsed = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

/// 32 random bytes, base64url. Used for session tokens and (with `sy_` prefix) SDK keys.
pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn sha256_bytes(input: &str) -> Vec<u8> {
    Sha256::digest(input.as_bytes()).to_vec()
}

pub fn new_sdk_key() -> (String, Vec<u8>, String) {
    let token = random_token();
    let full = format!("sy_{token}");
    let prefix = full.chars().take(8).collect::<String>();
    let hash = sha256_bytes(&full);
    (full, hash, prefix)
}

/// Pull one named cookie value out of a Cookie header.
pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some((k, v)) = part.split_once('=') {
            if k.trim() == name {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

pub fn session_cookie_value(headers: &HeaderMap) -> Option<String> {
    cookie_value(headers, SESSION_COOKIE)
}

pub fn set_session_cookie(secure: bool, token: &str) -> String {
    let mut c = format!("{SESSION_COOKIE}={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age={SESSION_TTL_SECS}");
    if secure {
        c.push_str("; Secure");
    }
    c
}

pub fn clear_session_cookie() -> String {
    format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0")
}

async fn user_for_token(pool: &PgPool, token: &str) -> Result<Option<AuthUser>, ApiError> {
    let hash = sha256_bytes(token);
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()",
    )
    .bind(&hash)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(row.map(|(id, email)| AuthUser { id, email }))
}

/// Session-cookie guard for management endpoints.
#[async_trait]
impl FromRequestParts<AppState> for AuthUser {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = session_cookie_value(&parts.headers).ok_or((StatusCode::UNAUTHORIZED, "unauthorized"))?;
        match user_for_token(&state.pool, &token)
            .await
            .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "internal error"))?
        {
            Some(u) => Ok(u),
            None => Err((StatusCode::UNAUTHORIZED, "unauthorized")),
        }
    }
}

/// Bearer SDK-key guard for `/sdk/*`. Rejects revoked keys.
#[async_trait]
impl FromRequestParts<AppState> for SdkCtx {
    type Rejection = (StatusCode, &'static str);

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let auth = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .ok_or((StatusCode::UNAUTHORIZED, "unauthorized"))?;
        let token = auth
            .strip_prefix("Bearer ")
            .ok_or((StatusCode::UNAUTHORIZED, "unauthorized"))?;
        let hash = sha256_bytes(token);
        let row: Option<(Uuid, Uuid)> = sqlx::query_as(
            "SELECT k.environment_id, e.project_id FROM sdk_keys k
             JOIN environments e ON e.id = k.environment_id
             WHERE k.key_hash = $1 AND k.revoked_at IS NULL",
        )
        .bind(&hash)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "internal error"))?;
        match row {
            Some((environment_id, project_id)) => Ok(SdkCtx { environment_id, project_id }),
            None => Err((StatusCode::UNAUTHORIZED, "unauthorized")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sdk_key_format() {
        let (full, hash, prefix) = new_sdk_key();
        assert!(full.starts_with("sy_"));
        assert_eq!(prefix.len(), 8);
        assert_eq!(hash.len(), 32);
        // Hash is one-way: the stored value never contains the key.
        assert!(!String::from_utf8_lossy(&hash).contains(&full));
    }

    #[test]
    fn cookie_parsing() {
        let mut h = HeaderMap::new();
        h.insert(header::COOKIE, "a=1; sy_session=tok123; b=2".parse().unwrap());
        assert_eq!(session_cookie_value(&h), Some("tok123".to_string()));
        let empty = HeaderMap::new();
        assert_eq!(session_cookie_value(&empty), None);
    }

    #[test]
    fn password_roundtrip() {
        let hash = hash_password("correct horse").unwrap();
        assert!(verify_password(&hash, "correct horse"));
        assert!(!verify_password(&hash, "wrong"));
        // Emails are stored lowercased at the call site; hashing is case-sensitive.
        assert!(!verify_password(&hash, "Correct Horse"));
    }
}
