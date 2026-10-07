"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { ConfirmModal } from "@/components/Modal";
import {
  EmptyState,
  ErrorCard,
  Pagination,
  TableSkeleton,
  Toggle,
  TypeBadge,
} from "@/components/controls";
import {
  ApiError,
  apiGet,
  apiPatch,
  apiPut,
  type Env,
  type Flag,
  type FlagConfig,
  type Me,
  type Member,
  type Project,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { FilterBar, type SortKey, type StatusFilter, type TypeFilter } from "./FilterBar";
import { CreateFlagModal } from "./CreateFlagModal";
import { RowMenu } from "./RowMenu";
import styles from "./flags.module.css";

const PAGE_SIZE = 8;

interface Row {
  flag: Flag;
  enabled: boolean;
  revision: number;
  offValue: boolean | string;
  rules: unknown[];
  fallthrough: unknown;
  updatedAt: string;
  author: string;
}

export function FlagsClient() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectKey, setProjectKey] = useState(params.get("project") ?? "");
  const [envs, setEnvs] = useState<Env[]>([]);
  const [envKey, setEnvKey] = useState(params.get("env") ?? "");
  const [members, setMembers] = useState<Member[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");

  const [q, setQ] = useState(params.get("q") ?? "");
  const [status, setStatus] = useState<StatusFilter>(
    (params.get("status") as StatusFilter) || "all",
  );
  const [type, setType] = useState<TypeFilter>((params.get("type") as TypeFilter) || "all");
  const [sort, setSort] = useState<SortKey>((params.get("sort") as SortKey) || "updated");
  const [page, setPage] = useState(Number(params.get("page")) || 1);

  const [navOpen, setNavOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ flagKey: string; next: boolean } | null>(null);
  const [archive, setArchive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep shareable filter state in the URL.
  useEffect(() => {
    const sp = new URLSearchParams();
    if (projectKey) sp.set("project", projectKey);
    if (envKey) sp.set("env", envKey);
    if (q) sp.set("q", q);
    if (status !== "all") sp.set("status", status);
    if (type !== "all") sp.set("type", type);
    if (sort !== "updated") sp.set("sort", sort);
    if (page !== 1) sp.set("page", String(page));
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  }, [projectKey, envKey, q, status, type, sort, page, pathname, router]);

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
        setRows([]);
        return;
      }
      setProjectKey(pkey);
      const envList = await apiGet<Env[]>(`/api/projects/${pkey}/environments`);
      setEnvs(envList);
      const ekey = params.get("env") || envList[0]?.key || "";
      setEnvKey(ekey);
      const [memberList, flagList] = await Promise.all([
        apiGet<Member[]>(`/api/projects/${pkey}/members`),
        apiGet<Flag[]>(`/api/projects/${pkey}/flags`),
      ]);
      setMembers(memberList);
      const visible = flagList.filter((f) => !f.archived);
      // One config read per flag in the selected environment: enabled state,
      // revision (for safe writes), and updated info (for the column + sort).
      const configs = await Promise.all(
        visible.map((f) =>
          apiGet<FlagConfig>(`/api/projects/${pkey}/environments/${ekey}/flags/${f.key}`),
        ),
      );
      const byId = new Map(memberList.map((m) => [m.id, m.email] as const));
      setRows(
        visible.map((flag, i) => {
          const cfg = configs[i];
          const email = (cfg.updated_by && byId.get(cfg.updated_by)) || null;
          return {
            flag,
            enabled: cfg.enabled,
            revision: cfg.revision,
            offValue: cfg.offValue,
            rules: cfg.rules as unknown[],
            fallthrough: cfg.fallthrough,
            updatedAt: cfg.updated_at,
            author: email ? (email === meData.email ? "you" : email.split("@")[0]) : "—",
          };
        }),
      );
      setPhase("ready");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return; // redirecting
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }, [params]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Changing project/environment reloads everything (role, protection, values).
  async function changeProject(next: string) {
    setProjectKey(next);
    setEnvKey("");
    setRows([]);
    setPage(1);
    setPhase("loading");
    try {
      const envList = await apiGet<Env[]>(`/api/projects/${next}/environments`);
      setEnvs(envList);
      const ekey = envList[0]?.key || "";
      setEnvKey(ekey);
      const [memberList, flagList] = await Promise.all([
        apiGet<Member[]>(`/api/projects/${next}/members`),
        apiGet<Flag[]>(`/api/projects/${next}/flags`),
      ]);
      setMembers(memberList);
      const visible = flagList.filter((f) => !f.archived);
      const configs = await Promise.all(
        visible.map((f) =>
          apiGet<FlagConfig>(`/api/projects/${next}/environments/${ekey}/flags/${f.key}`),
        ),
      );
      const byId = new Map(memberList.map((m) => [m.id, m.email] as const));
      setRows(
        visible.map((flag, i) => {
          const cfg = configs[i];
          const email = (cfg.updated_by && byId.get(cfg.updated_by)) || null;
          return {
            flag,
            enabled: cfg.enabled,
            revision: cfg.revision,
            offValue: cfg.offValue,
            rules: cfg.rules as unknown[],
            fallthrough: cfg.fallthrough,
            updatedAt: cfg.updated_at,
            author: email ? (email === me?.email ? "you" : email.split("@")[0]) : "—",
          };
        }),
      );
      setPhase("ready");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }

  async function changeEnv(next: string) {
    if (!projectKey) return;
    setEnvKey(next);
    setPage(1);
    setPhase("loading");
    try {
      const flagList = await apiGet<Flag[]>(`/api/projects/${projectKey}/flags`);
      const visible = flagList.filter((f) => !f.archived);
      const configs = await Promise.all(
        visible.map((f) =>
          apiGet<FlagConfig>(`/api/projects/${projectKey}/environments/${next}/flags/${f.key}`),
        ),
      );
      const byId = new Map(members.map((m) => [m.id, m.email] as const));
      setRows(
        visible.map((flag, i) => {
          const cfg = configs[i];
          const email = (cfg.updated_by && byId.get(cfg.updated_by)) || null;
          return {
            flag,
            enabled: cfg.enabled,
            revision: cfg.revision,
            offValue: cfg.offValue,
            rules: cfg.rules as unknown[],
            fallthrough: cfg.fallthrough,
            updatedAt: cfg.updated_at,
            author: email ? (email === me?.email ? "you" : email.split("@")[0]) : "—",
          };
        }),
      );
      setPhase("ready");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }

  const env = envs.find((e) => e.key === envKey);
  const role = me ? members.find((m) => m.id === me.id)?.role : undefined;
  const canEdit = role === "admin" || (role === "editor" && !env?.protected);

  async function applyToggle(flagKey: string, next: boolean) {
    const row = rows.find((r) => r.flag.key === flagKey);
    if (!row || busy) return;
    setBusy(true);
    try {
      const updated = await apiPut<FlagConfig>(
        `/api/projects/${projectKey}/environments/${envKey}/flags/${flagKey}`,
        {
          expectedRevision: row.revision,
          enabled: next,
          offValue: row.offValue,
          rules: row.rules,
          fallthrough: row.fallthrough,
        },
      );
      setRows((rs) =>
        rs.map((r) =>
          r.flag.key === flagKey
            ? { ...r, enabled: updated.enabled, revision: updated.revision, updatedAt: updated.updated_at, author: "you" }
            : r,
        ),
      );
    } catch (e) {
      // A 409 means someone else edited first: reload that flag's truth.
      await load();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  function requestToggle(flagKey: string, next: boolean) {
    if (env?.protected) {
      setConfirm({ flagKey, next });
    } else {
      void applyToggle(flagKey, next);
    }
  }

  async function applyArchive(flagKey: string) {
    setBusy(true);
    try {
      await apiPatch(`/api/projects/${projectKey}/flags/${flagKey}`, { archived: true });
      setRows((rs) => rs.filter((r) => r.flag.key !== flagKey));
    } finally {
      setBusy(false);
      setArchive(null);
    }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (status === "enabled" && !r.enabled) return false;
      if (status === "disabled" && r.enabled) return false;
      if (type === "bool" && r.flag.type !== "bool") return false;
      if (type === "string" && r.flag.type !== "string") return false;
      if (
        needle &&
        !r.flag.key.toLowerCase().includes(needle) &&
        !(r.flag.description || "").toLowerCase().includes(needle)
      )
        return false;
      return true;
    });
    out = [...out].sort((a, b) => {
      if (sort === "name-asc") return a.flag.key.localeCompare(b.flag.key);
      if (sort === "name-desc") return b.flag.key.localeCompare(a.flag.key);
      return +new Date(b.updatedAt) - +new Date(a.updatedAt);
    });
    return out;
  }, [rows, q, status, type, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function openFlag(flagKey: string) {
    const sp = new URLSearchParams({ project: projectKey, env: envKey });
    router.push(`/flags/${encodeURIComponent(flagKey)}?${sp.toString()}`);
  }

  const initials = (me?.email || "?").slice(0, 2).toUpperCase();

  return (
    <div className={styles.shell}>
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className={styles.main}>
        <TopBar
          projects={projects}
          projectKey={projectKey}
          onProjectChange={(k) => void changeProject(k)}
          envs={envs}
          envKey={envKey}
          onEnvChange={(k) => void changeEnv(k)}
          userInitials={initials}
          onMenu={() => setNavOpen(true)}
        />
        <div className={styles.content}>
          <div className={styles.pageHead}>
            <div>
              <h1>Feature Flags</h1>
              <p>Create, manage, and control feature flags across your environments.</p>
            </div>
            <button
              type="button"
              className={styles.createButton}
              onClick={() => setCreateOpen(true)}
              disabled={!canEdit}
              title={!canEdit ? "You do not have permission to create flags." : undefined}
            >
              + Create flag
            </button>
          </div>

          <FilterBar
            q={q}
            status={status}
            type={type}
            sort={sort}
            disabled={phase === "ready" && rows.length === 0}
            onQ={(v) => {
              setQ(v);
              setPage(1);
            }}
            onStatus={(v) => {
              setStatus(v);
              setPage(1);
            }}
            onType={(v) => {
              setType(v);
              setPage(1);
            }}
            onSort={setSort}
          />

          <div className={styles.card}>
            {phase === "loading" && <TableSkeleton rows={6} />}
            {phase === "error" && (
              <ErrorCard message={loadError} onRetry={() => void load()} />
            )}
            {phase === "ready" && rows.length === 0 && (
              <EmptyState
                title="No feature flags yet"
                body="Create your first flag to start controlling releases."
                action={
                  canEdit ? (
                    <button
                      type="button"
                      className={styles.createButton}
                      onClick={() => setCreateOpen(true)}
                    >
                      Create flag
                    </button>
                  ) : undefined
                }
              />
            )}
            {phase === "ready" && rows.length > 0 && filtered.length === 0 && (
              <EmptyState
                title="No flags match your filters."
                body="Try a different search or clear the filters."
                action={
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    onClick={() => {
                      setQ("");
                      setStatus("all");
                      setType("all");
                      setPage(1);
                    }}
                  >
                    Clear filters
                  </button>
                }
              />
            )}
            {phase === "ready" && pageRows.length > 0 && (
              <>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Description</th>
                      <th scope="col">Type</th>
                      <th scope="col">Status</th>
                      <th scope="col">Last updated</th>
                      <th scope="col">
                        <span className={styles.visuallyHidden}>Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => (
                      <tr
                        key={r.flag.key}
                        className={styles.row}
                        onClick={() => openFlag(r.flag.key)}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") openFlag(r.flag.key);
                        }}
                        aria-label={`Open ${r.flag.key}`}
                      >
                        <td className={styles.cellName}>
                          <strong>{r.flag.key}</strong>
                        </td>
                        <td className={styles.cellDesc}>{r.flag.description || "—"}</td>
                        <td>
                          <TypeBadge kind={r.flag.type} />
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <Toggle
                            checked={r.enabled}
                            onChange={(next) => requestToggle(r.flag.key, next)}
                            label={`${r.enabled ? "Disable" : "Enable"} ${r.flag.key} in ${env?.name ?? envKey}`}
                            disabled={!canEdit}
                            disabledReason={
                              !canEdit
                                ? `You do not have permission to modify ${env?.name ?? envKey}.`
                                : undefined
                            }
                          />
                        </td>
                        <td className={styles.cellUpdated}>
                          <span>{timeAgo(r.updatedAt)}</span>
                          <small>by {r.author}</small>
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <RowMenu
                            flagKey={r.flag.key}
                            onOpen={() => openFlag(r.flag.key)}
                            onArchive={() => setArchive(r.flag.key)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Stacked cards for narrow screens: same data, no horizontal scroll. */}
                <div className={styles.cards}>
                  {pageRows.map((r) => (
                    <article
                      key={r.flag.key}
                      className={styles.flagCard}
                      onClick={() => openFlag(r.flag.key)}
                    >
                      <div className={styles.flagCardTop}>
                        <strong>{r.flag.key}</strong>
                        <span onClick={(e) => e.stopPropagation()}>
                          <Toggle
                            checked={r.enabled}
                            onChange={(next) => requestToggle(r.flag.key, next)}
                            label={`${r.enabled ? "Disable" : "Enable"} ${r.flag.key} in ${env?.name ?? envKey}`}
                            disabled={!canEdit}
                            disabledReason={
                              !canEdit
                                ? `You do not have permission to modify ${env?.name ?? envKey}.`
                                : undefined
                            }
                          />
                        </span>
                      </div>
                      {r.flag.description && (
                        <p className={styles.flagCardDesc}>{r.flag.description}</p>
                      )}
                      <div className={styles.flagCardMeta}>
                        <TypeBadge kind={r.flag.type} />
                        <span>
                          {timeAgo(r.updatedAt)} · by {r.author}
                        </span>
                        <span onClick={(e) => e.stopPropagation()}>
                          <RowMenu
                            flagKey={r.flag.key}
                            onOpen={() => openFlag(r.flag.key)}
                            onArchive={() => setArchive(r.flag.key)}
                          />
                        </span>
                      </div>
                    </article>
                  ))}
                </div>

                <Pagination
                  page={safePage}
                  totalPages={totalPages}
                  total={filtered.length}
                  pageSize={PAGE_SIZE}
                  onPage={setPage}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {createOpen && (
        <CreateFlagModal
          projectKey={projectKey}
          onClose={() => setCreateOpen(false)}
          onCreated={() => setCreateOpen(false)}
        />
      )}
      {confirm && env && (
        <ConfirmModal
          title={`${confirm.next ? "Turn on" : "Turn off"} ${confirm.flagKey} in ${env.name}?`}
          body={`This change affects the protected ${env.name} environment.`}
          confirmLabel={confirm.next ? "Turn on" : "Turn off"}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void applyToggle(confirm.flagKey, confirm.next)}
        />
      )}
      {archive && (
        <ConfirmModal
          title={`Archive ${archive}?`}
          body="Archived flags are hidden from SDKs and the flag list. You can unarchive them later; nothing is deleted."
          confirmLabel="Archive"
          busy={busy}
          onCancel={() => setArchive(null)}
          onConfirm={() => void applyArchive(archive)}
        />
      )}
    </div>
  );
}
