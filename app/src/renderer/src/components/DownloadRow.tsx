import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Copy,
  FolderOpen,
  Layers,
  MoreVertical,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  X,
  Zap,
} from "lucide-react"
import { motion } from "motion/react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Download, DownloadStatus } from "@/hooks/useDownloads"
import { fileKind } from "@/lib/file-type"
import { formatBytes, formatEta, formatHost, formatRelativeTime, formatSpeed } from "@/lib/format"
import { cn } from "@/lib/utils"

const STATUS_META: Record<
  DownloadStatus,
  {
    label: string
    badge: "default" | "warning" | "success" | "destructive"
    indicator: string
  }
> = {
  downloading: { label: "Downloading", badge: "default", indicator: "bg-primary" },
  paused: { label: "Paused", badge: "warning", indicator: "bg-warning" },
  completed: { label: "Completed", badge: "success", indicator: "bg-success" },
  error: { label: "Failed", badge: "destructive", indicator: "bg-destructive" },
}

/**
 * One pip per configured connection, lit for the workers the sidecar currently
 * reports as active. Gives the parallelism a visible shape without needing any
 * extra data from the backend.
 */
function ConnectionPips({ total, active }: { total: number; active: number }) {
  // Very high connection counts would produce unreadable confetti.
  if (total > 16) {
    return (
      <span className="tabular-nums">
        {active}/{total} conn
      </span>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex items-center gap-[3px]">
          {Array.from({ length: total }, (_, index) => (
            <span
              key={index}
              className={cn(
                "h-3 w-[3px] rounded-full transition-colors",
                index < active ? "bg-primary" : "bg-secondary"
              )}
            />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {active} of {total} connections active
      </TooltipContent>
    </Tooltip>
  )
}

function IconButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string
  onClick: () => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" onClick={onClick} className={className}>
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

interface DownloadRowProps {
  download: Download
  onPause: (id: string) => void
  onResume: (id: string) => void
  onRemove: (id: string) => void
  onDismiss: (id: string) => void
  onOpenFolder: (path: string) => void
}

export function DownloadRow({
  download,
  onPause,
  onResume,
  onRemove,
  onDismiss,
  onOpenFolder,
}: DownloadRowProps) {
  const { filename, url, totalSize, downloadedBytes, speed, eta, status, connections, error, path } =
    download

  const meta = STATUS_META[status]
  const kind = fileKind(filename)
  const knownSize = totalSize > 0
  const progress = knownSize ? Math.min((downloadedBytes / totalSize) * 100, 100) : 0

  const copyUrl = () => {
    void navigator.clipboard.writeText(url)
    toast.success("Link copied")
  }

  return (
    <Card
      className={cn(
        "group relative overflow-hidden transition-colors hover:border-primary/30",
        status === "error" && "border-destructive/30"
      )}
    >
      {/* Left edge accent, so status reads before any text does. */}
      <span className={cn("absolute inset-y-0 left-0 w-0.5", meta.indicator)} />

      <div className="flex gap-3.5 p-4">
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            kind.className
          )}
        >
          <kind.icon className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium leading-tight">{filename}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {formatHost(url)}
                {status === "completed" && ` · ${formatRelativeTime(download.startedAt)}`}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              <Badge variant={meta.badge} className="mr-1">
                {status === "downloading" && (
                  <motion.span
                    className="h-1.5 w-1.5 rounded-full bg-current"
                    animate={{ opacity: [1, 0.4, 1] }}
                    transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity }}
                  />
                )}
                {status === "completed" && <CheckCircle2 className="h-3 w-3" />}
                {status === "error" && <AlertCircle className="h-3 w-3" />}
                {meta.label}
              </Badge>

              {status === "downloading" && (
                <IconButton label="Pause" onClick={() => onPause(download.id)}>
                  <Pause className="fill-current" />
                </IconButton>
              )}

              {status === "paused" && (
                <IconButton
                  label="Resume"
                  onClick={() => onResume(download.id)}
                  className="hover:text-success"
                >
                  <Play className="fill-current" />
                </IconButton>
              )}

              {status === "error" && (
                <IconButton
                  label="Retry"
                  onClick={() => onResume(download.id)}
                  className="hover:text-primary"
                >
                  <RotateCcw />
                </IconButton>
              )}

              {status === "completed" && (
                <IconButton
                  label="Show in folder"
                  onClick={() => onOpenFolder(path)}
                  className="hover:text-primary"
                >
                  <FolderOpen />
                </IconButton>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm">
                    <MoreVertical />
                    <span className="sr-only">More actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={copyUrl}>
                    <Copy />
                    Copy link
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onOpenFolder(path)}>
                    <FolderOpen />
                    Show in folder
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onDismiss(download.id)}>
                    <X />
                    Remove from list
                  </DropdownMenuItem>
                  <DropdownMenuItem destructive onSelect={() => onRemove(download.id)}>
                    <Trash2 />
                    Delete files
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {status === "error" && error ? (
            <p className="rounded-md border border-destructive/25 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
              {error}
            </p>
          ) : (
            <div className="space-y-2">
              {knownSize ? (
                <Progress value={progress} indicatorClassName={meta.indicator} />
              ) : (
                /* No Content-Length: show motion instead of a fake percentage. */
                <div className="relative h-1.5 overflow-hidden rounded-full bg-secondary">
                  {status === "downloading" && (
                    <motion.span
                      className="absolute inset-y-0 w-1/4 rounded-full bg-primary"
                      initial={{ x: "-100%" }}
                      animate={{ x: "400%" }}
                      transition={{ duration: 1.4, ease: "easeInOut", repeat: Infinity }}
                    />
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {formatBytes(downloadedBytes)}
                  {knownSize && ` / ${formatBytes(totalSize)}`}
                  {knownSize && (
                    <span className="ml-2 font-medium text-foreground">
                      {progress.toFixed(0)}%
                    </span>
                  )}
                </span>

                {status === "downloading" && (
                  <>
                    <span className="flex items-center gap-1.5 tabular-nums">
                      <Zap className="h-3.5 w-3.5 text-primary" />
                      {formatSpeed(speed)}
                    </span>
                    <span className="flex items-center gap-1.5 tabular-nums">
                      <Clock className="h-3.5 w-3.5" />
                      {formatEta(eta)}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Layers className="h-3.5 w-3.5" />
                      <ConnectionPips total={connections} active={download.activeConnections} />
                    </span>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
