// Draft model for the rule editor: UI-friendly shapes that convert to and
// from the server's FlagConfig JSON. Raw values stay strings in the editor
// and are coerced to bool/number/string on serialize (equality is type-strict).

export type Op =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "contains"
  | "startsWith"
  | "endsWith";

export const OPS: { value: Op; label: string }[] = [
  { value: "equals", label: "equals" },
  { value: "notEquals", label: "not equals" },
  { value: "in", label: "in" },
  { value: "notIn", label: "not in" },
  { value: "contains", label: "contains" },
  { value: "startsWith", label: "starts with" },
  { value: "endsWith", label: "ends with" },
];

export interface ConditionDraft {
  attribute: string;
  op: Op;
  values: string[];
}

export type ServeDraft =
  | { mode: "fixed"; value: string }
  | { mode: "rollout"; percent: number; primary: string; secondary: string };

export interface RuleDraft {
  id: string;
  conditions: ConditionDraft[];
  serve: ServeDraft;
}

export interface ConfigDraft {
  enabled: boolean;
  offValue: string;
  rules: RuleDraft[];
  fallthrough: string;
}

/** "true"→true, "false"→false, numeric→number, else the raw string. */
export function parseScalar(raw: string): boolean | number | string {
  const t = raw.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return raw;
}

function stringify(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return typeof v === "string" ? v : "";
}

function opposite(raw: string): string {
  return raw.trim() === "true" ? "false" : "true";
}

export function serveFromServer(
  serve: { fixed?: unknown; rollout?: { value: unknown; weight: number }[] },
  kind: "bool" | "string",
): ServeDraft {
  if (serve.rollout && serve.rollout.length > 0) {
    const [first, second] = serve.rollout;
    const percent = Math.round(first.weight / 100);
    return {
      mode: "rollout",
      percent,
      primary: stringify(first.value),
      secondary: second ? stringify(second.value) : kind === "bool" ? opposite(stringify(first.value)) : "",
    };
  }
  return { mode: "fixed", value: stringify(serve.fixed) };
}

export function serveToServer(s: ServeDraft, kind: "bool" | "string"): unknown {
  if (s.mode === "fixed") {
    return { fixed: kind === "bool" ? parseScalar(s.value) : s.value };
  }
  const p = Math.max(0, Math.min(100, Math.round(s.percent)));
  const primary = kind === "bool" ? parseScalar(s.primary) : s.primary;
  const secondary =
    kind === "bool" ? (primary === true ? false : true) : s.secondary;
  return {
    rollout: [
      { value: primary, weight: p * 100 },
      { value: secondary, weight: 10000 - p * 100 },
    ],
  };
}

/** Index of the first match-all rule (no conditions), if any. Everything
 *  below it — later rules and the fallthrough — is unreachable. */
export function firstMatchAllIndex(rules: RuleDraft[]): number {
  return rules.findIndex((r) => r.conditions.length === 0);
}

let ruleCounter = 0;

export function blankRule(kind: "bool" | "string"): RuleDraft {
  ruleCounter += 1;
  return {
    id: `r${Date.now().toString(36)}${ruleCounter}`,
    conditions: [{ attribute: "", op: "equals", values: [""] }],
    serve:
      kind === "bool"
        ? { mode: "fixed", value: "true" }
        : { mode: "fixed", value: "" },
  };
}

export function blankCondition(): ConditionDraft {
  return { attribute: "", op: "equals", values: [""] };
}
