"use client"

import * as React from "react"

/**
 * A single highlight pill that glides to whichever item Base UI marks with
 * `data-highlighted` (pointer hover or keyboard). Render it as the first
 * child of a `.sy-popup`; items sit above it (`.sy-item` has z-index 1).
 * Styling lives in globals.css (`.sy-highlight`).
 */
export function PopupHighlight() {
  const ref = React.useRef<HTMLSpanElement>(null)

  React.useLayoutEffect(() => {
    const pill = ref.current
    const root = pill?.parentElement
    if (!pill || !root) return

    let visible = false

    const update = () => {
      const item = root.querySelector<HTMLElement>("[data-highlighted]")
      if (!item) {
        pill.style.opacity = "0"
        visible = false
        return
      }
      const rootRect = root.getBoundingClientRect()
      const rect = item.getBoundingClientRect()
      const x = rect.left - rootRect.left - root.clientLeft + root.scrollLeft
      const y = rect.top - rootRect.top - root.clientTop + root.scrollTop

      // First appearance snaps into place; after that, glide between items.
      if (!visible) pill.style.transition = "none"
      pill.style.transform = `translate(${x}px, ${y}px)`
      pill.style.width = `${rect.width}px`
      pill.style.height = `${rect.height}px`
      if (item.dataset.variant) pill.dataset.variant = item.dataset.variant
      else delete pill.dataset.variant
      if (!visible) {
        void pill.offsetWidth // commit the snapped position before re-enabling transitions
        pill.style.transition = ""
      }
      pill.style.opacity = "1"
      visible = true
    }

    const observer = new MutationObserver(update)
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["data-highlighted"],
    })
    update()
    return () => observer.disconnect()
  }, [])

  return <span ref={ref} className="sy-highlight" aria-hidden="true" />
}
