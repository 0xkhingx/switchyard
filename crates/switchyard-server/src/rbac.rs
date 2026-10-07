//! RBAC (SPEC.md section 4.4).
//!
//! viewer: read. editor: + create/archive flags, edit non-protected envs.
//! admin: + protected envs, environments, SDK keys, members.

use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Role {
    Viewer,
    Editor,
    Admin,
}

impl Role {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "viewer" => Some(Self::Viewer),
            "editor" => Some(Self::Editor),
            "admin" => Some(Self::Admin),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Editor => "editor",
            Self::Admin => "admin",
        }
    }
}

pub async fn membership(pool: &PgPool, user_id: Uuid, project_id: Uuid) -> Result<Option<Role>, ApiError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT role FROM memberships WHERE project_id = $1 AND user_id = $2",
    )
    .bind(project_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(row.and_then(|(r,)| Role::parse(&r)))
}

/// Require at least `min` role on the project, else 403 (404 would leak existence;
/// we use 403 uniformly once the project is known to exist).
pub async fn require_role(
    pool: &PgPool,
    user_id: Uuid,
    project_id: Uuid,
    min: Role,
) -> Result<(), ApiError> {
    match membership(pool, user_id, project_id).await? {
        Some(r) if r >= min => Ok(()),
        _ => Err(ApiError::Forbidden),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_ordering() {
        assert!(Role::Admin >= Role::Editor);
        assert!(Role::Editor >= Role::Viewer);
        assert!(Role::Viewer < Role::Admin);
        assert_eq!(Role::parse("admin"), Some(Role::Admin));
        assert_eq!(Role::parse("owner"), None);
    }
}
