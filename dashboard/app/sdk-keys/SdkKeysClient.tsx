"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { ConfirmModal, Modal } from "@/components/Modal";
import { EmptyState, ErrorCard, TableSkeleton } from "@/components/controls";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPost,
  type Env,
  type Me,
  type Member,
  type Project,
  type SdkKey,
  type SdkKeyCreated,
} from "@/lib/api";
import { timeAgo } from "@/lib/format";
import styles from "./sdkkeys.module.css";

export function SdkKeysClient() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [me, setMe] = useState<Me | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectKey, setProjectKey] = useState(params.get("project") ?? "");
  const [envs, setEnvs] = useState<Env[]>([]);
  const [envKey, setEnvKey] = useState(params.get("env") ?? "");
  const [members, setMembers] = useState<Member[]>([]);
  const [keys, setKeys] = useState<SdkKey[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [q, setQ] = useState(params.get("q") ?? "");
  const [navOpen, setNavOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [revokeAsk, setRevokeAsk] = useState<SdkKey | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sp = new URLSearchParams();
    if (projectKey) sp.set("project", projectKey);
    if (envKey) sp.set("env", envKey);
    if (q) sp.set("q", q);
    router.replace(`${pathname}?${sp.toString()}`, { scroll: false });
  }, [projectKey, envKey, q, pathname, router]);

  const loadKeys = useCallback(async (pkey: string, ekey: string) => {
    const list = await apiGet<SdkKey[]>(`/api/projects/${pkey}/environments/${ekey}/sdk-keys`);
    setKeys(list);
    setSelectedId((prev) => (prev && list.some((k) => k.id === prev) ? prev : (list[0]?.id ?? null)));
  }, []);

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
      const [envList, memberList] = await Promise.all([
        apiGet<Env[]>(`/api/projects/${pkey}/environments`),
        apiGet<Member[]>(`/api/projects/${pkey}/members`),
      ]);
      setEnvs(envList);
      setMembers(memberList);
      const ekey = params.get("env") || envList[0]?.key || "";
      setEnvKey(ekey);
      if (ekey) await loadKeys(pkey, ekey);
      setPhase("ready");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return;
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }, [params, loadKeys]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function changeProject(next: string) {
    setProjectKey(next);
    setKeys([]);
    setSelectedId(null);
    setPhase("loading");
    try {
      const [envList, memberList] = await Promise.all([
        apiGet<Env[]>(`/api/projects/${next}/environments`),
        apiGet<Member[]>(`/api/projects/${next}/members`),
      ]);
      setEnvs(envList);
      setMembers(memberList);
      const ekey = envList[0]?.key || "";
      setEnvKey(ekey);
      if (ekey) await loadKeys(next, ekey);
      setPhase("ready");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }

  async function changeEnv(next: string) {
    setEnvKey(next);
    setSelectedId(null);
    if (!projectKey) return;
    try {
      await loadKeys(projectKey, next);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Something went wrong.");
      setPhase("error");
    }
  }

  async function applyRevoke(key: SdkKey) {
    setBusy(true);
    try {
      await apiDelete(`/api/projects/${projectKey}/environments/${envKey}/sdk-keys/${key.id}`);
      await loadKeys(projectKey, envKey);
    } finally {
      setBusy(false);
      setRevokeAsk(null);
    }
  }

  const env = envs.find((e) => e.key === envKey);
  const role = me ? members.find((m) => m.id === me.id)?.role : undefined;
  // The backend restricts key management to project admins in every environment.
  const canManage = role === "admin";
  const byId = new Map(members.map((m) => [m.id, m.email] as const));
  const creatorName = (id: string | null) => {
    if (!id) return "—";
    const email = byId.get(id);
    if (!email) return "—";
    return email === me?.email ? "you" : email.split("@")[0];
  };

  const needle = q.trim().toLowerCase();
  const filtered = keys.filter(
    (k) =>
      !needle ||
      k.name.toLowerCase().includes(needle) ||
      k.prefix.toLowerCase().includes(needle),
  );
  const selected = keys.find((k) => k.id === selectedId) ?? null;
  const initials = (me?.email || "?").slice(0, 2).toUpperCase();

  function exactTime(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  }

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
              <h1>SDK Keys</h1>
              <p>Manage SDK keys for secure access to your feature flags.</p>
            </div>
            <button
              type="button"
              className={styles.createButton}
              onClick={() => setCreateOpen(true)}
              disabled={!canManage}
              title={!canManage ? "Only project admins can manage SDK keys." : undefined}
            >
              + Create SDK key
            </button>
          </div>
          {!canManage && phase === "ready" && (
            <p className={styles.permNote} role="note">
              {env?.protected
                ? `${env.name} is protected. `
                : ""}
              Only project admins can manage SDK keys.
            </p>
          )}

          <div className={styles.grid}>
            <div className={styles.listCol}>
              <div className={styles.card}>
                <div className={styles.searchWrap}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <label className={styles.visuallyHidden} htmlFor="key-search">
                    Search keys
                  </label>
                  <input
                    id="key-search"
                    type="search"
                    placeholder="Search keys…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>

                {phase === "loading" && <TableSkeleton rows={5} />}
                {phase === "error" && <ErrorCard message={loadError} onRetry={() => void load()} />}
                {phase === "ready" && keys.length === 0 && (
                  <EmptyState
                    title="No SDK keys yet"
                    body="Create an SDK key to connect your application to Switchyard."
                    action={
                      canManage ? (
                        <button
                          type="button"
                          className={styles.createButton}
                          onClick={() => setCreateOpen(true)}
                        >
                          Create SDK key
                        </button>
                      ) : undefined
                    }
                  />
                )}
                {phase === "ready" && keys.length > 0 && filtered.length === 0 && (
                  <EmptyState
                    title="No SDK keys match your search."
                    body="Try a different search term."
                    action={
                      <button type="button" className={styles.secondaryButton} onClick={() => setQ("")}>
                        Clear search
                      </button>
                    }
                  />
                )}
                {phase === "ready" && filtered.length > 0 && (
                  <>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">Name</th>
                          <th scope="col">Key ID</th>
                          <th scope="col">Created by</th>
                          <th scope="col">Last used</th>
                          <th scope="col">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((k) => (
                          <tr
                            key={k.id}
                            className={`${styles.row} ${k.id === selectedId ? styles.rowSelected : ""}`}
                            onClick={() => setSelectedId(k.id)}
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setSelectedId(k.id);
                              }
                            }}
                            aria-label={`Select ${k.name}`}
                          >
                            <td>
                              <strong>{k.name}</strong>
                            </td>
                            <td className={styles.cellMono}>{k.prefix}…</td>
                            <td>{creatorName(k.created_by)}</td>
                            <td>{k.last_used_at ? timeAgo(k.last_used_at) : "Never"}</td>
                            <td>
                              <StatusBadge revoked={k.revoked_at !== null} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className={styles.cards}>
                      {filtered.map((k) => (
                        <article
                          key={k.id}
                          className={`${styles.keyCard} ${k.id === selectedId ? styles.rowSelected : ""}`}
                          onClick={() => setSelectedId(k.id)}
                        >
                          <div className={styles.keyCardTop}>
                            <strong>{k.name}</strong>
                            <StatusBadge revoked={k.revoked_at !== null} />
                          </div>
                          <p className={`${styles.keyCardMeta} ${styles.cellMono}`}>{k.prefix}…</p>
                          <p className={styles.keyCardMeta}>
                            {k.last_used_at ? `Used ${timeAgo(k.last_used_at)}` : "Never used"} · by{" "}
                            {creatorName(k.created_by)}
                          </p>
                        </article>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className={styles.detailCol}>
              {!selected && phase === "ready" && filtered.length > 0 && (
                <div className={styles.card}>
                  <p className={styles.pickHint}>Select a key to see its details.</p>
                </div>
              )}
              {selected && (
                <div className={styles.card}>
                  <div className={styles.detailHead}>
                    <h2>{selected.name}</h2>
                    <StatusBadge revoked={selected.revoked_at !== null} />
                  </div>
                  <dl className={styles.detailList}>
                    <div>
                      <dt>Key ID</dt>
                      <dd className={styles.cellMono}>{selected.prefix}…</dd>
                    </div>
                    <div>
                      <dt>Environment</dt>
                      <dd>
                        <EnvName name={env?.name} isProtected={env?.protected} />
                      </dd>
                    </div>
                    <div>
                      <dt>Created by</dt>
                      <dd>{creatorName(selected.created_by)}</dd>
                    </div>
                    <div>
                      <dt>Created at</dt>
                      <dd>{exactTime(selected.created_at)}</dd>
                    </div>
                    <div>
                      <dt>Last used</dt>
                      <dd>{selected.last_used_at ? timeAgo(selected.last_used_at) : "Never"}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>
                        {selected.revoked_at
                          ? `Revoked ${timeAgo(selected.revoked_at)}`
                          : "Active"}
                      </dd>
                    </div>
                  </dl>
                  {!selected.revoked_at && (
                    <div className={styles.revokeRow}>
                      <p>Revoke this key to immediately stop its usage.</p>
                      <button
                        type="button"
                        className={styles.revokeButton}
                        disabled={!canManage}
                        title={!canManage ? "Only project admins can manage SDK keys." : undefined}
                        onClick={() => setRevokeAsk(selected)}
                      >
                        Revoke key
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {createOpen && (
        <CreateKeyModal
          projectKey={projectKey}
          envs={envs}
          defaultEnvKey={envKey}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void loadKeys(projectKey, envKey);
          }}
        />
      )}
      {revokeAsk && (
        <ConfirmModal
          title={`Revoke ${revokeAsk.name}?`}
          body="Applications using this SDK key will immediately lose access. This action cannot be undone."
          confirmLabel="Revoke key"
          danger
          busy={busy}
          onCancel={() => setRevokeAsk(null)}
          onConfirm={() => void applyRevoke(revokeAsk)}
        />
      )}
    </div>
  );
}

function StatusBadge({ revoked }: { revoked: boolean }) {
  return (
    <span className={`${styles.badge} ${revoked ? styles.badgeRevoked : styles.badgeActive}`}>
      {revoked ? "Revoked" : "Active"}
    </span>
  );
}

function EnvName({ name, isProtected }: { name?: string; isProtected?: boolean }) {
  if (!name) return <span>—</span>;
  return (
    <span className={styles.envName}>
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

function CreateKeyModal({
  projectKey,
  envs,
  defaultEnvKey,
  onClose,
  onCreated,
}: {
  projectKey: string;
  envs: Env[];
  defaultEnvKey: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [envKey, setEnvKey] = useState(defaultEnvKey || envs[0]?.key || "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The full secret: held in component state only, wiped on close.
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

  const env = envs.find((e) => e.key === envKey);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setNameError("Name is required.");
      return;
    }
    setNameError(null);
    setFormError(null);
    setBusy(true);
    try {
      const created = await apiPost<SdkKeyCreated>(
        `/api/projects/${projectKey}/environments/${envKey}/sdk-keys`,
        { name: name.trim() },
      );
      setSecret(created.key);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the key.");
      setBusy(false);
    }
  }

  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
    } catch {
      // Clipboard API unavailable (permissions): select the field instead.
      const field = document.getElementById("new-sdk-secret");
      if (field instanceof HTMLInputElement) field.select();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function requestClose() {
    // Secret visible and not yet copied: confirm before destroying it.
    if (secret && !copied) {
      setConfirmingClose(true);
      return;
    }
    setSecret(null);
    onClose();
  }

  if (confirmingClose) {
    return (
      <ConfirmModal
        title="Have you saved this key?"
        body="It cannot be shown again once this dialog closes."
        confirmLabel="Close without copying"
        busy={false}
        onCancel={() => setConfirmingClose(false)}
        onConfirm={() => {
          setSecret(null);
          onClose();
        }}
      />
    );
  }

  // Reveal state replaces the form: shown exactly once.
  if (secret) {
    return (
      <Modal title="SDK key created" onClose={requestClose}>
        <p className={styles.revealLead}>Copy this key now. You won&apos;t be able to see it again.</p>
        <label className={styles.revealLabel} htmlFor="new-sdk-secret">
          Secret key
        </label>
        <input
          id="new-sdk-secret"
          type="text"
          readOnly
          value={secret}
          onFocus={(e) => e.target.select()}
          className={styles.secretField}
        />
        <div className={styles.modalActions}>
          <button
            type="button"
            className={styles.cancelButton}
            onClick={() => void copy()}
            aria-label="Copy SDK key to clipboard"
            aria-live="polite"
          >
            {copied ? "Copied" : "Copy key"}
          </button>
          <button
            type="button"
            className={styles.confirmButton}
            onClick={() => {
              setSecret(null);
              onClose();
              onCreated();
            }}
          >
            I&apos;ve copied the key
          </button>
        </div>
        <p className={styles.revealHint}>Store this key somewhere secure before continuing.</p>
      </Modal>
    );
  }

  return (
    <Modal title="Create SDK key" onClose={onClose}>
      <form onSubmit={(e) => void handleSubmit(e)}>
        {formError && (
          <p className={styles.modalError} role="alert">
            {formError}
          </p>
        )}
        <div className={styles.modalField}>
          <label htmlFor="new-key-name">Name</label>
          <input
            id="new-key-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Web App"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? "new-key-name-error" : undefined}
            autoFocus
          />
          {nameError ? (
            <p className={styles.modalFieldError} id="new-key-name-error">
              {nameError}
            </p>
          ) : (
            <p className={styles.modalHint}>Use a name that identifies where this key will be used.</p>
          )}
        </div>
        <div className={styles.modalField}>
          <label htmlFor="new-key-env">Environment</label>
          <select id="new-key-env" value={envKey} onChange={(e) => setEnvKey(e.target.value)}>
            {envs.map((e) => (
              <option key={e.key} value={e.key}>
                {e.name}
                {e.protected ? " 🔒" : ""}
              </option>
            ))}
          </select>
          {env?.protected && (
            <p className={styles.modalHint}>Production is protected; key management needs an admin.</p>
          )}
        </div>
        <div className={styles.modalActions}>
          <button type="button" className={styles.cancelButton} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={styles.confirmButton} disabled={busy}>
            {busy ? "Creating…" : "Create key"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
