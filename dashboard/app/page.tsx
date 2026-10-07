"use client";

import { useEffect } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

// Root lands on the flags dashboard; unauthenticated visitors go to login.
export default function Home() {
  useEffect(() => {
    fetch(`${API_URL}/api/me`, { credentials: "include" })
      .then((res) => {
        window.location.href = res.ok ? "/flags" : "/login";
      })
      .catch(() => {
        window.location.href = "/login";
      });
  }, []);
  return null;
}
