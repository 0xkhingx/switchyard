"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { ConfirmModal } from "@/components/Modal";
import { EmptyState, ErrorCard, TableSkeleton, Toggle, TypeBadge } from "@/components/controls";
import {
  ApiError,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  type Env,
  type Flag,
  type FlagConfig,
  type Me,
  type Member,
  type Project,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import {
  blankRule,
  firstMatchAllIndex,
  parseScalar,
  serveFromServer,
  serveToServer,
  type ConfigDraft,
} from "./draft";
import { FixedEditor, RuleCard } from "./editor";
import { TestPanel, type EvalResult } from "./TestPanel";
import styles from "../flags.module.css";

type Tab = "rules" | "settings" | "examples" | "activity";

interface SavedState {
  revision: number;
  draft: ConfigDraft;
  description: string;
  updatedAt: string;
  author: string;
}

interface AuditEvent {
  id: number;
  action: string;
  actor_email: string | null;
  before: unknown;
  after: unknown;
  created_at: string;
}

export function DetailClient({ flagKey }: { flagKey: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectKey, setProjectKey] = useState(params.get("project") ?? "");
  const [envs, setEnvs] = useState<Env[]>([]);
  const [envKey, setEnvKey] = useState(params.get("env") ?? "");
  const [members, setMembers] = useState<Member[]>([]);
  const [flag, setFlag] = useState<Flag | null>(null);
  const [savedByEnv, setSavedByEnv] = useState<Record<string, SavedState>>({});
  const [draftByEnv, setDraftByEnv] = useState<Record<string, ConfigDraft>>({});
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "missing">("loading");
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Tab>("rules");
  const [navOpen, setNavOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [archiveAsk, setArchiveAsk] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveErrors, setSaveErrors] = useState<{ path: string; message: string }[]>([]);
  const [savedFlash, setSavedFlash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [activity, setActivity] = useState<AuditEvent[] | null>(null);

  const loadEnv = useCallback(
    async (pkey: string, ekey: string, fkey: string, byId: Map<string, string>, myEmail: string) => {
      const cfg = await apiGet<FlagConfig>(
        `/api/projects/${pkey}/environments/${ekey}/flags/${fkey}`,
      );
      const kind = (await apiGet<Flag[]>(`/api/projects/${pkey}/flags`)).find(
        (f) => f.key === fkey,
      )?.type;
      const email = (cfg.updated_by && byId.get(cfg.updated_by)) || null;
      const draft: ConfigDraft = {
        enabled: cfg.enabled,
        offValue:
          typeof cfg.offValue === "boolean" ? String(cfg.offValue) : String(cfg.offValue ?? ""),
        rules: (cfg.rules as unknown[]).map((r) => {
          const rule = r as {
            id: string;
            conditions: { attribute: string; op: string; values: unknown[] }[];
            serve: { fixed?: unknown; rollout?: { value: unknown; weight: number }[] };
          };
          return {
            id: rule.id,
            conditions: rule.conditions.map((c) => ({
              attribute: c.attribute,
              op: c.op as ConfigDraft["rules"][number]["conditions"][number]["op"],
              values: c.values.map((v) =>
                typeof v === "boolean" ? String(v) : typeof v === "number" ? String(v) : String(v ?? ""),
              ),
            })),
            serve: serveFromServer(rule.serve, kind === "string" ? "string" : "bool"),
          };
        }),
        fallthrough: typeof cfg.fallthrough === "object" ? "" : String(cfg.fallthrough ?? ""),
      };
      // Fallthrough arrives as {fixed} — normalize to the raw value.
      const fall = cfg.fallthrough as { fixed?: unknown };
      draft.fallthrough =
        fall && typeof fall === "object" && "fixed" in fall
          ? String(
              typeof fall.fixed === "boolean" || typeof fall.fixed === "number"
                ? fall.fixed
                : (fall.fixed as string) ?? "",
            )
          : "";
      return {
        revision: cfg.revision,
        draft,
        updatedAt: cfg.updated_at,
        author: email ? (email === myEmail ? "you" : email.split("@")[0]) : "—",
      };
    },
    [],
  );

  const load = useCallback(async () => {
    setPhase("loading");
    setConflict(false);
    setSaveErrors([]);
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
        setPhase("missing");
        return;
      }
      setProjectKey(pkey);
      const [envList, flagList, memberList] = await Promise.all([
        apiGet<Env[]>(`/api/projects/${pkey}/environments`),
        apiGet<Flag[]>(`/api/projects/${pkey}/flags`),
        apiGet<Member[]>(`/api/projects/${pkey}/members`),
      ]);
      setEnvs(envList);
      setMembers(memberList);
      const found = flagList.find((f) => f.key === flagKey) ?? null;
      setFlag(found);
      if (!found || envList.length === 0) {
        setPhase(found ? "error" : "missing");
        if (found) setLoadError("This project has no environments yet.");
        return;
      }
      const ekey = params.get("env") || envList[0].key;
      setEnvKey(ekey);
      const byId = new Map(memberList.map((m) => [m.id, m.email] as const));
      const st = await loadEnv(pkey, ekey, flagKey, byId, meData.email);
      setSavedByEnv({ [ekey]: { ...st, description: found.description } });
      setDraftByEnv({ [ekey]: st.draft });
      setPhase("ready");
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) {
        if (e.status === 404) setPhase("missing");
        return;
      }
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }, [flagKey, params, loadEnv]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const env = envs.find((e) => e.key === envKey);
  const role = me ? members.find((m) => m.id === me.id)?.role : undefined;
  const canEdit = role === "admin" || (role === "editor" && !env?.protected);
  const kind = flag?.type === "string" ? "string" : "bool";

  const saved = envKey ? savedByEnv[envKey] : undefined;
  const draft = envKey ? draftByEnv[envKey] : undefined;

  const [description, setDescription] = useState("");
  useEffect(() => {
    if (saved) setDescription(saved.description);
  }, [saved, envKey]);

  const isDirty =
    !!saved &&
    !!draft &&
    (JSON.stringify(saved.draft) !== JSON.stringify(draft) ||
      saved.description !== description);

  async function switchEnv(next: string) {
    if (!projectKey || !flag) return;
    setEnvKey(next);
    if (savedByEnv[next]) return; // draft preserved per environment
    try {
      const byId = new Map(members.map((m) => [m.id, m.email] as const));
      const st = await loadEnv(projectKey, next, flagKey, byId, me?.email ?? "");
      setSavedByEnv((s) => ({ ...s, [next]: { ...st, description: flag.description } }));
      setDraftByEnv((d) => ({ ...d, [next]: st.draft }));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }

  function updateDraft(patch: Partial<ConfigDraft>) {
    if (!envKey || !draft) return;
    setDraftByEnv((d) => ({ ...d, [envKey]: { ...draft, ...patch } }));
    setConflict(false);
    setSaveErrors([]);
  }

  function moveRule(from: number, to: number) {
    if (!draft || from === to || to < 0 || to >= draft.rules.length) return;
    const rules = [...draft.rules];
    const [r] = rules.splice(from, 1);
    rules.splice(to, 0, r);
    updateDraft({ rules });
  }

  async function save() {
    if (!draft || !saved || !flag || !env || busy || !isDirty) return;
    // Client-side checks; the server re-validates and returns 422 details.
    const ids = draft.rules.map((r) => r.id.trim());
    if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
      setSaveErrors([{ path: "/rules/id", message: "Rule IDs must be non-empty and unique." }]);
      return;
    }
    setBusy(true);
    setSaveErrors([]);
    try {
      if (description !== saved.description) {
        await apiPatch(`/api/projects/${projectKey}/flags/${flagKey}`, { description });
      }
      const updated = await apiPut<FlagConfig>(
        `/api/projects/${projectKey}/environments/${envKey}/flags/${flagKey}`,
        {
          expectedRevision: saved.revision,
          enabled: draft.enabled,
          offValue: kind === "bool" ? parseScalar(draft.offValue) : draft.offValue,
          rules: draft.rules.map((r) => ({
            id: r.id.trim(),
            conditions: r.conditions.map((c) => ({
              attribute: c.attribute,
              op: c.op,
              values: c.values.map((v) => parseScalar(v)),
            })),
            serve: serveToServer(r.serve, kind),
          })),
          fallthrough: {
            fixed: kind === "bool" ? parseScalar(draft.fallthrough) : draft.fallthrough,
          },
        },
      );
      const byId = new Map(members.map((m) => [m.id, m.email] as const));
      const email = (updated.updated_by && byId.get(updated.updated_by)) || me?.email || null;
      const next: SavedState = {
        revision: updated.revision,
        draft: JSON.parse(JSON.stringify(draft)),
        description,
        updatedAt: updated.updated_at,
        author: email ? (email === me?.email ? "you" : email.split("@")[0]) : "—",
      };
      setSavedByEnv((s) => ({ ...s, [envKey]: next }));
      setFlag((f) => (f ? { ...f, description } : f));
      setConflict(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2500);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setConflict(true);
        return;
      }
      if (e instanceof ApiError && e.status === 422) {
        try {
          const parsed = JSON.parse(e.message) as { errors?: { path: string; message: string }[] };
          if (parsed.errors) {
            setSaveErrors(parsed.errors);
            return;
          }
        } catch {
          /* fall through to generic */
        }
      }
      setSaveErrors([{ path: "", message: e instanceof Error ? e.message : "Save failed." }]);
    } finally {
      setBusy(false);
    }
  }

  async function evaluate(
    ctx: { key: string; attributes: Record<string, unknown> },
  ): Promise<import("./TestPanel").EvalResult> {
    if (!draft || !flag) throw new Error("No draft loaded.");
    const body = await apiPost<{ value: boolean | string | null; reason: string; ruleId: string | null }>(
      "/api/evaluate",
      {
        config: {
          type: kind,
          enabled: draft.enabled,
          offValue: kind === "bool" ? parseScalar(draft.offValue) : draft.offValue,
          rules: draft.rules.map((r) => ({
            id: r.id.trim() || "rule",
            conditions: r.conditions.map((c) => ({
              attribute: c.attribute,
              op: c.op,
              values: c.values.map((v) => parseScalar(v)),
            })),
            serve: serveToServer(r.serve, kind),
          })),
          fallthrough: {
            fixed: kind === "bool" ? parseScalar(draft.fallthrough) : draft.fallthrough,
          },
        },
        flagKey,
        context: ctx,
      },
    );
    const matched = draft.rules.find((r) => r.id === body.ruleId);
    return { ...body, rollout: matched?.serve.mode === "rollout" };
  }

  async function loadActivity() {
    if (activity || !projectKey) return;
    try {
      const all = await apiGet<
        { id: number; flag_key: string | null; action: string; actor_email: string | null; before: unknown; after: unknown; created_at: string }[]
      >(`/api/projects/${projectKey}/audit?limit=100`);
      setActivity(all.filter((a) => a.flag_key === flagKey));
    } catch {
      setActivity([]);
    }
  }

  async function applyArchive(next: boolean) {
    setBusy(true);
    try {
      await apiPatch(`/api/projects/${projectKey}/flags/${flagKey}`, { archived: next });
      setFlag((f) => (f ? { ...f, archived: next } : f));
      if (next) router.push(`/flags?project=${projectKey}`);
    } finally {
      setBusy(false);
      setArchiveAsk(false);
      setMenuOpen(false);
    }
  }

  const unreachableFrom = draft ? firstMatchAllIndex(draft.rules) : -1;
  const initials = (me?.email || "?").slice(0, 2).toUpperCase();

  return (
    <div className={styles.shell}>
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className={styles.main}>
        <TopBar
          projects={projects}
          projectKey={projectKey}
          onProjectChange={(k) => router.push(`/flags?project=${k}`)}
          envs={envs}
          envKey={envKey}
          onEnvChange={(k) => void switchEnv(k)}
          userInitials={initials}
          onMenu={() => setNavOpen(true)}
        />
        <div className={styles.content}>
          {phase === "loading" && <TableSkeleton rows={6} />}
          {phase === "error" && <ErrorCard message={loadError} onRetry={() => void load()} />}
          {phase === "missing" && (
            <EmptyState title="Flag not found" body="It may have been archived or never existed." />
          )}
          {phase === "ready" && flag && draft && saved && env && (
            <>
              <nav className={styles.crumbs} aria-label="Breadcrumb">
                <Link href={`/flags?project=${projectKey}`}>Feature Flags</Link>
                <span aria-hidden="true"> / </span>
                <strong>{flagKey}</strong>
              </nav>

              <div className={styles.detailHead}>
                <div>
                  <div className={styles.detailTitleRow}>
                    <h1>{flagKey}</h1>
                    <TypeBadge kind={kind} />
                  </div>
                  <p className={styles.detailDesc}>{flag.description || "No description."}</p>
                </div>
                <div className={styles.detailActions}>
                  <span className={styles.enabledWrap}>
                    <Toggle
                      checked={draft.enabled}
                      onChange={(v) => updateDraft({ enabled: v })}
                      label={`${draft.enabled ? "Disable" : "Enable"} ${flagKey} in ${env.name}`}
                      disabled={!canEdit}
                      disabledReason={
                        !canEdit ? `You do not have permission to modify ${env.name}.` : undefined
                      }
                    />
                    <span>
                      <strong>{draft.enabled ? "Enabled" : "Disabled"}</strong>
                      <small> in {env.name}</small>
                    </span>
                  </span>
                  <span className={styles.menuWrap}>
                    <button
                      type="button"
                      className={styles.dotsButton}
                      aria-haspopup="menu"
                      aria-expanded={menuOpen}
                      aria-label={`Actions for ${flagKey}`}
                      onClick={() => setMenuOpen((v) => !v)}
                    >
                      •••
                    </button>
                    {menuOpen && (
                      <span className={styles.menu} role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          className={styles.menuItem}
                          onClick={() => {
                            setMenuOpen(false);
                            setArchiveAsk(true);
                          }}
                        >
                          {flag.archived ? "Unarchive flag" : "Archive flag"}
                        </button>
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    className={styles.createButton}
                    disabled={!isDirty || !canEdit || busy}
                    onClick={() => void save()}
                  >
                    {busy ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </div>
              {isDirty && <p className={styles.unsaved}>Unsaved changes</p>}
              {savedFlash && (
                <p className={styles.savedFlash} role="status">
                  Saved ✓
                </p>
              )}

              {!canEdit && (
                <p className={styles.readOnlyBanner} role="note">
                  {env.protected
                    ? `${env.name} is protected. You do not have permission to modify this environment.`
                    : "You do not have permission to modify this flag."}{" "}
                  The editor is read-only.
                </p>
              )}
              {conflict && (
                <div className={styles.conflictBanner} role="alert">
                  <p>
                    <strong>This flag was changed by someone else while you were editing.</strong>{" "}
                    Your draft is preserved; reloading replaces it with the latest version.
                  </p>
                  <button type="button" onClick={() => void load()} className={styles.createButton}>
                    Reload latest version
                  </button>
                </div>
              )}
              {saveErrors.length > 0 && (
                <div className={styles.saveErrors} role="alert">
                  {saveErrors.map((e, i) => (
                    <p key={i}>
                      {e.path ? `${e.path}: ` : ""}
                      {e.message}
                    </p>
                  ))}
                </div>
              )}

              <div className={styles.tabs} role="tablist" aria-label="Flag sections">
                {(["rules", "settings", "examples", "activity"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    className={`${styles.tab} ${tab === t ? styles.tabOn : ""}`}
                    onClick={() => {
                      setTab(t);
                      if (t === "activity") void loadActivity();
                    }}
                  >
                    {t === "rules"
                      ? "Rules"
                      : t === "settings"
                        ? "Settings"
                        : t === "examples"
                          ? "Code examples"
                          : "Activity"}
                  </button>
                ))}
              </div>

              <div className={styles.detailGrid}>
                <div className={styles.editorCol}>
                  {tab === "rules" && (
                    <>
                      <section className={styles.card} aria-label="Evaluation rules">
                        <div className={styles.rulesIntro}>
                          <h2>Evaluation rules</h2>
                          <p>Rules are evaluated from top to bottom. The first matching rule determines the flag value.</p>
                        </div>
                        {draft.rules.length === 0 && (
                          <EmptyState
                            title="No rules yet."
                            body="Add a rule or rely on the fallthrough value."
                            action={
                              !canEdit ? undefined : (
                                <button
                                  type="button"
                                  className={styles.createButton}
                                  onClick={() =>
                                    updateDraft({ rules: [...draft.rules, blankRule(kind)] })
                                  }
                                >
                                  + Add rule
                                </button>
                              )
                            }
                          />
                        )}
                        {draft.rules.map((rule, i) => (
                          <div key={rule.id}>
                            <RuleCard
                              rule={rule}
                              index={i}
                              kind={kind}
                              readOnly={!canEdit}
                              onChange={(next) =>
                                updateDraft({
                                  rules: draft.rules.map((r, j) => (j === i ? next : r)),
                                })
                              }
                              onDelete={() =>
                                updateDraft({ rules: draft.rules.filter((_, j) => j !== i) })
                              }
                              onMove={(dir) => moveRule(i, i + dir)}
                              dragHandlers={{
                                draggable: true,
                                dragging: dragIndex === i,
                                onDragStart: () => setDragIndex(i),
                                onDragOver: (e) => e.preventDefault(),
                                onDrop: () => {
                                  if (dragIndex !== null) moveRule(dragIndex, i);
                                  setDragIndex(null);
                                },
                              }}
                            />
                            {unreachableFrom !== -1 && i >= unreachableFrom && (
                              <p className={styles.unreachable} role="note">
                                Unreachable: rule {unreachableFrom + 1} above matches all remaining
                                users.
                              </p>
                            )}
                          </div>
                        ))}
                        {draft.rules.length > 0 && canEdit && (
                          <button
                            type="button"
                            className={styles.secondaryButton}
                            onClick={() => updateDraft({ rules: [...draft.rules, blankRule(kind)] })}
                          >
                            + Add rule
                          </button>
                        )}
                      </section>

                      <section className={styles.card} aria-label="Fallthrough">
                        <h2 className={styles.cardTitle}>Fallthrough</h2>
                        <p className={styles.cardSub}>Returned when no rule matches.</p>
                        {unreachableFrom !== -1 && (
                          <p className={styles.unreachable} role="note">
                            Unreachable: the rollout above matches all remaining users.
                          </p>
                        )}
                        <div className={unreachableFrom !== -1 ? styles.mutedBlock : undefined}>
                          <FixedEditor
                            value={draft.fallthrough}
                            kind={kind}
                            readOnly={!canEdit}
                            onChange={(fallthrough) => updateDraft({ fallthrough })}
                            label="Fallthrough value"
                          />
                        </div>
                      </section>
                    </>
                  )}

                  {tab === "settings" && (
                    <section className={styles.card} aria-label="Settings">
                      <h2 className={styles.cardTitle}>Settings</h2>
                      <div className={styles.modalField}>
                        <label htmlFor="flag-description">Description</label>
                        <input
                          id="flag-description"
                          type="text"
                          value={description}
                          disabled={!canEdit}
                          onChange={(e) => setDescription(e.target.value)}
                        />
                      </div>
                      <div className={styles.modalField}>
                        <label htmlFor="flag-type">Type</label>
                        <input id="flag-type" type="text" value={kind} disabled readOnly />
                        <p className={styles.modalHint}>Flag type is read-only after creation.</p>
                      </div>
                      <div className={styles.modalField}>
                        <label>Off value</label>
                        <p className={styles.modalHint}>Returned when this flag is disabled.</p>
                        <FixedEditor
                          value={draft.offValue}
                          kind={kind}
                          readOnly={!canEdit}
                          onChange={(offValue) => updateDraft({ offValue })}
                          label="Off value"
                        />
                      </div>
                      <div className={styles.modalField}>
                        <button
                          type="button"
                          className={styles.secondaryButton}
                          style={{ marginTop: 0 }}
                          disabled={!canEdit}
                          onClick={() => setArchiveAsk(true)}
                        >
                          {flag.archived ? "Unarchive flag" : "Archive flag"}
                        </button>
                      </div>
                    </section>
                  )}

                  {tab === "examples" && (
                    <section className={styles.card} aria-label="Code examples">
                      <h2 className={styles.cardTitle}>Code examples</h2>
                      <p className={styles.cardSub}>
                        The actual @switchyard/sdk calls for this flag.
                      </p>
                      <pre className={styles.codeBlock}>
                        {kind === "bool"
                          ? `import { createClient } from "@switchyard/sdk";

const client = createClient({ sdkKey: "sy_...", baseUrl: "https://flags.example.com" });
await client.ready();

const enabled = client.boolVariation(
  "${flagKey}",
  { key: user.id, attributes: { country: "NG" } },
  false
);`
                          : `import { createClient } from "@switchyard/sdk";

const client = createClient({ sdkKey: "sy_...", baseUrl: "https://flags.example.com" });
await client.ready();

const variant = client.stringVariation(
  "${flagKey}",
  { key: user.id, attributes: { country: "NG" } },
  "default"
);`}
                      </pre>
                    </section>
                  )}

                  {tab === "activity" && (
                    <section className={styles.card} aria-label="Activity">
                      <h2 className={styles.cardTitle}>Activity</h2>
                      {activity === null && <p className={styles.cardSub}>Loading…</p>}
                      {activity !== null && activity.length === 0 && (
                        <p className={styles.cardSub}>No changes recorded for this flag yet.</p>
                      )}
                      {activity !== null && activity.length > 0 && (
                        <ul className={styles.activityList}>
                          {activity.map((a) => (
                            <li key={a.id}>
                              <strong>{a.action}</strong> ·{" "}
                              {a.actor_email ? a.actor_email.split("@")[0] : "unknown"} ·{" "}
                              {timeAgo(a.created_at)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  )}
                </div>

                <div className={styles.testCol}>
                  <div className={styles.sticky}>
                    <TestPanel flagKey={flagKey} readOnly={!canEdit} onEvaluate={evaluate} />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {archiveAsk && (
        <ConfirmModal
          title={`${flag?.archived ? "Unarchive" : "Archive"} ${flagKey}?`}
          body={
            flag?.archived
              ? "Unarchiving makes this flag visible again."
              : "Archived flags are hidden from SDKs and the flag list. Nothing is deleted."
          }
          confirmLabel={flag?.archived ? "Unarchive" : "Archive"}
          busy={busy}
          onCancel={() => {
            setArchiveAsk(false);
            setMenuOpen(false);
          }}
          onConfirm={() => void applyArchive(!flag?.archived)}
        />
      )}
    </div>
  );
}
