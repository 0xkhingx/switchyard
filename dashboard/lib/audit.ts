// Audit presentation logic: display categories, human summaries, and
// condition-level diffs — all derived from the structured before/after
// JSON the backend stores. Never reconstructed from current flag state.

export type Category =
  | "created"
  | "updated"
  | "enabled"
  | "disabled"
  | "archived"
  | "unarchived"
  | "sdk_key_created"
  | "sdk_key_revoked"
  | "environment";

export const CATEGORY_LABEL: Record<Category, string> = {
  created: "Created",
  updated: "Updated",
  enabled: "Enabled",
  disabled: "Disabled",
  archived: "Archived",
  unarchived: "Unarchived",
  sdk_key_created: "SDK key created",
  sdk_key_revoked: "SDK key revoked",
  environment: "Environment",
};

export interface AuditEvent {
  id: number;
  environment_id: string | null;
  flag_key: string | null;
  actor_email: string | null;
  action: string;
  before: AuditConfig | null;
  after: AuditConfig | null;
  created_at: string;
}

interface AuditConfig {
  enabled?: boolean;
  offValue?: unknown;
  rules?: AuditRule[];
  fallthrough?: unknown;
  name?: string;
  prefix?: string;
  key?: string;
  type?: string;
}

interface AuditRule {
  id: string;
  conditions?: { attribute: string; op: string; values: unknown[] }[];
  serve?: { fixed?: unknown; rollout?: { value: unknown; weight: number }[] };
}

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "—";
  return JSON.stringify(v);
}

function rolloutPercent(serve: AuditRule["serve"]): number | null {
  const r = serve?.rollout;
  if (!r || r.length === 0) return null;
  return Math.round(r[0].weight / 100);
}

/** Display category for one event, derived from action + before/after. */
export function categorize(e: AuditEvent): Category {
  switch (e.action) {
    case "flag.create":
      return "created";
    case "flag.archive":
      return "archived";
    case "flag.unarchive":
      return "unarchived";
    case "environment.create":
      return "environment";
    case "sdk-key.create":
      return "sdk_key_created";
    case "sdk-key.revoke":
      return "sdk_key_revoked";
    default: {
      if (e.action === "config.update" && e.before && e.after) {
        if (e.before.enabled === false && e.after.enabled === true) return "enabled";
        if (e.before.enabled === true && e.after.enabled === false) return "disabled";
      }
      return "updated";
    }
  }
}

function condText(c: { attribute: string; op: string; values: unknown[] }): string {
  const opName: Record<string, string> = {
    equals: "equals",
    notEquals: "not equals",
    in: "in",
    notIn: "not in",
    contains: "contains",
    startsWith: "starts with",
    endsWith: "ends with",
  };
  return `${c.attribute} ${opName[c.op] ?? c.op} ${c.values.map(fmt).join(", ")}`;
}

/** One-line human summary from structured data. */
export function summarize(e: AuditEvent): string {
  const cat = categorize(e);
  const before = e.before;
  const after = e.after;
  switch (cat) {
    case "enabled":
      return "Enabled flag";
    case "disabled":
      return "Disabled flag";
    case "created":
      return e.action === "environment.create"
        ? `Created environment ${(after?.key as string) ?? ""}`.trim() || "Created environment"
        : "Created flag";
    case "archived":
      return "Archived flag";
    case "unarchived":
      return "Unarchived flag";
    case "sdk_key_created":
      return `SDK key created${after?.name ? `: ${after.name}` : ""}`;
    case "sdk_key_revoked":
      return `SDK key revoked${after?.name ? `: ${after.name}` : ""}`;
    case "environment":
      return "Created environment";
    default: {
      if (!before || !after) return "Updated flag";
      if (JSON.stringify(before.enabled) !== JSON.stringify(after.enabled)) {
        return after.enabled ? "Enabled flag" : "Disabled flag";
      }
      const br = before.rules ?? [];
      const ar = after.rules ?? [];
      const bIds = br.map((r) => r.id);
      const aIds = ar.map((r) => r.id);
      for (const r of ar) {
        if (!bIds.includes(r.id)) {
          const first = r.conditions?.[0];
          return first ? `Added rule: ${condText(first)}` : `Added rule ${r.id}`;
        }
      }
      for (const r of br) {
        if (!aIds.includes(r.id)) return `Removed rule ${r.id}`;
      }
      if (JSON.stringify(bIds) !== JSON.stringify(aIds)) {
        const moved = ar.find((r, i) => bIds[i] !== r.id);
        return moved ? `Moved rule ${moved.id}` : "Reordered rules";
      }
      for (const r of ar) {
        const b = br.find((x) => x.id === r.id);
        if (!b) continue;
        const bp = rolloutPercent(b.serve);
        const ap = rolloutPercent(r.serve);
        if (bp !== null && ap !== null && bp !== ap) return `Rollout: ${bp}% → ${ap}%`;
        if (JSON.stringify(b.conditions) !== JSON.stringify(r.conditions)) {
          const idx = ar.indexOf(r) + 1;
          return `Updated rule ${idx} condition`;
        }
        if (JSON.stringify(b.serve) !== JSON.stringify(r.serve)) {
          return `Changed rule ${ar.indexOf(r) + 1} value`;
        }
      }
      if (JSON.stringify(before.fallthrough) !== JSON.stringify(after.fallthrough)) {
        const f = (v: unknown) =>
          fmt((v as { fixed?: unknown })?.fixed ?? v);
        return `Fallthrough: ${f(before.fallthrough)} → ${f(after.fallthrough)}`;
      }
      if (JSON.stringify(before.offValue) !== JSON.stringify(after.offValue)) {
        return `Changed off value: ${fmt(before.offValue)} → ${fmt(after.offValue)}`;
      }
      return "Updated flag";
    }
  }
}

export interface DiffLine {
  kind: "context" | "add" | "del";
  text: string;
}

/** Compact condition-level diff lines for the expanded view. */
export function diffLines(e: AuditEvent): DiffLine[] {
  const out: DiffLine[] = [];
  const before = e.before;
  const after = e.after;
  if (!before || !after) return out;
  if (JSON.stringify(before.enabled) !== JSON.stringify(after.enabled)) {
    out.push({
      kind: "context",
      text: after.enabled ? "Enabled the flag" : "Disabled the flag",
    });
  }
  const br = before.rules ?? [];
  const ar = after.rules ?? [];
  for (const r of ar) {
    const b = br.find((x) => x.id === r.id);
    if (!b) {
      out.push({ kind: "add", text: `Added rule ${r.id}` });
      for (const c of r.conditions ?? []) out.push({ kind: "add", text: condText(c) });
      continue;
    }
    const bc = JSON.stringify(b.conditions ?? []);
    const ac = JSON.stringify(r.conditions ?? []);
    if (bc !== ac) {
      const idx = ar.indexOf(r) + 1;
      for (const c of b.conditions ?? []) out.push({ kind: "del", text: `Rule ${idx} — ${condText(c)}` });
      for (const c of r.conditions ?? []) out.push({ kind: "add", text: `Rule ${idx} — ${condText(c)}` });
    }
    const bp = rolloutPercent(b.serve);
    const ap = rolloutPercent(r.serve);
    if (bp !== null && ap !== null && bp !== ap) {
      out.push({ kind: "del", text: `Rollout ${bp}%` });
      out.push({ kind: "add", text: `Rollout ${ap}%` });
    } else if (JSON.stringify(b.serve) !== JSON.stringify(r.serve)) {
      out.push({ kind: "del", text: `Serve ${fmt(b.serve)}` });
      out.push({ kind: "add", text: `Serve ${fmt(r.serve)}` });
    }
  }
  for (const b of br) {
    if (!ar.some((x) => x.id === b.id)) out.push({ kind: "del", text: `Removed rule ${b.id}` });
  }
  if (JSON.stringify(before.fallthrough) !== JSON.stringify(after.fallthrough)) {
    const f = (v: unknown) => fmt((v as { fixed?: unknown })?.fixed ?? v);
    out.push({ kind: "del", text: `Fallthrough ${f(before.fallthrough)}` });
    out.push({ kind: "add", text: `Fallthrough ${f(after.fallthrough)}` });
  }
  if (JSON.stringify(before.offValue) !== JSON.stringify(after.offValue)) {
    out.push({ kind: "del", text: `Off value ${fmt(before.offValue)}` });
    out.push({ kind: "add", text: `Off value ${fmt(after.offValue)}` });
  }
  return out;
}

export function actorName(email: string | null, meEmail?: string): string {
  if (!email) return "unknown";
  if (meEmail && email === meEmail) return "you";
  return email.split("@")[0];
}

export function initials(email: string | null): string {
  if (!email) return "?";
  const local = email.split("@")[0];
  return local.slice(0, 2).toUpperCase();
}
