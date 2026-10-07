"use client";

import styles from "./controls.module.css";

// Accessible switch. Renders a real checkbox so keyboard + screen readers work.
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  disabledReason,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const control = (
    <input
      type="checkbox"
      className={styles.toggleInput}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
      aria-label={label}
    />
  );
  if (disabled && disabledReason) {
    return (
      <span className={styles.toggleDisabledWrap} title={disabledReason}>
        {control}
      </span>
    );
  }
  return control;
}

export function TypeBadge({ kind }: { kind: "bool" | "string" }) {
  return (
    <span className={`${styles.badge} ${kind === "bool" ? styles.badgeBool : styles.badgeString}`}>
      {kind === "bool" ? "Boolean" : "String"}
    </span>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  return (
    <div className={styles.pagination}>
      <span>
        Showing {from}–{to} of {total} flags
      </span>
      <span className={styles.pageButtons}>
        <button
          type="button"
          className={styles.pageButton}
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
        >
          ‹
        </button>
        <span className={styles.pageCurrent} aria-current="page">
          {page}
        </span>
        <button
          type="button"
          className={styles.pageButton}
          onClick={() => onPage(page + 1)}
          disabled={page >= totalPages}
          aria-label="Next page"
        >
          ›
        </button>
      </span>
    </div>
  );
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading feature flags">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={styles.skeletonRow} aria-hidden="true" />
      ))}
    </div>
  );
}

export function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className={styles.stateCard} role="alert">
      <h3>Couldn&apos;t load feature flags.</h3>
      <p>{message}</p>
      <button type="button" className={styles.primaryButton} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.stateCard}>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}
