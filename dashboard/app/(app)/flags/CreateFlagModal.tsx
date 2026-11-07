"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal, ModalCancel } from "@/components/Modal";
import { apiPost, type FlagKind } from "@/lib/api";
import styles from "./flags.module.css";
import { SelectMenu } from "@/components/SelectMenu";

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function CreateFlagModal({
  projectKey,
  envKey,
  onClose,
  onCreated,
}: {
  projectKey: string;
  /** Current environment, carried to the new flag's page. */
  envKey?: string;
  onClose: () => void;
  onCreated: (flagKey: string) => void;
}) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<FlagKind>("bool");
  const [description, setDescription] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = key.trim();
    if (!KEY_RE.test(trimmed)) {
      setKeyError("Use lowercase letters, numbers, and . _ - (up to 64 characters).");
      return;
    }
    setKeyError(null);
    setFormError(null);
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectKey}/flags`, {
        key: trimmed,
        type: kind,
        description,
      });
      onCreated(trimmed);
      // Carry project + env so the detail page loads the right project.
      const sp = new URLSearchParams({ project: projectKey });
      if (envKey) sp.set("env", envKey);
      router.push(`/flags/${encodeURIComponent(trimmed)}?${sp.toString()}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the flag.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Create flag" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {/* Always-mounted live region; the message is inserted on failure. */}
        <div role="alert">{formError && <p className={styles.modalError}>{formError}</p>}</div>
        <div className={styles.modalField}>
          <label htmlFor="new-flag-key">Key</label>
          <input
            id="new-flag-key"
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="new-checkout"
            aria-invalid={keyError ? true : undefined}
            aria-describedby={keyError ? "new-flag-key-error" : "new-flag-key-hint"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            autoFocus
          />
          {keyError ? (
            <p className={styles.modalFieldError} id="new-flag-key-error">
              {keyError}
            </p>
          ) : (
            <p className={styles.modalHint} id="new-flag-key-hint">
              Lowercase letters, numbers, dots, dashes and underscores. Can&apos;t be changed later.
            </p>
          )}
        </div>
        <div className={styles.modalField}>
          <label htmlFor="new-flag-type">Type</label>
          <SelectMenu<FlagKind>
            id="new-flag-type"
            className="w-full"
            value={kind}
            onChange={setKind}
            options={[
              { value: "bool", label: "Boolean", hint: "true / false" },
              { value: "string", label: "String", hint: "text variants" },
            ]}
          />
        </div>
        <div className={styles.modalField}>
          <label htmlFor="new-flag-desc">
            Description <span className={styles.optional}>(optional)</span>
          </label>
          <input
            id="new-flag-desc"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this flag control?"
          />
        </div>
        <div className={styles.modalActions}>
          <ModalCancel className={styles.cancelButton} disabled={busy}>
            Cancel
          </ModalCancel>
          <button type="submit" className={styles.confirmButton} disabled={busy} aria-busy={busy}>
            {busy ? "Creating…" : "Create flag"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
