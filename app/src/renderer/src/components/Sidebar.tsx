import {
  AlertCircle,
  ArrowDownToLine,
  CheckCircle2,
  Inbox,
  Pause,
  Settings,
  type LucideIcon,
} from "lucide-react"
import { AnimatePresence, motion } from "motion/react"

import logoUrl from "@/assets/logo.png"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { formatSpeed } from "@/lib/format"
import type { DownloadStatus } from "@/hooks/useDownloads"

/** "settings" is a peer of the status filters rather than a separate route. */
export type View = "all" | DownloadStatus | "settings"

interface NavItem {
  view: View
  label: string
  icon: LucideIcon
  /** Tint applied to the icon when the item is active. */
  activeIcon: string
}

const NAV_ITEMS: NavItem[] = [
  { view: "all", label: "All", icon: Inbox, activeIcon: "text-primary" },
  { view: "downloading", label: "Active", icon: ArrowDownToLine, activeIcon: "text-primary" },
  { view: "paused", label: "Paused", icon: Pause, activeIcon: "text-warning" },
  { view: "completed", label: "Completed", icon: CheckCircle2, activeIcon: "text-success" },
  { view: "error", label: "Failed", icon: AlertCircle, activeIcon: "text-destructive" },
]

const MotionSettings = motion.create(Settings)

/**
 * The active item's background. Shared layoutId lets it glide between items,
 * including down to Settings, so the eye follows where the view went.
 */
function ActiveHighlight() {
  return (
    <motion.span
      layoutId="sidebar-active"
      className="absolute inset-0 -z-10 rounded-md bg-primary/15"
      transition={{ type: "spring", stiffness: 500, damping: 40 }}
    />
  )
}

interface SidebarProps {
  view: View
  onViewChange: (view: View) => void
  counts: Record<View, number>
  totalSpeed: number
  activeCount: number
}

export function Sidebar({ view, onViewChange, counts, totalSpeed, activeCount }: SidebarProps) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-aurora bg-card/40">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <img src={logoUrl} alt="" className="h-8 w-8 object-contain" />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-none">Kitsune</p>
          <p className="mt-1 text-[11px] leading-none text-muted-foreground">Download Manager</p>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 px-2 py-2">
        {NAV_ITEMS.map((item) => {
          const isActive = view === item.view
          const count = counts[item.view]

          return (
            <button
              key={item.view}
              onClick={() => onViewChange(item.view)}
              className={cn(
                "group relative isolate flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                isActive
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              )}
            >
              {isActive && <ActiveHighlight />}
              <item.icon
                className={cn(
                  "h-4 w-4 shrink-0 transition-colors",
                  isActive ? item.activeIcon : "text-muted-foreground group-hover:text-foreground"
                )}
              />
              <span className="flex-1 text-left">{item.label}</span>
              {count > 0 && (
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
                    isActive ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground"
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="mt-auto px-2 pb-2">
        <Separator className="my-2" />

        <motion.button
          onClick={() => onViewChange("settings")}
          className={cn(
            "group relative isolate flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
            view === "settings"
              ? "font-medium text-foreground"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          )}
          initial={false}
          animate={view === "settings" ? "active" : "rest"}
          whileHover="hover"
        >
          {view === "settings" && <ActiveHighlight />}
          <MotionSettings
            className={cn("h-4 w-4 shrink-0", view === "settings" && "text-primary")}
            variants={{ rest: { rotate: 0 }, hover: { rotate: 90 }, active: { rotate: 90 } }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
          Settings
        </motion.button>

        {/* Live throughput readout. Hidden entirely when nothing is running so
            the sidebar does not show a permanent "0 B/s". */}
        <AnimatePresence initial={false}>
          {activeCount > 0 && (
            <motion.div
              className="mt-2 rounded-md border border-primary/20 bg-primary/10 px-3 py-2.5"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {activeCount} active
              </p>
              <p className="mt-1 font-semibold tabular-nums text-primary">
                {formatSpeed(totalSpeed)}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </aside>
  )
}
