import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Plus, Search, X } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { toast } from "sonner"

import { AddDownloadDialog } from "./components/AddDownloadDialog"
import { ConfirmDialog } from "./components/ConfirmDialog"
import { DownloadRow } from "./components/DownloadRow"
import { EmptyState } from "./components/EmptyState"
import { SettingsView } from "./components/SettingsView"
import { Sidebar, type View } from "./components/Sidebar"
import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"
import { ScrollArea } from "./components/ui/scroll-area"
import { Toaster } from "./components/ui/sonner"
import { TooltipProvider } from "./components/ui/tooltip"
import { useDownloads } from "./hooks/useDownloads"
import { useSettings } from "./hooks/useSettings"

const VIEW_TITLES: Record<View, string> = {
  all: "All downloads",
  downloading: "Active",
  paused: "Paused",
  completed: "Completed",
  error: "Failed",
  settings: "Settings",
}

const EMPTY_COPY: Record<Exclude<View, "settings">, { title: string; description: string }> = {
  all: {
    title: "No downloads yet",
    description:
      "Start one from here, or send a link over from your browser with the Kitsune extension.",
  },
  downloading: {
    title: "Nothing downloading",
    description: "Downloads currently in flight will appear here.",
  },
  paused: {
    title: "Nothing paused",
    description: "Downloads you pause will wait for you here.",
  },
  completed: {
    title: "Nothing finished yet",
    description: "Completed downloads collect here so you can find them later.",
  },
  error: {
    title: "No failures",
    description: "Downloads that error out will show up here with the reason why.",
  },
}

const FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.15, ease: "easeOut" },
} as const

function App() {
  const [view, setView] = useState<View>("all")
  const [query, setQuery] = useState("")
  const [addOpen, setAddOpen] = useState(false)
  const [pendingUrl, setPendingUrl] = useState("")
  /** Id awaiting confirmation for the destructive "delete files" removal. */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const { settings, updateSetting, resetSettings } = useSettings()
  const {
    downloads,
    addDownload,
    pauseDownload,
    resumeDownload,
    removeDownload,
    dismissDownload,
    openFolder,
  } = useDownloads()

  useEffect(() => {
    return window.kitsune.onDeepLink((incoming) => {
      setPendingUrl(incoming.trim().replace(/^"|"$/g, ""))
      setAddOpen(true)
    })
  }, [])

  useEffect(() => {
    return window.kitsune.onDownloadError(({ error }) => {
      toast.error("Download failed", { description: error })
    })
  }, [])

  // Progress events rewrite `downloads` several times a second, so the completion
  // listener reads the list through a ref instead of resubscribing that often.
  const downloadsRef = useRef(downloads)
  downloadsRef.current = downloads

  useEffect(() => {
    return window.kitsune.onDownloadCompleted(({ downloadId }) => {
      const finished = downloadsRef.current.find((d) => d.id === downloadId)
      toast.success("Download complete", { description: finished?.filename })
    })
  }, [])

  const counts = useMemo<Record<View, number>>(
    () => ({
      all: downloads.length,
      downloading: downloads.filter((d) => d.status === "downloading").length,
      paused: downloads.filter((d) => d.status === "paused").length,
      completed: downloads.filter((d) => d.status === "completed").length,
      error: downloads.filter((d) => d.status === "error").length,
      settings: 0,
    }),
    [downloads]
  )

  const totalSpeed = useMemo(
    () =>
      downloads.reduce((sum, d) => (d.status === "downloading" ? sum + d.speed : sum), 0),
    [downloads]
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return downloads
      .filter((d) => view === "all" || view === "settings" || d.status === view)
      .filter(
        (d) =>
          !needle ||
          d.filename.toLowerCase().includes(needle) ||
          d.url.toLowerCase().includes(needle)
      )
      .slice()
      .reverse() // Newest first.
  }, [downloads, view, query])

  const openAddDialog = useCallback(() => {
    setPendingUrl("")
    setAddOpen(true)
  }, [])

  const requestRemove = useCallback(
    (id: string) => {
      if (settings.confirmDelete) {
        setPendingDelete(id)
        return
      }
      void removeDownload(id)
    },
    [settings.confirmDelete, removeDownload]
  )

  const targetOfPendingDelete = downloads.find((d) => d.id === pendingDelete)

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen overflow-hidden bg-background">
        <Sidebar
          view={view}
          onViewChange={setView}
          counts={counts}
          totalSpeed={totalSpeed}
          activeCount={counts.downloading}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
            <h1 className="text-sm font-semibold">{VIEW_TITLES[view]}</h1>

            {view !== "settings" && (
              <>
                <div className="relative ml-auto w-64">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search downloads"
                    className="h-8 pl-8 pr-8 text-xs"
                  />
                  {query && (
                    <button
                      onClick={() => setQuery("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                      <span className="sr-only">Clear search</span>
                    </button>
                  )}
                </div>

                <Button size="sm" onClick={openAddDialog}>
                  <Plus />
                  Add download
                </Button>
              </>
            )}
          </header>

          <ScrollArea className="flex-1">
            {view === "settings" ? (
              <SettingsView
                settings={settings}
                onUpdate={updateSetting}
                onReset={resetSettings}
              />
            ) : (
              /* Crossfade between the list and the empty state, so the first row
                 arriving and the last one leaving are not hard cuts. */
              <AnimatePresence mode="wait" initial={false}>
                {visible.length === 0 ? (
                  <motion.div key="empty" className="h-[calc(100vh-3.5rem)]" {...FADE}>
                    {query ? (
                      <EmptyState
                        title="No matches"
                        description={`Nothing here matches "${query.trim()}".`}
                      />
                    ) : (
                      <EmptyState
                        {...EMPTY_COPY[view]}
                        onAdd={view === "all" ? openAddDialog : undefined}
                      />
                    )}
                  </motion.div>
                ) : (
                  <motion.div key="list" className="relative space-y-2.5 p-5" {...FADE}>
                    {/* New rows drop in and removed ones fade while the rest close the gap.
                        ponytail: `layout` measures every row on each progress tick; fine for
                        dozens of rows, virtualize the list if it ever holds hundreds. */}
                    <AnimatePresence initial={false} mode="popLayout">
                      {visible.map((download) => (
                        <motion.div
                          key={download.id}
                          layout="position"
                          initial={{ opacity: 0, y: -8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.98 }}
                          transition={{ duration: 0.2, ease: "easeOut" }}
                        >
                          <DownloadRow
                            download={download}
                            onPause={pauseDownload}
                            onResume={resumeDownload}
                            onRemove={requestRemove}
                            onDismiss={dismissDownload}
                            onOpenFolder={openFolder}
                          />
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </motion.div>
                )}
              </AnimatePresence>
            )}
          </ScrollArea>
        </div>

        <AddDownloadDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          initialUrl={pendingUrl}
          settings={settings}
          onStarted={(id, url, filename, path, totalSize, connections) =>
            addDownload({ id, url, filename, path, totalSize, connections })
          }
        />

        <ConfirmDialog
          open={pendingDelete !== null}
          onOpenChange={(open) => !open && setPendingDelete(null)}
          title="Delete downloaded files?"
          description={
            targetOfPendingDelete
              ? `"${targetOfPendingDelete.filename}" will be removed from the list and erased from disk. This cannot be undone.`
              : ""
          }
          confirmLabel="Delete files"
          onConfirm={() => {
            if (pendingDelete) void removeDownload(pendingDelete)
          }}
        />

        <Toaster />
      </div>
    </TooltipProvider>
  )
}

export default App
