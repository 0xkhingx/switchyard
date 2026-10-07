"use client";

import { useState } from "react";
import { bucket } from "@/lib/murmur";
import styles from "../flags.module.css";

export interface EvalResult {
  value: boolean | string | null;
  reason: string;
  ruleId: string | null;
  /** True when the matched rule serves a rollout (bucket shown only then). */
  rollout?: boolean;
}

// Exact reference buckets for the demo flag (evaluator is deterministic per
// flag key + user key, so these never change).
const SAMPLE_USERS: { user: string; bucket: number; at20: boolean }[] = [
  { user: "u-1", bucket: 5245, at20: false },
  { user: "u-2", bucket: 9861, at20: false },
  { user: "u-3", bucket: 1323, at20: true },
  { user: "u-4", bucket: 7023, at20: false },
];

function friendlyReason(reason: string, ruleId: string | null, rollout: boolean): string {
  switch (reason) {
    case "OFF":
      return "Flag is off";
    case "RULE_MATCH":
      return rollout ? "Matched rollout rule" : `Matched rule ${ruleId ?? ""}`.trim();
    case "FALLTHROUGH":
      return "No rule matched — fallthrough";
    case "FLAG_NOT_FOUND":
      return "Flag not found";
    default:
      return "Evaluation error";
  }
}

export function TestPanel({
  flagKey,
  readOnly,
  onEvaluate,
}: {
  flagKey: string;
  readOnly: boolean;
  onEvaluate: (ctx: { key: string; attributes: Record<string, unknown> }) => Promise<EvalResult>;
}) {
  const [userId, setUserId] = useState("u-3");
  const [attrs, setAttrs] = useState<{ name: string; value: string }[]>([
    { name: "country", value: "US" },
  ]);
  const [result, setResult] = useState<EvalResult | null>(null);
  const [resultBucket, setResultBucket] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Test inputs are inspect-only; editing stays available in read-only mode
  // because evaluation never changes server state.
  void readOnly;

  function parseAttr(raw: string): unknown {
    const t = raw.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
    return raw;
  }

  async function run() {
    if (!userId.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attributes: Record<string, unknown> = {};
      for (const a of attrs) {
        if (a.name.trim()) attributes[a.name.trim()] = parseAttr(a.value);
      }
      const r = await onEvaluate({ key: userId.trim(), attributes });
      setResult(r);
      // Bucket display only: recomputed locally, never affects the decision.
      // Shown only when a rollout actually chose the value.
      setResultBucket(
        r.rollout && r.ruleId && userId.trim() ? bucket(flagKey, userId.trim()) : null,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Evaluation failed.");
      setResult(null);
      setResultBucket(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} aria-label="Test flag evaluation">
      <h2 className={styles.cardTitle}>Test flag evaluation</h2>
      <p className={styles.cardSub}>See how this draft configuration evaluates for a specific user.</p>

      <div className={styles.testField}>
        <label htmlFor="test-user-id">User ID</label>
        <input
          id="test-user-id"
          type="text"
          className={styles.textInput}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="u-3"
        />
      </div>
      {attrs.map((a, i) => (
        <div key={i} className={styles.testAttrRow}>
          <label>
            <span className={styles.visuallyHidden}>Attribute name</span>
            <input
              type="text"
              className={styles.textInput}
              value={a.name}
              onChange={(e) =>
                setAttrs(attrs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
              }
              placeholder="country"
              aria-label="Attribute name"
            />
          </label>
          <label>
            <span className={styles.visuallyHidden}>Attribute value</span>
            <input
              type="text"
              className={styles.textInput}
              value={a.value}
              onChange={(e) =>
                setAttrs(attrs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
              }
              placeholder="US"
              aria-label="Attribute value"
            />
          </label>
          <button
            type="button"
            className={styles.iconButton}
            onClick={() => setAttrs(attrs.filter((_, j) => j !== i))}
            aria-label={`Remove attribute ${a.name || i + 1}`}
            title="Remove attribute"
          >
            🗑
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.addButton}
        onClick={() => setAttrs([...attrs, { name: "", value: "" }])}
      >
        + Add attribute
      </button>

      <button
        type="button"
        className={styles.evaluateButton}
        onClick={() => void run()}
        disabled={busy || !userId.trim()}
      >
        {busy ? "Evaluating…" : "Evaluate flag"}
      </button>

      {error && (
        <p className={styles.resultError} role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className={styles.resultCard} aria-live="polite">
          <h3>Result</h3>
          <dl>
            <div>
              <dt>Value</dt>
              <dd>
                <strong>{result.value === null ? "null" : String(result.value)}</strong>
              </dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd>{friendlyReason(result.reason, result.ruleId, result.rollout ?? false)}</dd>
            </div>
            {result.ruleId && (
              <div>
                <dt>Rule</dt>
                <dd>{result.ruleId}</dd>
              </div>
            )}
            {resultBucket !== null && (
              <div>
                <dt>Bucket</dt>
                <dd>{resultBucket}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {flagKey === "new-banner" && (
        <div className={styles.sampleTable}>
          <h3>Sample users</h3>
          <table>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Bucket</th>
                <th scope="col">At 20%</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_USERS.map((s) => (
                <tr key={s.user}>
                  <td>{s.user}</td>
                  <td>{s.bucket}</td>
                  <td>{String(s.at20)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
