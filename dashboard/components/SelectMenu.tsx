"use client";

import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Leading visual, e.g. an environment status dot. */
  icon?: ReactNode;
  /** Muted trailing text shown in the menu only. */
  hint?: ReactNode;
}

/**
 * Drop-in replacement for a native <select> with the shared glass popup.
 * Label it with `ariaLabel`, or with `id` plus an external <label htmlFor>.
 */
export function SelectMenu<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  id,
  variant = "field",
  disabled,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  ariaLabel?: string;
  id?: string;
  variant?: "field" | "ghost";
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v != null) onChange(v as T);
      }}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} variant={variant} className={className}>
        <SelectValue>
          {(v: T) => {
            const o = options.find((opt) => opt.value === v);
            return o ? (
              <>
                {o.icon}
                <span className="truncate">{o.label}</span>
              </>
            ) : null;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.icon}
            {o.label}
            {o.hint && <span className="sy-item-hint">{o.hint}</span>}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
