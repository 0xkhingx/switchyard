"use client";

import styles from "./flags.module.css";

export type StatusFilter = "all" | "enabled" | "disabled";
export type TypeFilter = "all" | "bool" | "string";
export type SortKey = "updated" | "name-asc" | "name-desc";

export function FilterBar({
  q,
  status,
  type,
  sort,
  disabled,
  onQ,
  onStatus,
  onType,
  onSort,
}: {
  q: string;
  status: StatusFilter;
  type: TypeFilter;
  sort: SortKey;
  disabled?: boolean;
  onQ: (v: string) => void;
  onStatus: (v: StatusFilter) => void;
  onType: (v: TypeFilter) => void;
  onSort: (v: SortKey) => void;
}) {
  return (
    <div className={styles.filters}>
      <div className={styles.searchWrap}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <label className={styles.visuallyHidden} htmlFor="flag-search">
          Search flags
        </label>
        <input
          id="flag-search"
          type="search"
          placeholder="Search flags…"
          value={q}
          onChange={(e) => onQ(e.target.value)}
          disabled={disabled}
        />
      </div>
      <label className={styles.filterWrap}>
        <span className={styles.visuallyHidden}>Filter by status</span>
        <select value={status} onChange={(e) => onStatus(e.target.value as StatusFilter)} aria-label="Filter by status" disabled={disabled}>
          <option value="all">All statuses</option>
          <option value="enabled">Enabled</option>
          <option value="disabled">Disabled</option>
        </select>
      </label>
      <label className={styles.filterWrap}>
        <span className={styles.visuallyHidden}>Filter by type</span>
        <select value={type} onChange={(e) => onType(e.target.value as TypeFilter)} aria-label="Filter by type" disabled={disabled}>
          <option value="all">All types</option>
          <option value="bool">Boolean</option>
          <option value="string">String</option>
        </select>
      </label>
      <label className={styles.filterWrap}>
        <span className={styles.visuallyHidden}>Sort flags</span>
        <select value={sort} onChange={(e) => onSort(e.target.value as SortKey)} aria-label="Sort flags" disabled={disabled}>
          <option value="updated">Last updated</option>
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
        </select>
      </label>
    </div>
  );
}
