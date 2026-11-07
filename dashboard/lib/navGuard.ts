// Minimal in-app navigation guard.
//
// A page with unsaved work registers a guard (setNavigationGuard). Shared
// navigation that the page doesn't own (the sidebar) calls guardNavigation
// before following a link: if a guard is registered it receives a `proceed`
// callback, shows its own confirmation, and calls `proceed` only if the
// person agrees. Full page unloads are covered separately by `beforeunload`.
//
// One guard at a time (one editor page is mounted at a time). The guard is a
// module-level slot rather than React context so components outside the
// page's tree (AppSidebar lives in the layout) can consult it.

import type { MouseEvent } from "react";

type Guard = (proceed: () => void) => void;

let current: Guard | null = null;

/** Register a guard; returns an unregister function (use as effect cleanup). */
export function setNavigationGuard(guard: Guard): () => void {
  current = guard;
  return () => {
    if (current === guard) current = null;
  };
}

/**
 * Ask the active guard before navigating. Returns true when the navigation
 * was intercepted (the caller should preventDefault and let the guard call
 * `proceed`), false when there is nothing to guard.
 */
export function guardNavigation(proceed: () => void): boolean {
  if (!current) return false;
  current(proceed);
  return true;
}

/** True for clicks the browser handles itself (new tab/window, download). */
export function isModifiedClick(e: MouseEvent): boolean {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}
