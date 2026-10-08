import { useCallback, useEffect, useRef, useState } from "react"
import { AlertCircle, Download, FolderOpen, Link2, Loader2, Search } from "lucide-react"
import { motion } from "motion/react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { fileKind } from "@/lib/file-type"
import { formatBytes } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { Settings } from "@/hooks/useSettings"
import type { Metadata } from "../../../shared/ipc"

const CONNECTION_CHOICES = [1, 2, 4, 8, 16]

const Spinner = motion.create(Loader2)

interface AddDownloadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-filled URL when opened from a deep link. */
  initialUrl: string
  settings: Settings
  onStarted: (
    id: string,
    url: string,
    filename: string,
    path: string,
    totalSize: number,
    connections: number
  ) => void
}

export function AddDownloadDialog({
  open,
  onOpenChange,
  initialUrl,
  settings,
  onStarted,
}: AddDownloadDialogProps) {
  const [url, setUrl] = useState("")
  const [filename, setFilename] = useState("")
  const [saveDir, setSaveDir] = useState("")
  const [connections, setConnections] = useState(settings.defaultConnections)
  const [metadata, setMetadata] = useState<Metadata | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  /** Guards against a slow metadata response landing after the dialog moved on. */
  const requestRef = useRef(0)

  const resolveSaveDir = useCallback(async () => {
    if (settings.saveDirectory) return settings.saveDirectory
    return window.kitsune.getDownloadsDir()
  }, [settings.saveDirectory])

  const fetchMetadata = useCallback(
    async (targetUrl: string) => {
      const trimmed = targetUrl.trim()
      if (!trimmed) return

      const request = ++requestRef.current
      setLoading(true)
      setError("")

      try {
        const meta = await window.kitsune.getMetadata(trimmed)
        if (request !== requestRef.current) return
        setMetadata(meta)
        setFilename(meta.filename)
      } catch (e) {
        if (request !== requestRef.current) return
        setMetadata(null)
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (request === requestRef.current) setLoading(false)
      }
    },
    []
  )

  // Reset to a clean sheet every time the dialog opens, then seed it from the
  // deep link (if any) and the user's defaults.
  useEffect(() => {
    if (!open) return

    requestRef.current += 1
    setUrl(initialUrl)
    setFilename("")
    setMetadata(null)
    setError("")
    setLoading(false)
    setConnections(settings.defaultConnections)

    void resolveSaveDir().then(setSaveDir).catch(() => setSaveDir(""))

    if (initialUrl && settings.autoFetchMetadata) {
      void fetchMetadata(initialUrl)
    }
  }, [open, initialUrl, settings.defaultConnections, settings.autoFetchMetadata, resolveSaveDir, fetchMetadata])

  const handleBrowse = async () => {
    const selected = await window.kitsune.pickDirectory("Choose save location")
    if (selected) setSaveDir(selected)
  }

  const handleStart = () => {
    if (!metadata || !filename || !saveDir) return

    const downloadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const path = `${saveDir.replace(/[/\\]+$/, "")}/${filename}`

    // Hand off before closing so the row is already on screen behind the dialog.
    onStarted(downloadId, url.trim(), filename, path, metadata.size, connections)
    onOpenChange(false)

    void window.kitsune
      .startDownload({ downloadId, url: url.trim(), path, connections })
      .catch((e) => console.error("start-download failed:", e))
  }

  const kind = fileKind(filename)
  const canStart = Boolean(metadata && filename && saveDir)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 p-0">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-4 w-4 text-primary" />
            New download
          </DialogTitle>
          <DialogDescription>
            Paste a link and Kitsune will fetch its details before starting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-6 py-5">
          <div className="space-y-1.5">
            <Label htmlFor="download-url">Source URL</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="download-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void fetchMetadata(url)}
                  placeholder="https://example.com/file.zip"
                  autoFocus
                  className="pl-9"
                />
              </div>
              <Button
                variant="secondary"
                onClick={() => void fetchMetadata(url)}
                disabled={loading || !url.trim()}
              >
                {loading ? (
                  <Spinner
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, ease: "linear", repeat: Infinity }}
                  />
                ) : <Search />}
                Fetch
              </Button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2.5 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          )}

          {metadata && (
            <>
              <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/30 px-3.5 py-3">
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                    kind.className
                  )}
                >
                  <kind.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {metadata.size > 0 ? formatBytes(metadata.size) : "Size unknown"}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="download-filename">Save as</Label>
                <Input
                  id="download-filename"
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="download-dir">Destination folder</Label>
                <div className="flex gap-2">
                  <Input
                    id="download-dir"
                    value={saveDir}
                    onChange={(e) => setSaveDir(e.target.value)}
                    className="flex-1 font-mono text-xs"
                  />
                  <Button variant="secondary" size="icon" onClick={() => void handleBrowse()}>
                    <FolderOpen />
                    <span className="sr-only">Browse</span>
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>Parallel connections</Label>
                <div className="flex gap-1.5">
                  {CONNECTION_CHOICES.map((n) => (
                    <button
                      key={n}
                      onClick={() => setConnections(n)}
                      className={cn(
                        "flex-1 rounded-md border py-2 text-sm font-medium tabular-nums transition-colors",
                        connections === n
                          ? "border-primary/50 bg-primary/15 text-primary"
                          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleStart} disabled={!canStart}>
            <Download />
            Start download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
