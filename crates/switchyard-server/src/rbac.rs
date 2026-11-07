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

pub async fn membership(
    pool: &PgPool,
    user_id: Uuid,
    project_id: Uuid,
) -> Result<Option<Role>, ApiError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT role FROM memberships WHERE project_id = $1 AND user_id = $2")
            .bind(project_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(ApiError::internal)?;
    Ok(row.and_then(|(r,)| Role::parse(&r)))
}

/// The caller's role on the project. Non-members get 404 (the same answer as
/// a project that does not exist), so membership is checked before anything
/// else about the project is revealed.
pub async fn require_member(
    pool: &PgPool,
    user_id: Uuid,
    project_id: Uuid,
) -> Result<Role, ApiError> {
    membership(pool, user_id, project_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("project not found".into()))
}

/// Members below `min` get 403: they already know the project exists.
pub fn require(role: Role, min: Role) -> Result<(), ApiError> {
    if role >= min {
        Ok(())
    } else {
        Err(ApiError::Forbidden)
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
        assert!(require(Role::Admin, Role::Editor).is_ok());
        assert!(matches!(
            require(Role::Viewer, Role::Editor),
            Err(ApiError::Forbidden)
        ));
    }
}
