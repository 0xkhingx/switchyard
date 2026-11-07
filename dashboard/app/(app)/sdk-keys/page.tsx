import type { Metadata } from "next";
import { Suspense } from "react";
import { SdkKeysClient } from "./SdkKeysClient";

export const metadata: Metadata = {
  title: "SDK Keys — Switchyard",
};

// The selected environment travels in the query string: render per request.
export const dynamic = "force-dynamic";

export default function SdkKeysPage() {
  return (
    <Suspense>
      <SdkKeysClient />
    </Suspense>
  );
}
