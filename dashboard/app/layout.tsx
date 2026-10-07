import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Switchyard",
  description: "Feature flags for modern teams. Simple. Flexible. Built to ship.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
