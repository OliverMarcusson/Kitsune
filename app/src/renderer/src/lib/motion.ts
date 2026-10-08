import { useCallback, useState } from "react"
import type { Transition } from "motion/react"

/** Overlays (dialogs, menus, tooltips) enter quickly and settle without overshoot. */
export const overlayTransition: Transition = { duration: 0.16, ease: [0.16, 1, 0.3, 1] }

/**
 * Radix keeps closed content mounted only for its own CSS exit animations.
 * Motion has to own the mount instead, so each overlay root tracks `open`
 * itself (controlled or not) and shares it with its content through context.
 */
export function useOpenState(
  open: boolean | undefined,
  defaultOpen = false,
  onOpenChange?: (open: boolean) => void
) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen)
  const setOpen = useCallback(
    (next: boolean) => {
      setUncontrolled(next)
      onOpenChange?.(next)
    },
    [onOpenChange]
  )
  return [open ?? uncontrolled, setOpen] as const
}
