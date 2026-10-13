import { useCallback, useEffect, useState } from "react"
import { DEFAULT_TRANSFERS } from "../../../shared/transfer-policy"
import type { TransferSettings } from "../../../shared/ipc"
import { toast } from "sonner"

/**
 * User preferences. These live in the renderer's localStorage rather than in
 * state.json: they are UI defaults only, and nothing in the main process or the
 * sidecar needs to read them.
 */
export interface Settings extends TransferSettings {
  /** Connection count pre-selected for a new download. */
  defaultConnections: number
  /** Overrides the OS downloads folder when set. */
  saveDirectory: string | null
  /** Fetch metadata as soon as a URL arrives, instead of waiting for "Fetch". */
  autoFetchMetadata: boolean
  /** Ask before the destructive "delete files" removal. */
  confirmDelete: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_TRANSFERS,
  defaultConnections: 8,
  saveDirectory: null,
  autoFetchMetadata: true,
  confirmDelete: true,
}

const STORAGE_KEY = "kitsune.settings"

function readSettings(): Settings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    // Spread over the defaults so a settings file written by an older build
    // still gets sane values for keys added since.
    const saved = JSON.parse(raw) as Partial<Settings>
    return { ...DEFAULT_SETTINGS, ...saved, schedule: { ...DEFAULT_TRANSFERS.schedule, ...saved.schedule } }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(readSettings)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      /* Storage being unavailable must not take the UI down. */
    }
  }, [settings])

  useEffect(() => {
    void window.kitsune.configureTransfers({
      speedLimit: settings.speedLimit, slowMode: settings.slowMode, slowSpeed: settings.slowSpeed,
      maxActive: settings.maxActive, schedule: settings.schedule,
    }).catch(error => toast.error("Could not apply transfer controls", { description: error.message }))
  }, [settings.speedLimit, settings.slowMode, settings.slowSpeed, settings.maxActive, settings.schedule])

  const updateSetting = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }, [])

  const resetSettings = useCallback(() => setSettings(DEFAULT_SETTINGS), [])

  return { settings, updateSetting, resetSettings }
}
