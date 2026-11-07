import type { Metadata, Viewport } from "next";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

// Deliberate system stack (see globals.css): zero font downloads, native
// rendering, and it suits a developer tool better than a display face.
export const metadata: Metadata = {
  title: "Switchyard",
  description: "Feature flags for modern teams. Simple. Flexible. Built to ship.",
};

// Light/dark follows the OS; keep browser chrome in step with --bg.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0e" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
