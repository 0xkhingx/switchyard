"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal } from "@/components/Modal";
import { apiPost, type FlagKind } from "@/lib/api";
import styles from "./flags.module.css";

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function CreateFlagModal({
  projectKey,
  onClose,
  onCreated,
}: {
  projectKey: string;
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
      router.push(`/flags/${encodeURIComponent(trimmed)}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the flag.");
      setBusy(false);
    }
  }

  return (
    <Modal title="Create flag" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        {formError && (
          <p className={styles.modalError} role="alert">
            {formError}
          </p>
        )}
        <div className={styles.modalField}>
          <label htmlFor="new-flag-key">Key</label>
          <input
            id="new-flag-key"
            type="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="new-checkout"
            aria-invalid={keyError ? true : undefined}
            aria-describedby={keyError ? "new-flag-key-error" : undefined}
            autoFocus
          />
          {keyError ? (
            <p className={styles.modalFieldError} id="new-flag-key-error">
              {keyError}
            </p>
          ) : (
            <p className={styles.modalHint}>Required, immutable after creation.</p>
          )}
        </div>
        <div className={styles.modalField}>
          <label htmlFor="new-flag-type">Type</label>
          <select id="new-flag-type" value={kind} onChange={(e) => setKind(e.target.value as FlagKind)}>
            <option value="bool">Boolean</option>
            <option value="string">String</option>
          </select>
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
          <button type="button" className={styles.cancelButton} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={styles.confirmButton} disabled={busy}>
            {busy ? "Creating…" : "Create flag"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
