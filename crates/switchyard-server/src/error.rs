use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use switchyard_core::ValidationError;

/// API error with a status code and a JSON body.
#[derive(Debug)]
pub enum ApiError {
    Unauthorized,
    Forbidden,
    NotFound(String),
    Conflict(String),
    BadRequest(String),
    /// 422 with a list of `{ path, message }` (SPEC.md section 4.5).
    Unprocessable(Vec<ValidationError>),
    Internal(String),
}

impl ApiError {
    pub fn unprocessable(path: &str, message: &str) -> Self {
        Self::Unprocessable(vec![ValidationError {
            path: path.to_string(),
            message: message.to_string(),
        }])
    }

    pub fn internal<E: std::fmt::Display>(e: E) -> Self {
        Self::Internal(e.to_string())
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match &self {
            Self::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_string()),
            Self::NotFound(m) => (StatusCode::NOT_FOUND, m.clone()),
            Self::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            Self::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            Self::Unprocessable(_) => (StatusCode::UNPROCESSABLE_ENTITY, "validation failed".to_string()),
            Self::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal error".to_string(),
            ),
        };
        // Never leak internal details to the client; they go to server logs.
        if let Self::Internal(detail) = &self {
            tracing::error!(detail, "internal error");
        }
        match self {
            Self::Unprocessable(items) => (status, Json(serde_json::json!({ "errors": items }))).into_response(),
            _ => (status, Json(ErrorBody { error: message })).into_response(),
        }
    }
}
