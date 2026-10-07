"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, Fragment } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { EmptyState, ErrorCard, TableSkeleton } from "@/components/controls";
import {
  ApiError,
  apiGet,
  apiGetPaged,
  type Env,
  type Flag,
  type Me,
  type Member,
  type Project,
} from "@/lib/api";
import {
  CATEGORY_LABEL,
  actorName,
  categorize,
  diffLines,
  initials,
  summarize,
  type AuditEvent,
} from "@/lib/audit";
import { timeAgo } from "@/lib/format";
import styles from "./audit.module.css";

const PAGE_SIZE = 8;

type ActionFilter =
  | "all"
  | "created"
  | "updated"
  | "enabled"
  | "disabled"
  | "archived"
  | "sdk_key_created"
  | "sdk_key_revoked";

const ACTIONS: { value: ActionFilter; label: string }[] = [
  { value: "all", label: "All actions" },
  { value: "created", label: "Created" },
  { value: "updated", label: "Updated" },
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
  { value: "archived", label: "Archived" },
  { value: "sdk_key_created", label: "SDK key created" },
  { value: "sdk_key_revoked", label: "SDK key revoked" },
];

const SINCE: { value: string; label: string; hours: number }[] = [
  { value: "24h", label: "Last 24 hours", hours: 24 },
  { value: "7d", label: "Last 7 days", hours: 24 * 7 },
  { value: "30d", label: "Last 30 days", hours: 24 * 30 },
];

export function AuditClient() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectKey, setProjectKey] = useState(params.get("project") ?? "");
  const [envs, setEnvs] = useState<Env[]>([]);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");

  const [q, setQ] = useState(params.get("q") ?? "");
  const [envFilter, setEnvFilter] = useState(params.get("env") ?? "all");
  const [action, setAction] = useState<ActionFilter>(
    (params.get("action") as ActionFilter) || "all",
  );
  const [flagFilter, setFlagFilter] = useState(params.get("flag") ?? "all");
  const [actor, setActor] = useState(params.get("actor") ?? "all");
  const [since, setSince] = useState(params.get("since") ?? "30d");
  const [page, setPage] = useState(Number(params.get("page")) || 1);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  const fetchPage = useCallback(
    async (
      pkey: string,
      opts: {
        q: string;
        env: string;
        action: ActionFilter;
        flag: string;
        actor: string;
        since: string;
        page: number;
      },
    ) => {
      const sp = new URLSearchParams();
      sp.set("limit", String(PAGE_SIZE));
      sp.set("offset", String((opts.page - 1) * PAGE_SIZE));
      if (opts.env !== "all") {
        const env = envs.find((e) => e.key === opts.env);
        if (env) sp.set("environment_id", env.id);
      }
      if (opts.flag !== "all") sp.set("flag_key", opts.flag);
      if (opts.action !== "all") sp.set("category", opts.action);
      if (opts.actor !== "all") sp.set("actor", opts.actor);
      const preset = SINCE.find((s) => s.value === opts.since) ?? SINCE[2];
      sp.set("since", new Date(Date.now() - preset.hours * 3600 * 1000).toISOString());
      if (opts.q.trim()) sp.set("q", opts.q.trim());
      return apiGetPaged<AuditEvent[]>(`/api/projects/${pkey}/audit?${sp.toString()}`);
    },
    [envs],
  );

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
      setPhase("ready");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }, [params]);

  // Fetch the current page whenever project/filters/page change (after bootstrap).
  useEffect(() => {
    if (phase !== "ready" || !projectKey) return;
    let live = true;
    fetchPage(projectKey, { q, env: envFilter, action, flag: flagFilter, actor, since, page })
      .then(({ data, total: t }) => {
        if (!live) return;
        setEvents(data);
        setTotal(t);
        setExpanded(null);
        setShowJson(false);
      })
      .catch((e) => {
        if (!live) return;
        setLoadError(e instanceof Error ? e.message : "Something went wrong.");
        setPhase("error");
      });
    return () => {
      live = false;
    };
  }, [phase, projectKey, q, envFilter, action, flagFilter, actor, since, page, fetchPage]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep filters shareable in the URL.
  useEffect(() => {
    const sp = new URLSearchParams();
    if (projectKey) sp.set("project", projectKey);
    if (envFilter !== "all") sp.set("env", envFilter);
    if (action !== "all") sp.set("action", action);
    if (flagFilter !== "all") sp.set("flag", flagFilter);
    if (actor !== "all") sp.set("actor", actor);
    if (since !== "30d") sp.set("since", since);
    if (q) sp.set("q", q);
    if (page !== 1) sp.set("page", String(page));
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  }, [projectKey, envFilter, action, flagFilter, actor, since, q, page, pathname, router]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const from = total === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const to = Math.min(safePage * PAGE_SIZE, total);

  function pageNumbers(): number[] {
    const out: number[] = [];
    const start = Math.max(1, Math.min(safePage - 2, totalPages - 4));
    for (let p = start; p <= Math.min(totalPages, start + 4); p++) out.push(p);
    return out;
  }

  const envById = new Map(envs.map((e) => [e.id, e]));
  const myInitials = initials(me?.email ?? null);
  const filtering =
    q.trim() !== "" ||
    envFilter !== "all" ||
    action !== "all" ||
    flagFilter !== "all" ||
    actor !== "all" ||
    since !== "30d";

  function clearFilters() {
    setQ("");
    setEnvFilter("all");
    setAction("all");
    setFlagFilter("all");
    setActor("all");
    setSince("30d");
    setPage(1);
  }

  function exactTime(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
  }

  return (
    <div className={styles.shell}>
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className={styles.main}>
        <TopBar
          projects={projects}
          projectKey={projectKey}
          onProjectChange={(k) => {
            setProjectKey(k);
            setPage(1);
            setEnvs([]);
            setFlags([]);
            setMembers([]);
            setEvents([]);
            setPhase("loading");
            // Re-bootstrap option lists for the new project.
            apiGet<Env[]>(`/api/projects/${k}/environments`).then(setEnvs).catch(() => {});
            apiGet<Flag[]>(`/api/projects/${k}/flags`).then(setFlags).catch(() => {});
            apiGet<Member[]>(`/api/projects/${k}/members`)
              .then((m) => {
                setMembers(m);
                setPhase("ready");
              })
              .catch(() => {});
          }}
          envs={[]}
          envKey=""
          onEnvChange={() => {}}
          showEnv={false}
          userInitials={myInitials}
          onMenu={() => setNavOpen(true)}
        />
        <div className={styles.content}>
          <div className={styles.pageHead}>
            <h1>Audit Log</h1>
            <p>Track changes to your feature flags across all environments.</p>
          </div>

          <div className={styles.filters}>
            <div className={styles.searchWrap}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <label className={styles.visuallyHidden} htmlFor="audit-search">
                Search events
              </label>
              <input
                id="audit-search"
                type="search"
                placeholder="Search events…"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <label className={styles.filterWrap}>
              <span className={styles.visuallyHidden}>Filter by environment</span>
              <select
                value={envFilter}
                onChange={(e) => {
                  setEnvFilter(e.target.value);
                  setPage(1);
                }}
                aria-label="Filter by environment"
              >
                <option value="all">All environments</option>
                {envs.map((e) => (
                  <option key={e.key} value={e.key}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.filterWrap}>
              <span className={styles.visuallyHidden}>Filter by action</span>
              <select
                value={action}
                onChange={(e) => {
                  setAction(e.target.value as typeof action);
                  setPage(1);
                }}
                aria-label="Filter by action"
              >
                {ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.filterWrap}>
              <span className={styles.visuallyHidden}>Filter by flag</span>
              <select
                value={flagFilter}
                onChange={(e) => {
                  setFlagFilter(e.target.value);
                  setPage(1);
                }}
                aria-label="Filter by flag"
              >
                <option value="all">All flags</option>
                {flags.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.key}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.filterWrap}>
              <span className={styles.visuallyHidden}>Filter by user</span>
              <select
                value={actor}
                onChange={(e) => {
                  setActor(e.target.value);
                  setPage(1);
                }}
                aria-label="Filter by user"
              >
                <option value="all">All users</option>
                {members.map((m) => (
                  <option key={m.id} value={m.email}>
                    {m.email}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.filterWrap}>
              <span className={styles.visuallyHidden}>Date range</span>
              <select
                value={since}
                onChange={(e) => {
                  setSince(e.target.value);
                  setPage(1);
                }}
                aria-label="Date range"
              >
                {SINCE.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={styles.card}>
            {phase === "loading" && <TableSkeleton rows={6} />}
            {phase === "error" && <ErrorCard message={loadError} onRetry={() => void load()} />}
            {phase === "ready" && total === 0 && !filtering && (
              <EmptyState
                title="No audit activity yet"
                body="Changes to flags and project configuration will appear here."
              />
            )}
            {phase === "ready" && total === 0 && filtering && (
              <EmptyState
                title="No events match your filters."
                body="Try a different search or clear the filters."
                action={
                  <button type="button" className={styles.secondaryButton} onClick={clearFilters}>
                    Clear filters
                  </button>
                }
              />
            )}
            {phase === "ready" && events.length > 0 && (
              <>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Actor</th>
                      <th scope="col">Action</th>
                      <th scope="col">Flag</th>
                      <th scope="col">Environment</th>
                      <th scope="col">Summary</th>
                      <th scope="col">
                        <span className={styles.visuallyHidden}>Details</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((e) => {
                      const cat = categorize(e) as keyof typeof CATEGORY_LABEL;
                      const env = e.environment_id ? envById.get(e.environment_id) : undefined;
                      const isOpen = expanded === e.id;
                      return (
                        <Fragment key={e.id}>
                          <tr
                            key={e.id}
                            className={`${styles.row} ${isOpen ? styles.rowOpen : ""}`}
                            onClick={() => {
                              setExpanded(isOpen ? null : e.id);
                              setShowJson(false);
                            }}
                            tabIndex={0}
                            onKeyDown={(ev) => {
                              if (ev.key === "Enter" || ev.key === " ") {
                                ev.preventDefault();
                                setExpanded(isOpen ? null : e.id);
                                setShowJson(false);
                              }
                            }}
                            aria-label={`Event ${e.id}, ${summarize(e)}`}
                          >
                            <td className={styles.cellTime} title={exactTime(e.created_at)}>
                              {timeAgo(e.created_at)}
                            </td>
                            <td>
                              <span className={styles.actor}>
                                <span className={styles.actorAvatar} aria-hidden="true">
                                  {initials(e.actor_email)}
                                </span>
                                {actorName(e.actor_email, me?.email)}
                              </span>
                            </td>
                            <td>
                              <ActionBadge category={cat} />
                            </td>
                            <td className={styles.cellFlag}>
                              {e.flag_key ? (
                                <Link
                                  href={`/flags/${encodeURIComponent(e.flag_key)}?project=${projectKey}`}
                                  onClick={(e2) => e2.stopPropagation()}
                                >
                                  {e.flag_key}
                                </Link>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>
                              <EnvBadge name={env?.name} envKey={env?.key} protected={env?.protected} />
                            </td>
                            <td className={styles.cellSummary}>{summarize(e)}</td>
                            <td>
                              <button
                                type="button"
                                className={styles.chevButton}
                                aria-expanded={isOpen}
                                aria-label={`${isOpen ? "Collapse" : "Expand"} event details`}
                                onClick={(e2) => {
                                  e2.stopPropagation();
                                  setExpanded(isOpen ? null : e.id);
                                  setShowJson(false);
                                }}
                              >
                                {isOpen ? "▾" : "›"}
                              </button>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr key={`${e.id}-details`} className={styles.detailsRow}>
                              <td colSpan={7}>
                                <div className={styles.details}>
                                  <div className={styles.metaCol}>
                                    <h3>Metadata</h3>
                                    <dl>
                                      <div>
                                        <dt>Time</dt>
                                        <dd>{exactTime(e.created_at)}</dd>
                                      </div>
                                      <div>
                                        <dt>Actor</dt>
                                        <dd>
                                          {actorName(e.actor_email, me?.email)}
                                          {e.actor_email && <small>{e.actor_email}</small>}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt>Action</dt>
                                        <dd>{CATEGORY_LABEL[cat] ?? e.action}</dd>
                                      </div>
                                      {e.flag_key && (
                                        <div>
                                          <dt>Flag</dt>
                                          <dd>{e.flag_key}</dd>
                                        </div>
                                      )}
                                      {env && (
                                        <div>
                                          <dt>Environment</dt>
                                          <dd>{env.name}</dd>
                                        </div>
                                      )}
                                    </dl>
                                  </div>
                                  <div className={styles.changesCol}>
                                    <h3>Changes</h3>
                                    <ChangeDiff event={e} />
                                    {(e.before || e.after) && (
                                      <>
                                        <button
                                          type="button"
                                          className={styles.jsonToggle}
                                          aria-expanded={showJson}
                                          onClick={() => setShowJson((v) => !v)}
                                        >
                                          {showJson ? "▾" : "›"} Full configuration diff (JSON)
                                        </button>
                                        {showJson && (
                                          <pre className={styles.jsonBlock}>
                                            {JSON.stringify({ before: e.before, after: e.after }, null, 2)}
                                          </pre>
                                        )}
                                      </>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>

                <div className={styles.cards}>
                  {events.map((e) => {
                    const cat = categorize(e) as keyof typeof CATEGORY_LABEL;
                    const env = e.environment_id ? envById.get(e.environment_id) : undefined;
                    const isOpen = expanded === e.id;
                    return (
                      <article key={e.id} className={`${styles.eventCard} ${isOpen ? styles.rowOpen : ""}`}>
                        <div
                          className={styles.eventCardTop}
                          onClick={() => {
                            setExpanded(isOpen ? null : e.id);
                            setShowJson(false);
                          }}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              setExpanded(isOpen ? null : e.id);
                              setShowJson(false);
                            }
                          }}
                          aria-expanded={isOpen}
                          aria-label={`Event ${e.id}, ${summarize(e)}`}
                        >
                          <span title={exactTime(e.created_at)}>{timeAgo(e.created_at)}</span>
                          <span className={styles.actor}>
                            <span className={styles.actorAvatar} aria-hidden="true">
                              {initials(e.actor_email)}
                            </span>
                            {actorName(e.actor_email, me?.email)}
                          </span>
                          <ActionBadge category={cat} />
                        </div>
                        <div className={styles.eventCardMeta}>
                          <span>{e.flag_key ?? "—"}</span>
                          <EnvBadge name={env?.name} envKey={env?.key} protected={env?.protected} />
                          <button
                            type="button"
                            className={styles.chevButton}
                            aria-expanded={isOpen}
                            aria-label={`${isOpen ? "Collapse" : "Expand"} event details`}
                            onClick={() => {
                              setExpanded(isOpen ? null : e.id);
                              setShowJson(false);
                            }}
                          >
                            {isOpen ? "▾" : "›"}
                          </button>
                        </div>
                        <p className={styles.eventCardSummary}>{summarize(e)}</p>
                        {isOpen && (
                          <div className={styles.detailsStacked}>
                            <dl className={styles.metaList}>
                              <div>
                                <dt>Time</dt>
                                <dd>{exactTime(e.created_at)}</dd>
                              </div>
                              {e.actor_email && (
                                <div>
                                  <dt>Actor</dt>
                                  <dd>{e.actor_email}</dd>
                                </div>
                              )}
                            </dl>
                            <ChangeDiff event={e} />
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>

                <div className={styles.pagination}>
                  <span>
                    Showing {from}–{to} of {total} events
                  </span>
                  <span className={styles.pageButtons}>
                    <button
                      type="button"
                      className={styles.pageButton}
                      disabled={safePage <= 1}
                      onClick={() => setPage(safePage - 1)}
                      aria-label="Previous page"
                    >
                      ‹
                    </button>
                    {pageNumbers().map((p) => (
                      <button
                        key={p}
                        type="button"
                        className={p === safePage ? styles.pageCurrent : styles.pageButton}
                        aria-current={p === safePage ? "page" : undefined}
                        aria-label={`Page ${p}`}
                        onClick={() => setPage(p)}
                      >
                        {p}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={styles.pageButton}
                      disabled={safePage >= totalPages}
                      onClick={() => setPage(safePage + 1)}
                      aria-label="Next page"
                    >
                      ›
                    </button>
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ActionBadge({ category }: { category: keyof typeof CATEGORY_LABEL }) {
  return (
    <span className={`${styles.badge} ${styles[`badge_${category}`] ?? ""}`}>
      {CATEGORY_LABEL[category] ?? category}
    </span>
  );
}

function EnvBadge({
  name,
  envKey,
  protected: isProtected,
}: {
  name?: string;
  envKey?: string;
  protected?: boolean;
}) {
  if (!name) return <span className={styles.mutedDash}>—</span>;
  const tone = envKey?.includes("prod")
    ? styles.envProd
    : envKey?.includes("stag")
      ? styles.envStag
      : styles.envDev;
  return (
    <span className={`${styles.envBadge} ${tone}`}>
      <span className={styles.envDot} aria-hidden="true" />
      {name}
      {isProtected && (
        <span aria-label="Protected environment" title="Protected environment">
          🔒
        </span>
      )}
    </span>
  );
}

function ChangeDiff({ event }: { event: AuditEvent }) {
  const lines = diffLines(event);
  if (lines.length === 0) {
    return <p className={styles.noDiff}>No field-level changes recorded.</p>;
  }
  return (
    <ul className={styles.diffList}>
      {lines.map((l, i) => (
        <li
          key={i}
          className={
            l.kind === "add" ? styles.diffAdd : l.kind === "del" ? styles.diffDel : styles.diffCtx
          }
        >
          {l.kind === "add" ? "+ " : l.kind === "del" ? "− " : ""}
          {l.text}
        </li>
      ))}
    </ul>
  );
}
