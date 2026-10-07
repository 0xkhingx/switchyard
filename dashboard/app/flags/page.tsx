import type { Metadata } from "next";
import { Suspense } from "react";
import { FlagsClient } from "./FlagsClient";

export const metadata: Metadata = {
  title: "Feature Flags — Switchyard",
};

// Filters live in the URL query string, so render per request, not at build time.
export const dynamic = "force-dynamic";

export default function FlagsPage() {
  return (
    <Suspense>
      <FlagsClient />
    </Suspense>
  );
}
