import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { AnimatePresence, motion } from "motion/react"

import { cn } from "@/lib/utils"
import { overlayTransition, useOpenState } from "@/lib/motion"

const TooltipOpenContext = React.createContext(false)

const TooltipProvider = TooltipPrimitive.Provider

function Tooltip({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [isOpen, setOpen] = useOpenState(open, defaultOpen, onOpenChange)
  return (
    <TooltipOpenContext.Provider value={isOpen}>
      <TooltipPrimitive.Root open={isOpen} onOpenChange={setOpen} {...props} />
    </TooltipOpenContext.Provider>
  )
}
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, children, ...props }, ref) => {
  const open = React.useContext(TooltipOpenContext)
  return (
    <AnimatePresence>
      {open && (
        <TooltipPrimitive.Portal forceMount>
          <TooltipPrimitive.Content
            ref={ref}
            sideOffset={sideOffset}
            forceMount
            asChild
            {...props}
          >
            <motion.div
              className={cn(
                "z-50 overflow-hidden rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-xl",
                className
              )}
              style={{ transformOrigin: "var(--radix-tooltip-content-transform-origin)" }}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={overlayTransition}
            >
              {children}
            </motion.div>
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      )}
    </AnimatePresence>
  )
})
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
