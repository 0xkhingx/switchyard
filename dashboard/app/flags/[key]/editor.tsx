"use client";

import {
  OPS,
  blankCondition,
  type ConditionDraft,
  type RuleDraft,
  type ServeDraft,
} from "./draft";
import styles from "../flags.module.css";

function BoolSegment({
  value,
  onChange,
  readOnly,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
  label: string;
}) {
  return (
    <span className={styles.segment} role="group" aria-label={label}>
      {(["true", "false"] as const).map((v) => (
        <button
          key={v}
          type="button"
          className={`${styles.segmentButton} ${value.trim() === v ? styles.segmentOn : ""}`}
          aria-pressed={value.trim() === v}
          disabled={readOnly}
          onClick={() => onChange(v)}
        >
          {v}
        </button>
      ))}
    </span>
  );
}

export function FixedEditor({
  value,
  kind,
  readOnly,
  onChange,
  label,
}: {
  value: string;
  kind: "bool" | "string";
  readOnly: boolean;
  onChange: (v: string) => void;
  label: string;
}) {
  if (kind === "bool") {
    return <BoolSegment value={value} onChange={onChange} readOnly={readOnly} label={label} />;
  }
  return (
    <input
      type="text"
      className={styles.textInput}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={readOnly}
      aria-label={label}
      placeholder="variant value"
    />
  );
}

export function RolloutEditor({
  serve,
  kind,
  readOnly,
  onChange,
}: {
  serve: Extract<ServeDraft, { mode: "rollout" }>;
  kind: "bool" | "string";
  readOnly: boolean;
  onChange: (s: Extract<ServeDraft, { mode: "rollout" }>) => void;
}) {
  const p = Math.max(0, Math.min(100, Math.round(serve.percent)));
  return (
    <div className={styles.rollout}>
      <div className={styles.rolloutTop}>
        <label>
          Percentage rollout
          <span className={styles.rolloutPct}>{p}%</span>
        </label>
      </div>
      <div className={styles.rolloutControls}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={p}
          disabled={readOnly}
          onChange={(e) => onChange({ ...serve, percent: Number(e.target.value) })}
          aria-label="Rollout percentage"
        />
        <input
          type="number"
          min={0}
          max={100}
          value={p}
          disabled={readOnly}
          onChange={(e) => onChange({ ...serve, percent: Number(e.target.value) })}
          aria-label="Rollout percentage value"
          className={styles.numberInput}
        />
        <span aria-hidden="true">%</span>
      </div>
      {kind === "bool" ? (
        <div className={styles.rolloutSplit}>
          <span>
            {p}% → <strong>{serve.primary.trim() === "false" ? "false" : "true"}</strong>
          </span>
          <BoolSegment
            value={serve.primary}
            onChange={(v) => onChange({ ...serve, primary: v })}
            readOnly={readOnly}
            label="Rollout primary variant"
          />
          <span>
            {100 - p}% → <strong>{serve.primary.trim() === "false" ? "true" : "false"}</strong>
          </span>
        </div>
      ) : (
        <div className={styles.rolloutSplit}>
          <input
            type="text"
            className={styles.textInput}
            value={serve.primary}
            disabled={readOnly}
            onChange={(e) => onChange({ ...serve, primary: e.target.value })}
            aria-label={`Variant served to ${p}% of users`}
            placeholder="Variant A"
          />
          <input
            type="text"
            className={styles.textInput}
            value={serve.secondary}
            disabled={readOnly}
            onChange={(e) => onChange({ ...serve, secondary: e.target.value })}
            aria-label={`Variant served to ${100 - p}% of users`}
            placeholder="Variant B"
          />
        </div>
      )}
    </div>
  );
}

export function ConditionRow({
  cond,
  readOnly,
  onChange,
  onDelete,
}: {
  cond: ConditionDraft;
  readOnly: boolean;
  onChange: (c: ConditionDraft) => void;
  onDelete: () => void;
}) {
  const isList = cond.op === "in" || cond.op === "notIn";
  return (
    <div className={styles.condRow}>
      <label className={styles.condField}>
        <span className={styles.visuallyHidden}>Attribute</span>
        <input
          type="text"
          className={styles.textInput}
          value={cond.attribute}
          disabled={readOnly}
          onChange={(e) => onChange({ ...cond, attribute: e.target.value })}
          placeholder="country"
          aria-label="Attribute"
        />
      </label>
      <label className={styles.condField}>
        <span className={styles.visuallyHidden}>Operator</span>
        <select
          value={cond.op}
          disabled={readOnly}
          onChange={(e) =>
            onChange({
              ...cond,
              op: e.target.value as ConditionDraft["op"],
              values: [""],
            })
          }
          aria-label="Operator"
        >
          {OPS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.condValue}>
        <span className={styles.visuallyHidden}>Value{isList ? "s (comma separated)" : ""}</span>
        <input
          type="text"
          className={styles.textInput}
          value={isList ? cond.values.join(", ") : (cond.values[0] ?? "")}
          disabled={readOnly}
          onChange={(e) =>
            onChange({
              ...cond,
              values: isList
                ? e.target.value.split(",").map((v) => v.trim())
                : [e.target.value],
            })
          }
          placeholder={isList ? "NG, GH" : "US  ·  true, 42, or text"}
          aria-label={isList ? "Values, comma separated" : "Value"}
        />
      </label>
      <button
        type="button"
        className={styles.iconButton}
        disabled={readOnly}
        onClick={onDelete}
        aria-label="Delete condition"
        title="Delete condition"
      >
        🗑
      </button>
    </div>
  );
}

export function RuleCard({
  rule,
  index,
  kind,
  readOnly,
  onChange,
  onDelete,
  onMove,
  dragHandlers,
}: {
  rule: RuleDraft;
  index: number;
  kind: "bool" | "string";
  readOnly: boolean;
  onChange: (r: RuleDraft) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  dragHandlers: {
    draggable: boolean;
    onDragStart: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: () => void;
    dragging: boolean;
  };
}) {
  const setServeMode = (mode: "fixed" | "rollout") => {
    if (rule.serve.mode === mode) return;
    if (mode === "fixed") {
      onChange({ ...rule, serve: { mode: "fixed", value: kind === "bool" ? "true" : "" } });
    } else {
      onChange({
        ...rule,
        serve: {
          mode: "rollout",
          percent: 20,
          primary: kind === "bool" ? "true" : "",
          secondary: "",
        },
      });
    }
  };
  return (
    <article
      className={`${styles.ruleCard} ${dragHandlers.dragging ? styles.ruleDragging : ""}`}
      draggable={dragHandlers.draggable && !readOnly}
      onDragStart={dragHandlers.onDragStart}
      onDragOver={dragHandlers.onDragOver}
      onDrop={dragHandlers.onDrop}
      aria-label={`Rule ${index + 1}`}
    >
      <div className={styles.ruleHead}>
        <span
          className={styles.dragHandle}
          aria-hidden="true"
          title={readOnly ? undefined : "Drag to reorder"}
        >
          ⋮⋮
        </span>
        <span className={styles.ruleNumber}>{index + 1}</span>
        <label className={styles.ruleIdLabel}>
          <span className={styles.visuallyHidden}>Rule ID</span>
          <input
            type="text"
            className={styles.ruleId}
            value={rule.id}
            disabled={readOnly}
            onChange={(e) => onChange({ ...rule, id: e.target.value })}
            aria-label={`Rule ${index + 1} ID`}
            maxLength={32}
          />
        </label>
        <span className={styles.ruleHeadActions}>
          <button
            type="button"
            className={styles.iconButton}
            disabled={readOnly}
            onClick={() => onMove(-1)}
            aria-label={`Move rule ${index + 1} up`}
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.iconButton}
            disabled={readOnly}
            onClick={() => onMove(1)}
            aria-label={`Move rule ${index + 1} down`}
            title="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            className={styles.iconButton}
            disabled={readOnly}
            onClick={onDelete}
            aria-label={`Delete rule ${index + 1}`}
            title="Delete rule"
          >
            🗑
          </button>
        </span>
      </div>

      <div className={styles.conditions}>
        {rule.conditions.map((c, i) => (
          <div key={i}>
            <ConditionRow
              cond={c}
              readOnly={readOnly}
              onChange={(next) =>
                onChange({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? next : x)) })
              }
              onDelete={() =>
                onChange({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })
              }
            />
            {i < rule.conditions.length - 1 && <div className={styles.andChip}>AND</div>}
          </div>
        ))}
        <button
          type="button"
          className={styles.addButton}
          disabled={readOnly}
          onClick={() => onChange({ ...rule, conditions: [...rule.conditions, blankCondition()] })}
        >
          + Add condition
        </button>
      </div>

      <div className={styles.serveRow}>
        <span className={styles.serveTabs} role="group" aria-label="Rule result type">
          {(["fixed", "rollout"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`${styles.serveTab} ${rule.serve.mode === m ? styles.serveTabOn : ""}`}
              aria-pressed={rule.serve.mode === m}
              disabled={readOnly}
              onClick={() => setServeMode(m)}
            >
              {m === "fixed" ? "Fixed value" : "Percentage rollout"}
            </button>
          ))}
        </span>
        {rule.serve.mode === "fixed" ? (
          <span className={styles.returnWrap}>
            <span className={styles.returnLabel}>Return:</span>
            <FixedEditor
              value={rule.serve.value}
              kind={kind}
              readOnly={readOnly}
              onChange={(value) => onChange({ ...rule, serve: { mode: "fixed", value } })}
              label={`Rule ${index + 1} return value`}
            />
          </span>
        ) : (
          <RolloutEditor
            serve={rule.serve}
            kind={kind}
            readOnly={readOnly}
            onChange={(serve) => onChange({ ...rule, serve })}
          />
        )}
      </div>
    </article>
  );
}
