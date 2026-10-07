"use client";

import { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

// Temporary landing: confirms the session works after login.
// Replaced by the real dashboard in M4.
export default function Home() {
  const [email, setEmail] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}/api/me`, { credentials: "include" })
      .then((res) => (res.ok ? res.json() : null))
      .then((me) => setEmail(me?.email ?? null))
      .catch(() => setEmail(null))
      .finally(() => setChecked(true));
  }, []);

  useEffect(() => {
    if (checked && !email) window.location.href = "/login";
  }, [checked, email]);

  async function signOut() {
    await fetch(`${API_URL}/api/auth/logout`, { method: "POST", credentials: "include" });
    window.location.href = "/login";
  }

  if (!checked || !email) return null;
  return (
    <main style={{ padding: 48, fontFamily: "inherit" }}>
      <h1>Signed in as {email}</h1>
      <p>The flag dashboard lands here in M4.</p>
      <button type="button" onClick={signOut}>
        Sign out
      </button>
    </main>
  );
}
