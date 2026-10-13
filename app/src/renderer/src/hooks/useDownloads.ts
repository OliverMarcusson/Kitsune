import { useState, useEffect, useRef, useCallback } from "react";
import { toast } from "sonner";
import type {
  CompletedPayload,
  ErrorPayload,
  PausedPayload,
  PersistedDownload,
  ProgressPayload,
} from "../../../shared/ipc";

export type DownloadStatus = "downloading" | "completed" | "error" | "paused" | "queued";

export interface Download {
  id: string;
  url: string;
  filename: string;
  path: string;
  totalSize: number;
  downloadedBytes: number;
  speed: number;
  eta: number;
  status: DownloadStatus;
  /** Connection count the download was started with; reused when resuming. */
  connections: number;
  /** Workers the sidecar currently reports as live. Never persisted. */
  activeConnections: number;
  error?: string;
  startedAt: number;
  kind?: "http" | "torrent";
}


function toPersistedDownload(d: Download): PersistedDownload {
  return {
    id: d.id,
    url: d.url,
    filename: d.filename,
    path: d.path,
    total_size: d.totalSize,
    downloaded_bytes: d.downloadedBytes,
    status: d.status,
    connections: d.connections,
    started_at: d.startedAt,
    kind: d.kind,
  };
}

function fromPersistedDownload(p: PersistedDownload): Download {
  return {
    id: p.id,
    url: p.url,
    filename: p.filename,
    path: p.path,
    totalSize: p.total_size,
    downloadedBytes: p.downloaded_bytes,
    speed: 0,
    eta: 0,
    status: p.status === "downloading" ? "paused" : (p.status as DownloadStatus),
    connections: p.connections,
    activeConnections: 0,
    startedAt: p.started_at,
    kind: p.kind,
  };
}

export function useDownloads() {
  const [downloads, setDownloads] = useState<Download[]>([]);
  const speedWindowRef = useRef<Map<string, { time: number; bytes: number }[]>>(new Map());
  const initializedRef = useRef(false);

  const addDownload = useCallback((
    download: Omit<
      Download,
      "downloadedBytes" | "speed" | "eta" | "status" | "startedAt" | "activeConnections"
    >
  ) => {
    const newDownload: Download = {
      ...download,
      downloadedBytes: 0,
      speed: 0,
      eta: 0,
      status: "queued",
      activeConnections: 0,
      startedAt: Date.now(),
    };
    setDownloads(prev => [...prev, newDownload]);
    speedWindowRef.current.set(download.id, []);
    return newDownload.id;
  }, []);

  const pauseDownload = useCallback((id: string) => {
    void window.kitsune.cancelDownload(id).catch(error => toast.error("Could not pause download", { description: error.message }));
  }, []);

  const resumeDownload = useCallback((id: string) => {
    const target = downloads.find(d => d.id === id);
    if (!target) return;

    // Retrying a failed download must clear the stale error off the row.
    setDownloads(prev => prev.map(d =>
      d.id === id ? { ...d, status: "downloading", error: undefined } : d
    ));
    void window.kitsune.startDownload({
      downloadId: target.id,
      url: target.url,
      path: target.path,
      connections: target.connections,
      kind: target.kind,
    }).catch(error => setDownloads(prev => prev.map(d => d.id === id ? { ...d, status: "error", error: error.message } : d)));
  }, [downloads]);

  const removeDownload = useCallback(async (id: string) => {
    const target = downloads.find(d => d.id === id);
    if (!target) return;

    try {
      await window.kitsune.deleteDownload({ downloadId: id, url: target.url, path: target.path, connections: target.connections, kind: target.kind });
      setDownloads(prev => prev.filter(d => d.id !== id));
    } catch (error) { toast.error("Could not delete files", { description: (error as Error).message }); }
  }, [downloads]);

  const dismissDownload = useCallback(async (id: string) => {
    const target = downloads.find(d => d.id === id);
    if (!target) return;

    try {
      await window.kitsune.forgetDownload(id);
      setDownloads(prev => prev.filter(d => d.id !== id));
    } catch (error) { toast.error("Could not remove download", { description: (error as Error).message }); }
  }, [downloads]);

  const replaceUrl = useCallback(async (id: string, url: string) => {
    await window.kitsune.replaceUrl(id, url);
    setDownloads(prev => prev.map(d => d.id === id ? { ...d, url, status: "paused", error: undefined } : d));
  }, []);

  const openFolder = useCallback((path: string) => {
    void window.kitsune.showInFolder(path);
  }, []);

  useEffect(() => {
    window.kitsune.loadState().then(persisted => {
      if (persisted.length > 0) {
        setDownloads(persisted.map(fromPersistedDownload));
      }
      initializedRef.current = true;
      void window.kitsune.restoreQueue(persisted);
    }).catch(() => { initializedRef.current = true; });
  }, []);

  useEffect(() => {
    if (!initializedRef.current) return;
    const persisted = downloads.map(toPersistedDownload);
    void window.kitsune.saveState(persisted);
  }, [downloads]);

  useEffect(() => {
    const unlistenStarted = window.kitsune.onDownloadStarted(payload => {
      speedWindowRef.current.set(payload.downloadId, []);
      setDownloads(prev => prev.map(d => d.id === payload.downloadId ? {
        ...d, downloadedBytes: payload.downloadedBytes, totalSize: payload.totalSize,
        filename: payload.filename || d.filename,
      } : d));
    });
    const unlistenState = window.kitsune.onDownloadState(payload => {
      speedWindowRef.current.delete(payload.downloadId);
      setDownloads(prev => prev.map(d => d.id === payload.downloadId ? {
        ...d, status: payload.status, error: undefined, speed: 0, eta: 0, activeConnections: 0,
      } : d));
    });
    const unlistenProgress = window.kitsune.onDownloadProgress((payload: ProgressPayload) => {
      const { downloadId, bytesDownloaded, activeWorkers } = payload;
      const now = Date.now();

      setDownloads(prev => {
        const target = prev.find(d => d.id === downloadId);
        if (!target) return prev;

        const win = speedWindowRef.current.get(downloadId) ?? [];
        win.push({ time: now, bytes: bytesDownloaded });
        const cutoff = now - 2000;
        const trimmed = win.filter(e => e.time >= cutoff);
        speedWindowRef.current.set(downloadId, trimmed);

        const windowBytes = trimmed.reduce((sum, e) => sum + e.bytes, 0);
        const windowMs = trimmed.length > 1
          ? trimmed[trimmed.length - 1].time - trimmed[0].time
          : 1000;
        const speed = windowMs > 0 ? (windowBytes / windowMs) * 1000 : 0;

        const newDownloaded = target.totalSize > 0
          ? Math.min(target.downloadedBytes + bytesDownloaded, target.totalSize)
          : target.downloadedBytes + bytesDownloaded;
        const remaining = target.totalSize > 0 ? target.totalSize - newDownloaded : 0;
        const eta = speed > 0 && remaining > 0 ? remaining / speed : 0;

        return prev.map(d =>
          d.id === downloadId
            ? { ...d, downloadedBytes: newDownloaded, speed, eta, activeConnections: activeWorkers }
            : d
        );
      });
    });

    const unlistenCompleted = window.kitsune.onDownloadCompleted((payload: CompletedPayload) => {
      setDownloads(prev =>
        prev.map(d =>
          d.id === payload.downloadId
            ? {
                ...d,
                status: "completed" as DownloadStatus,
                speed: 0,
                eta: 0,
                activeConnections: 0,
                // A completed download with no Content-Length still ended up
                // this many bytes long, so the row can stop saying "unknown".
                totalSize: d.totalSize > 0 ? d.totalSize : d.downloadedBytes,
              }
            : d
        )
      );
    });

    const unlistenError = window.kitsune.onDownloadError((payload: ErrorPayload) => {
      setDownloads(prev =>
        prev.map(d =>
          d.id === payload.downloadId
            ? {
                ...d,
                status: "error" as DownloadStatus,
                error: payload.error,
                speed: 0,
                eta: 0,
                activeConnections: 0,
              }
            : d
        )
      );
    });

    const unlistenPaused = window.kitsune.onDownloadPaused((payload: PausedPayload) => {
      setDownloads(prev =>
        prev.map(d =>
          d.id === payload.downloadId
            ? { ...d, status: "paused" as DownloadStatus, speed: 0, eta: 0, activeConnections: 0 }
            : d
        )
      );
    });

    return () => {
      unlistenProgress();
      unlistenCompleted();
      unlistenError();
      unlistenPaused();
      unlistenStarted();
      unlistenState();
    };
  }, []);

  return { 
    downloads, 
    addDownload, 
    pauseDownload, 
    resumeDownload, 
    removeDownload, 
    dismissDownload, 
    openFolder,
    replaceUrl,
  };
}
