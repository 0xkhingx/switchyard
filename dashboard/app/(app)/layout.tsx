import { Suspense } from "react";
import { cookies } from "next/headers";
import { AppSidebar } from "@/components/Sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

// Shell for every signed-in section. The sidebar persists across navigation;
// its collapsed state is read from the cookie shadcn's SidebarProvider writes,
// so a collapsed sidebar doesn't flash open on load.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const defaultOpen = cookies().get("sidebar_state")?.value !== "false";
  return (
    <SidebarProvider defaultOpen={defaultOpen} style={{ "--sidebar-width": "15rem" } as React.CSSProperties}>
      <Suspense>
        <AppSidebar />
      </Suspense>
      {/* Inset panel: fixed rounded surface; content scrolls inside it. */}
      <SidebarInset className="min-w-0 md:h-[calc(100svh-1rem)] md:overflow-y-auto md:border md:border-border">
        {children}
      </SidebarInset>
    </SidebarProvider>
  );
}
