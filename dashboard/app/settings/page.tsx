import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsClient } from "./SettingsClient";

export const metadata: Metadata = {
  title: "Project Settings — Switchyard",
};

// The selected project travels in the query string: render per request.
export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsClient />
    </Suspense>
  );
}
