import type { Metadata } from "next";
import { Suspense } from "react";
import { DetailClient } from "./DetailClient";

export const metadata: Metadata = {
  title: "Flag detail — Switchyard",
};

// Project/env context travels in the query string: render per request.
export const dynamic = "force-dynamic";

export default function FlagDetailPage({ params }: { params: { key: string } }) {
  return (
    <Suspense>
      <DetailClient flagKey={decodeURIComponent(params.key)} />
    </Suspense>
  );
}
