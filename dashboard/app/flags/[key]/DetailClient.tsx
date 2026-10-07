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
  apiPut,
  type Env,
  type Flag,
  type FlagConfig,
  type Me,
  type Member,
  type Project,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import styles from "../flags.module.css";

interface EnvState {
  env: Env;
  enabled: boolean;
  revision: number;
  offValue: boolean | string;
  rules: unknown[];
  fallthrough: unknown;
  updatedAt: string;
  author: string;
}

export function DetailClient({ flagKey }: { flagKey: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectKey, setProjectKey] = useState(params.get("project") ?? "");
  const [envs, setEnvs] = useState<Env[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [flag, setFlag] = useState<Flag | null>(null);
  const [states, setStates] = useState<EnvState[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "missing">("loading");
  const [loadError, setLoadError] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ envKey: string; next: boolean } | null>(null);
  const [archiveAsk, setArchiveAsk] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setPhase("loading");
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
      if (!found) {
        setPhase("missing");
        return;
      }
      const byId = new Map(memberList.map((m) => [m.id, m.email] as const));
      const cfgs = await Promise.all(
        envList.map((e) =>
          apiGet<FlagConfig>(`/api/projects/${pkey}/environments/${e.key}/flags/${flagKey}`),
        ),
      );
      setStates(
        envList.map((e, i) => {
          const cfg = cfgs[i];
          const email = (cfg.updated_by && byId.get(cfg.updated_by)) || null;
          return {
            env: e,
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
      if (e instanceof ApiError && e.status === 401) return;
      if (e instanceof ApiError && e.status === 404) {
        setPhase("missing");
        return;
      }
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }, [flagKey, params]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const role = me ? members.find((m) => m.id === me.id)?.role : undefined;
  const canEditEnv = (env: Env) => role === "admin" || (role === "editor" && !env.protected);

  async function applyToggle(envKey: string, next: boolean) {
    const st = states.find((s) => s.env.key === envKey);
    if (!st || busy) return;
    setBusy(true);
    try {
      const updated = await apiPut<FlagConfig>(
        `/api/projects/${projectKey}/environments/${envKey}/flags/${flagKey}`,
        {
          expectedRevision: st.revision,
          enabled: next,
          offValue: st.offValue,
          rules: st.rules,
          fallthrough: st.fallthrough,
        },
      );
      setStates((ss) =>
        ss.map((s) =>
          s.env.key === envKey
            ? { ...s, enabled: updated.enabled, revision: updated.revision, updatedAt: updated.updated_at, author: "you" }
            : s,
        ),
      );
    } catch {
      await load();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function applyArchive(next: boolean) {
    setBusy(true);
    try {
      await apiPatch(`/api/projects/${projectKey}/flags/${flagKey}`, { archived: next });
      setFlag((f) => (f ? { ...f, archived: next } : f));
    } finally {
      setBusy(false);
      setArchiveAsk(false);
    }
  }

  const project = projects.find((p) => p.key === projectKey);
  const initials = (me?.email || "?").slice(0, 2).toUpperCase();

  return (
    <div className={styles.shell}>
      <Sidebar projectName={project?.name ?? "…"} open={navOpen} onClose={() => setNavOpen(false)} />
      <div className={styles.main}>
        <TopBar
          projects={projects}
          projectKey={projectKey}
          onProjectChange={(k) => {
            const sp = new URLSearchParams({ project: k });
            router.push(`/flags?${sp.toString()}`);
          }}
          envs={envs}
          envKey=""
          onEnvChange={() => {}}
          showEnv={false}
          userInitials={initials}
          onMenu={() => setNavOpen(true)}
        />
        <div className={styles.content}>
          <Link className={styles.backLink} href={`/flags?project=${projectKey}`}>
            ← All flags
          </Link>
          {phase === "loading" && <TableSkeleton rows={5} />}
          {phase === "error" && <ErrorCard message={loadError} onRetry={() => void load()} />}
          {phase === "missing" && (
            <EmptyState title="Flag not found" body="It may have been archived or never existed." />
          )}
          {phase === "ready" && flag && (
            <>
              <div className={styles.pageHead}>
                <div>
                  <h1>{flag.key}</h1>
                  <p>{flag.description || "No description."}</p>
                </div>
                <TypeBadge kind={flag.type} />
              </div>
              <div className={styles.card}>
                {states.map((s) => (
                  <div key={s.env.key} className={styles.envRow}>
                    <span className={styles.envMeta}>
                      <strong>{s.env.name}</strong>
                      {s.env.protected && <small>Protected</small>}
                      <small>
                        rev {s.revision} · {s.rules.length} rule{s.rules.length === 1 ? "" : "s"} ·{" "}
                        {timeAgo(s.updatedAt)} by {s.author}
                      </small>
                    </span>
                    <Toggle
                      checked={s.enabled}
                      onChange={(next) =>
                        s.env.protected
                          ? setConfirm({ envKey: s.env.key, next })
                          : void applyToggle(s.env.key, next)
                      }
                      label={`${s.enabled ? "Disable" : "Enable"} ${flag.key} in ${s.env.name}`}
                      disabled={!canEditEnv(s.env)}
                      disabledReason={
                        !canEditEnv(s.env)
                          ? `You do not have permission to modify ${s.env.name}.`
                          : undefined
                      }
                    />
                  </div>
                ))}
                <div className={styles.envRow}>
                  <span className={styles.envMeta}>
                    <small>{flag.archived ? "This flag is archived." : "Archive hides it from SDKs."}</small>
                  </span>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    style={{ marginTop: 0 }}
                    disabled={role !== "admin" && role !== "editor"}
                    onClick={() =>
                      flag.archived ? void applyArchive(false) : setArchiveAsk(true)
                    }
                  >
                    {flag.archived ? "Unarchive" : "Archive"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
      {confirm && (
        <ConfirmModal
          title={`Turn ${confirm.next ? "on" : "off"} ${flagKey} in ${
            states.find((s) => s.env.key === confirm.envKey)?.env.name ?? confirm.envKey
          }?`}
          body="This change affects a protected environment."
          confirmLabel={confirm.next ? "Turn on" : "Turn off"}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void applyToggle(confirm.envKey, confirm.next)}
        />
      )}
      {archiveAsk && (
        <ConfirmModal
          title={`Archive ${flagKey}?`}
          body="Archived flags are hidden from SDKs and the flag list. Nothing is deleted."
          confirmLabel="Archive"
          busy={busy}
          onCancel={() => setArchiveAsk(false)}
          onConfirm={() => void applyArchive(true)}
        />
      )}
    </div>
  );
}
