"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EyeClosedIcon, EyeIcon } from "@/components/icons";
import styles from "./login.module.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Status = "idle" | "submitting";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  const submitting = status === "submitting";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    const nextEmailError = !email
      ? "Email is required."
      : !EMAIL_RE.test(email)
        ? "Enter a valid email address."
        : null;
    const nextPasswordError = !password ? "Password is required." : null;
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    setFormError(null);
    if (nextEmailError || nextPasswordError) return;

    setStatus("submitting");
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        window.location.href = "/flags";
        return;
      }
      // Any failure reads the same: never reveal whether the email exists.
      // The password is cleared; the email is preserved for retry.
      setPassword("");
      if (res.status === 429) {
        // Server throttles repeated failures per IP and per email.
        const secs = Number(res.headers.get("retry-after"));
        const mins = Number.isFinite(secs) && secs > 0 ? Math.ceil(secs / 60) : null;
        setFormError(
          mins
            ? `Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`
            : "Too many sign-in attempts. Wait a few minutes and try again.",
        );
        return;
      }
      setFormError(
        res.status === 401
          ? "Incorrect email or password."
          : "Could not reach the server. Check your connection and try again.",
      );
    } catch {
      setPassword("");
      setFormError("Could not reach the server. Check your connection and try again.");
    } finally {
      setStatus("idle");
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate={false}>
      {/* Always-mounted live region; the message is inserted on failure. */}
      <div role="alert">{formError && <p className={styles.formError}>{formError}</p>}</div>

      <div className={styles.field}>
        <Label className={styles.label} htmlFor="login-email">
          Email
        </Label>
        <Input
          id="login-email"
          className={styles.input}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? "login-email-error" : undefined}
          required
        />
        {emailError && (
          <p className={styles.fieldError} id="login-email-error">
            {emailError}
          </p>
        )}
      </div>

      <div className={styles.field}>
        <Label className={styles.label} htmlFor="login-password">
          Password
        </Label>
        <div className={styles.passwordWrap}>
          <Input
            id="login-password"
            className={styles.input}
            type={showPassword ? "text" : "password"}
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? "login-password-error" : undefined}
            required
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={styles.eyeButton}
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
            tabIndex={0}
          >
            {showPassword ? <EyeClosedIcon /> : <EyeIcon />}
          </Button>
        </div>
        {passwordError && (
          <p className={styles.fieldError} id="login-password-error">
            {passwordError}
          </p>
        )}
      </div>

      <Button type="submit" className={styles.submit} disabled={submitting} aria-busy={submitting}>
        {submitting ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
