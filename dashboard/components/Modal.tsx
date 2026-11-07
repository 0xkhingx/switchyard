"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { XmarkIcon } from "./icons";
import styles from "./Modal.module.css";

// Dialog shell on Base UI Dialog: focus trap, scroll lock, inert background,
// Escape / backdrop dismiss (nested selects and menus close first), and
// enter + exit transitions (.sy-backdrop / .sy-dialog in globals.css).
//
// Parents mount <Modal> while it should show and unmount it via onClose.
// Dismissals that start inside the dialog (X, Escape, backdrop, and any
// button using useModalClose) play the exit transition first, then call
// onClose. A parent that unmounts it directly (e.g. after a successful
// submit) closes it immediately.

const ModalCloseContext = createContext<() => void>(() => {});

/** Close the surrounding Modal with its exit animation (e.g. a Cancel button). */
export function useModalClose() {
  return useContext(ModalCloseContext);
}

/** A button that closes the surrounding Modal with its exit animation. */
export function ModalCancel(props: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "type">) {
  const close = useModalClose();
  return <button type="button" {...props} onClick={close} />;
}

const INITIAL_FOCUS =
  "[data-autofocus], input:not([type=hidden]):not([disabled]), textarea:not([disabled]), [data-slot=select-trigger]:not([disabled])";

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const popupRef = useRef<HTMLDivElement>(null);
  const requestClose = useCallback(() => setOpen(false), []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="sy-backdrop" />
        <Dialog.Popup
          ref={popupRef}
          className="sy-dialog"
          data-wide={wide || undefined}
          // Land on the first field (or an explicit [data-autofocus]), not the X.
          initialFocus={() => popupRef.current?.querySelector<HTMLElement>(INITIAL_FOCUS) ?? true}
        >
          <div className={styles.header}>
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className={styles.close} aria-label="Close dialog">
              <XmarkIcon size={15} />
            </Dialog.Close>
          </div>
          <div className={styles.body}>
            <ModalCloseContext.Provider value={requestClose}>{children}</ModalCloseContext.Provider>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Confirmation dialog. Focus lands on Cancel (the safe choice), not the
 * confirm action. Pass `error` to report a failed action inside the dialog;
 * keep the dialog mounted so the person can retry or cancel.
 */
export function ConfirmModal({
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  /** Shown above the actions in an always-mounted role="alert" region. */
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <ConfirmBody
        body={body}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        danger={danger}
        busy={busy}
        error={error}
        onConfirm={onConfirm}
      />
    </Modal>
  );
}

function ConfirmBody({
  body,
  confirmLabel,
  cancelLabel,
  danger,
  busy,
  error,
  onConfirm,
}: {
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
}) {
  const close = useModalClose();
  return (
    <>
      <Dialog.Description className={styles.confirmBody}>{body}</Dialog.Description>
      <div role="alert" className={error ? styles.confirmError : undefined}>
        {error}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={close}
          disabled={busy}
          data-autofocus
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={danger ? styles.dangerButton : styles.confirmButton}
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy}
        >
          {busy ? "Working…" : confirmLabel}
        </button>
      </div>
    </>
  );
}
