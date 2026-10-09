"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClockIcon, KeyIcon, SettingsIcon, TriangleFlagIcon } from "./icons";
import styles from "./Sidebar.module.css";

const NAV = [
  { href: "/flags", label: "Feature Flags", Icon: TriangleFlagIcon },
  { href: "/audit", label: "Audit Log", Icon: ClockIcon },
  { href: "/sdk-keys", label: "SDK Keys", Icon: KeyIcon },
  { href: "/settings", label: "Project Settings", Icon: SettingsIcon },
];

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  return (
    <>
      <div
        className={`${styles.scrim} ${open ? styles.scrimOpen : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className={`${styles.sidebar} ${open ? styles.open : ""}`}>
        <div className={styles.brand}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-lockup.png" alt="Switchyard" className={styles.brandLogo} />
        </div>
        <nav className={styles.nav} aria-label="Primary">
          {NAV.map(({ href, label, Icon }) => {
            const active = pathname === href || (href === "/flags" && pathname.startsWith("/flags"));
            return (
              <Link
                key={href}
                href={href}
                className={`${styles.item} ${active ? styles.active : ""}`}
                aria-current={active ? "page" : undefined}
                onClick={onClose}
              >
                <Icon />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
