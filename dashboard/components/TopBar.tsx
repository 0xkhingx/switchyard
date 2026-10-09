"use client";

import type { Env, Project } from "@/lib/api";
import { LockIcon, MenuIcon } from "./icons";
import styles from "./TopBar.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

async function signOut() {
  await fetch(`${API_URL}/api/auth/logout`, { method: "POST", credentials: "include" });
  window.location.href = "/login";
}

export function TopBar({
  projects,
  projectKey,
  onProjectChange,
  envs,
  envKey,
  onEnvChange,
  userInitials,
  onMenu,
  showEnv = true,
}: {
  projects: Project[];
  projectKey: string;
  onProjectChange: (key: string) => void;
  envs: Env[];
  envKey: string;
  onEnvChange: (key: string) => void;
  userInitials: string;
  onMenu: () => void;
  showEnv?: boolean;
}) {
  const env = envs.find((e) => e.key === envKey);
  return (
    <header className={styles.bar}>
      <button type="button" className={styles.hamburger} onClick={onMenu} aria-label="Open navigation">
        <MenuIcon size={20} />
      </button>
      <div className={styles.selectors}>
        <label className={styles.selectWrap}>
          <span className={styles.selectLabel}>Project</span>
          <select
            className={styles.select}
            value={projectKey}
            onChange={(e) => onProjectChange(e.target.value)}
            aria-label="Project"
          >
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {showEnv && (
        <label className={styles.selectWrap}>
          <span className={styles.selectLabel}>Environment</span>
          <span className={styles.envSelectRow}>
            {env && <span className={styles.dot} aria-hidden="true" />}
            <select
              className={styles.select}
              value={envKey}
              onChange={(e) => onEnvChange(e.target.value)}
              aria-label="Environment"
            >
              {envs.map((e) => (
                <option key={e.key} value={e.key}>
                  {e.name}
                </option>
              ))}
            </select>
            {env?.protected && (
              <span className={styles.lock} title="Protected environment" aria-label="Protected environment">
                <LockIcon size={14} />
              </span>
            )}
          </span>
        </label>
        )}
      </div>
      <div className={styles.right}>
        <button type="button" className={styles.kbd} title="Command palette (coming soon)" disabled>
          ⌘ K
        </button>
        <button
          type="button"
          className={styles.userAvatar}
          title="Sign out"
          aria-label="Sign out"
          onClick={() => void signOut()}
        >
          {userInitials}
        </button>
      </div>
    </header>
  );
}
