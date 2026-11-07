"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { cn } from "cn"

// Visuals live in globals.css (.sy-tooltip).

/**
 * One provider at the app root groups tooltips: after the first opens,
 * moving to a neighbour opens it instantly (Base UI sets data-instant).
 */
function TooltipProvider({ delay = 350, closeDelay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} closeDelay={closeDelay} {...props} />
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 8,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup data-slot="tooltip-content" className={cn("sy-tooltip", className)} {...props}>
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/**
 * Tooltip for a single element: `<Hint label="Delete rule"><button …/></Hint>`.
 * The child becomes the trigger (no wrapper element), so it must be a DOM
 * element. For disabled controls, pass `focusable`: disabled elements get no
 * pointer or focus events, so the child is wrapped in a focusable span and
 * the reason stays reachable by mouse and keyboard.
 */
function Hint({
  label,
  children,
  side = "top",
  focusable = false,
}: {
  /** Empty/undefined renders the child unchanged (for conditional hints). */
  label?: React.ReactNode
  children: React.ReactElement
  side?: TooltipPrimitive.Positioner.Props["side"]
  focusable?: boolean
}) {
  if (label == null || label === false || label === "") return children
  const trigger = focusable ? (
    <span className="inline-flex rounded-[var(--radius-control)] outline-none focus-visible:shadow-[var(--focus-ring)]" tabIndex={0}>
      {children}
    </span>
  ) : (
    children
  )
  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}

export { Hint, Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
