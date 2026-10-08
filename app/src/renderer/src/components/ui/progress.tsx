import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"
import { motion } from "motion/react"

import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indicatorClassName?: string }
>(({ className, value, indicatorClassName, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-secondary", className)}
    value={value}
    {...props}
  >
    <ProgressPrimitive.Indicator asChild>
      <motion.div
        className={cn("h-full w-full flex-1 rounded-full bg-primary", indicatorClassName)}
        initial={false}
        animate={{ x: `-${100 - (value ?? 0)}%` }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      />
    </ProgressPrimitive.Indicator>
  </ProgressPrimitive.Root>
))
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
