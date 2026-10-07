"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./flags.module.css";

// Three-dot row menu. Only what v1 supports: Open, Archive.
export function RowMenu({
  flagKey,
  onOpen,
  onArchive,
}: {
  flagKey: string;
  onOpen: () => void;
  onArchive: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open ]);

  return (
    <div className={styles.menuWrap} ref={menuRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={styles.dotsButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${flagKey}`}
        onClick={() => setOpen((v) => !v)}
      >
        •••
      </button>
      {open && (
        <div className={styles.menu} role="menu">
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              onOpen();
            }}
          >
            Open
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => {
              setOpen(false);
              onArchive();
            }}
          >
            Archive
          </button>
        </div>
      )}
    </div>
  );
}
