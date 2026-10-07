import type { Metadata } from "next";
import Image from "next/image";
import { LoginForm } from "./LoginForm";
import styles from "./login.module.css";

export const metadata: Metadata = {
  title: "Sign in — Switchyard",
};

export default function LoginPage() {
  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <section className={styles.formSide}>
          <div className={styles.formInner}>
            <Image
              src="/logo-lockup.png"
              alt="Switchyard"
              width={260}
              height={73}
              priority
              className={styles.logo}
            />
            <h1 className={styles.heading}>Sign in to your account</h1>
            <p className={styles.sub}>
              Manage feature flags, ship safely, and keep full control across your environments.
            </p>
            <LoginForm />
            <hr className={styles.divider} />
            <p className={styles.helper}>Need access? Ask your project admin to create an account.</p>
          </div>
        </section>
        <section className={styles.artSide} aria-hidden="true">
          <div className={styles.artCopy}>
            <h2 className={styles.artHeading}>Turn ideas into control.</h2>
            <p className={styles.artBody}>
              Feature flags for modern teams.
              <br />
              Simple. Flexible. Built to ship.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
