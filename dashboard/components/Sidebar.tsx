"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { ClockIcon, KeyIcon, SettingsIcon, TriangleFlagIcon } from "./icons";
import { guardNavigation, isModifiedClick } from "@/lib/navGuard";
import styles from "./Sidebar.module.css";

const NAV = [
  { href: "/flags", label: "Feature flags", Icon: TriangleFlagIcon },
  { href: "/audit", label: "Audit log", Icon: ClockIcon },
  { href: "/sdk-keys", label: "SDK keys", Icon: KeyIcon },
  { href: "/settings", label: "Project settings", Icon: SettingsIcon },
];

// App navigation on shadcn's Sidebar (inset variant): collapses to an icon
// rail (⌘/Ctrl+B, or the rail edge), becomes a sheet on mobile, and
// remembers its state in a cookie read by app/(app)/layout.tsx.
export function AppSidebar() {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  // Carry the selected project across sections.
  const project = params.get("project");
  const withProject = (href: string) => (project ? `${href}?project=${encodeURIComponent(project)}` : href);
  // A page with unsaved edits (see lib/navGuard) can hold the navigation and
  // ask first; it calls the continuation only if the person discards.
  const guardedClick = (target: string) => (e: React.MouseEvent) => {
    if (isModifiedClick(e)) return;
    if (guardNavigation(() => router.push(target))) e.preventDefault();
  };

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <Link
          href={withProject("/flags")}
          className={styles.brand}
          aria-label="Switchyard home"
          onClick={guardedClick(withProject("/flags"))}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-lockup.png" alt="" className={styles.brandLogo} />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {NAV.map(({ href, label, Icon }) => {
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton
                    isActive={active}
                    tooltip={label}
                    render={
                      <Link
                        href={withProject(href)}
                        aria-current={active ? "page" : undefined}
                        onClick={(e) => {
                          guardedClick(withProject(href))(e);
                          if (isMobile) setOpenMobile(false);
                        }}
                      />
                    }
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
