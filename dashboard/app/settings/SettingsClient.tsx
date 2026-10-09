"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { EmptyState, ErrorCard, TableSkeleton } from "@/components/controls";
import {
  ApiError,
  apiGet,
  type Env,
  type Flag,
  type Me,
  type Member,
  type Project,
  type SdkKey,
} from "@/lib/api";
import styles from "./settings.module.css";

export function SettingsClient() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectKey, setProjectKey] = useState(params.get("project") ?? "");
  const [envs, setEnvs] = useState<Env[]>([]);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [keyCount, setKeyCount] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const sp = new URLSearchParams();
    if (projectKey) sp.set("project", projectKey);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  }, [projectKey, pathname, router]);

  const load = useCallback(async () => {
    setPhase("loading");
    setLoadError("");
    try {
      const meData = await apiGet<Me>("/api/me").catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          window.location.href = "/login";
          throw e;
        }
        throw e;
      });
      setMe(meData);
      const projs = await apiGet<Project[]>("/api/projects");
      setProjects(projs);
      const pkey = params.get("project") || projs[0]?.key || "";
      if (!pkey) {
        setPhase("ready");
        return;
      }
      setProjectKey(pkey);
      const [envList, flagList, memberList] = await Promise.all([
        apiGet<Env[]>(`/api/projects/${pkey}/environments`),
        apiGet<Flag[]>(`/api/projects/${pkey}/flags`),
        apiGet<Member[]>(`/api/projects/${pkey}/members`),
      ]);
      setEnvs(envList);
      setFlags(flagList);
      setMembers(memberList);
      // Key count across environments (read-only aggregate).
      let keys = 0;
      for (const e of envList) {
        try {
          const list = await apiGet<SdkKey[]>(`/api/projects/${pkey}/environments/${e.key}/sdk-keys`);
          keys += list.length;
        } catch {
          // Non-admins cannot list keys; show what we can.
        }
      }
      setKeyCount(keys);
      setPhase("ready");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }, [params]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function changeProject(next: string) {
    setProjectKey(next);
    setEnvs([]);
    setFlags([]);
    setMembers([]);
    setKeyCount(0);
    await load();
  }

  const project = projects.find((p) => p.key === projectKey);
  const myRole = me ? members.find((m) => m.id === me.id)?.role : undefined;
  const admins = members.filter((m) => m.role === "admin");
  const editors = members.filter((m) => m.role === "editor");
  const viewers = members.filter((m) => m.role === "viewer");
  const activeFlags = flags.filter((f) => !f.archived).length;
  const initials = (me?.email || "?").slice(0, 2).toUpperCase();

  function exactDate(iso: string): string {    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  async function copyId() {
    if (!project) return;
    try {
      await navigator.clipboard.writeText(project.id);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const shortId = project ? `${project.id.slice(0, 8)}…${project.id.slice(-8)}` : "";

function LockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

  return (
    <div className={styles.shell}>
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className={styles.main}>
        <TopBar
          projects={projects}
          projectKey={projectKey}
          onProjectChange={(k) => void changeProject(k)}
          envs={[]}
          envKey=""
          onEnvChange={() => {}}
          showEnv={false}
          userInitials={initials}
          onMenu={() => setNavOpen(true)}
        />
        <div className={styles.content}>
          <div className={styles.pageHead}>
            <h1>Project Settings</h1>
            <p>Manage your project configuration and preferences.</p>
          </div>

          {phase === "loading" && <TableSkeleton rows={5} />}
          {phase === "error" && <ErrorCard message={loadError} onRetry={() => void load()} />}
          {phase === "ready" && !project && (
            <EmptyState title="No project selected" body="Create a project to manage its settings." />
          )}
          {phase === "ready" && project && (
            <div className={styles.grid}>
              <div className={styles.mainCol}>
                <section className={styles.card} aria-label="Project details">
                  <h2>Project details</h2>
                  <p className={styles.cardSub}>Basic information about this project.</p>
                  <dl className={styles.detailList}>
                    <div>
                      <dt>Project name</dt>
                      <dd>{project.name}</dd>
                    </div>
                    <div>
                      <dt>Project key</dt>
                      <dd className={styles.mono}>{project.key}</dd>
                    </div>
                  </dl>
                  <p className={styles.infoStrip}>
                    <InfoIcon />
                    <span>
                      Project details are read-only in this version. Renaming is not supported by
                      the API yet.
                    </span>
                  </p>
                </section>

                <section className={styles.card} aria-label="Environments">
                  <h2>Environments</h2>
                  <p className={styles.cardSub}>Environments configured for this project.</p>
                  {envs.length === 0 && (
                    <p className={styles.cardSub}>No environments configured yet.</p>
                  )}
                  {envs.length > 0 && (
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">Name</th>
                          <th scope="col">Protection</th>
                          <th scope="col">Version</th>
                        </tr>
                      </thead>
                      <tbody>
                        {envs.map((e) => (
                          <tr key={e.key}>
                            <td>
                              <strong>{e.name}</strong>
                            </td>
                            <td>
                              {e.protected ? (
                                <span className={styles.protected}>
                                  <LockIcon /> Protected
                                </span>
                              ) : (
                                <span className={styles.muted}>Not protected</span>
                              )}
                            </td>
                            <td className={styles.mono}>v{e.version}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className={styles.infoStrip}>
                    <InfoIcon />
                    <span>Protected environments restrict changes based on user permissions.</span>
                  </p>
                </section>

                <section className={styles.card} aria-label="Project access">
                  <h2>Project access</h2>
                  <p className={styles.cardSub}>
                    {myRole
                      ? `Your role: ${myRole}${me ? ` (${me.email})` : ""}`
                      : "Project membership is currently managed through the API."}
                  </p>
                  <ul className={styles.roleCounts}>
                    <li>
                      <strong>{admins.length}</strong> Admin{admins.length === 1 ? "" : "s"}
                    </li>
                    <li>
                      <strong>{editors.length}</strong> Editor{editors.length === 1 ? "" : "s"}
                    </li>
                    <li>
                      <strong>{viewers.length}</strong> Viewer{viewers.length === 1 ? "" : "s"}
                    </li>
                  </ul>
                  <p className={styles.infoStrip}>
                    <InfoIcon />
                    <span>Project membership is currently managed through the API.</span>
                  </p>
                </section>
              </div>

              <div className={styles.sideCol}>
                <section className={styles.card} aria-label="Project information">
                  <h2>Project information</h2>
                  <dl className={styles.infoList}>
                    <div>
                      <dt>Project ID</dt>
                      <dd>
                        <span className={styles.monoSmall} title={project.id}>
                          {shortId}
                        </span>
                        <button
                          type="button"
                          className={styles.copyButton}
                          onClick={() => void copyId()}
                          aria-label="Copy project ID"
                          aria-live="polite"
                        >
                          {copied ? "Copied" : "⧉"}
                        </button>
                      </dd>
                    </div>
                    <div>
                      <dt>Created at</dt>
                      <dd>{exactDate(project.created_at)}</dd>
                    </div>
                    <div>
                      <dt>Environments</dt>
                      <dd>{envs.length}</dd>
                    </div>
                    <div>
                      <dt>Flags</dt>
                      <dd>{activeFlags}</dd>
                    </div>
                    <div>
                      <dt>SDK keys</dt>
                      <dd>{keyCount}</dd>
                    </div>
                  </dl>
                </section>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
