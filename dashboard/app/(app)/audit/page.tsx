import type { Metadata } from "next";
import { Suspense } from "react";
import { AuditClient } from "./AuditClient";

export const metadata: Metadata = {
  title: "Audit log — Switchyard",
};

// Filters live in the URL query string, so render per request, not at build time.
export const dynamic = "force-dynamic";

export default function AuditPage() {
  return (
    <Suspense>
      <AuditClient />
    </Suspense>
  );
}
