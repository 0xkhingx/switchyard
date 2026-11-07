"use client";

import type { Env, Project } from "@/lib/api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LockIcon } from "./icons";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { SelectMenu } from "./SelectMenu";
import styles from "./TopBar.module.css";
import { Hint } from "@/components/ui/tooltip";

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
  showEnv = true,
}: {
  projects: Project[];
  projectKey: string;
  onProjectChange: (key: string) => void;
  envs: Env[];
  envKey: string;
  onEnvChange: (key: string) => void;
  userInitials: string;
  showEnv?: boolean;
}) {
  const env = envs.find((e) => e.key === envKey);
  return (
    <header className={styles.bar}>
      <SidebarTrigger className={styles.sidebarTrigger} aria-label="Toggle sidebar" />
      <Separator orientation="vertical" className="mr-1 data-vertical:h-4 data-vertical:self-center" />
      <nav className={styles.selectors} aria-label="Context">
        <SelectMenu
          variant="ghost"
          ariaLabel="Project"
          className={styles.select}
          value={projectKey}
          onChange={onProjectChange}
          options={projects.map((p) => ({
            value: p.key,
            label: p.name,
            hint: <span className="mono">{p.key}</span>,
          }))}
        />
        {showEnv && (
          <>
            <span className={styles.sep} aria-hidden="true">
              /
            </span>
            <SelectMenu
              variant="ghost"
              ariaLabel="Environment"
              className={styles.select}
              value={envKey}
              onChange={onEnvChange}
              options={envs.map((e) => ({
                value: e.key,
                label: e.name,
                icon: <span className="sy-dot" data-tone={e.protected ? "warning" : undefined} aria-hidden="true" />,
                hint: e.protected ? "Protected" : undefined,
              }))}
            />
            {env?.protected && (
              <Hint label="Changes in this environment are restricted by role" side="bottom">
              <span className={styles.lock}>
                <LockIcon size={13} />
                <span>Protected</span>
              </span>
              </Hint>
            )}
          </>
        )}
      </nav>
      <div className={styles.right}>
        <DropdownMenu>
          <DropdownMenuTrigger className={styles.userAvatar} aria-label="Account menu">
            {userInitials}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onClick={() => void signOut()}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
