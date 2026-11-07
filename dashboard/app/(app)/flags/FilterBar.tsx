"use client";

import { SearchIcon } from "@/components/icons";
import styles from "./flags.module.css";
import { SelectMenu } from "@/components/SelectMenu";

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
        <SearchIcon size={17} />
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
      <div className={styles.filterWrap}>
        <SelectMenu<StatusFilter>
          ariaLabel="Filter by status"
          value={status}
          onChange={onStatus}
          disabled={disabled}
          options={[
            { value: "all", label: "All statuses" },
            { value: "enabled", label: "Enabled", icon: <span className="sy-dot" aria-hidden="true" /> },
            { value: "disabled", label: "Disabled", icon: <span className="sy-dot" data-tone="off" aria-hidden="true" /> },
          ]}
        />
      </div>
      <div className={styles.filterWrap}>
        <SelectMenu<TypeFilter>
          ariaLabel="Filter by type"
          value={type}
          onChange={onType}
          disabled={disabled}
          options={[
            { value: "all", label: "All types" },
            { value: "bool", label: "Boolean" },
            { value: "string", label: "String" },
          ]}
        />
      </div>
      <div className={styles.filterWrap}>
        <SelectMenu<SortKey>
          ariaLabel="Sort flags"
          value={sort}
          onChange={onSort}
          disabled={disabled}
          options={[
            { value: "updated", label: "Last updated" },
            { value: "name-asc", label: "Name A–Z" },
            { value: "name-desc", label: "Name Z–A" },
          ]}
        />
      </div>
    </div>
  );
}
