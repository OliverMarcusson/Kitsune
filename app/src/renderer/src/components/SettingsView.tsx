import { FolderOpen, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type { Settings } from "@/hooks/useSettings"

const CONNECTION_CHOICES = [1, 2, 4, 8, 16]

function Row({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Field orientation="horizontal" className="justify-between px-5 py-4">
      <FieldContent>
        <FieldTitle>{title}</FieldTitle>
        <FieldDescription>{description}</FieldDescription>
      </FieldContent>
      <div className="shrink-0">{children}</div>
    </Field>
  )
}

interface SettingsViewProps {
  settings: Settings
  onUpdate: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  onReset: () => void
}

export function SettingsView({ settings, onUpdate, onReset }: SettingsViewProps) {
  const chooseDirectory = async () => {
    const selected = await window.kitsune.pickDirectory("Choose default download folder")
    if (selected) {
      onUpdate("saveDirectory", selected)
      toast.success("Default folder updated")
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Defaults applied to every new download.
        </p>
      </div>

      <Card className="divide-y divide-border">
        <Row title="Total download speed" description="Shared by direct downloads and torrents. Zero means unlimited.">
          <Label htmlFor="speed-limit" className="sr-only">Total speed in MiB/s</Label>
          <div className="flex items-center gap-2">
            <Input id="speed-limit" type="number" min="0" max="9536" step="0.25" className="w-24" value={settings.speedLimit / 1048576} onChange={event => onUpdate("speedLimit", Math.max(0, Math.round(Number(event.target.value) * 1048576)))} />
            <span className="text-xs text-muted-foreground">MiB/s</span>
          </div>
        </Row>
        <Row title="Slow mode speed" description="The header button switches all downloads to this limit immediately.">
          <Label htmlFor="slow-speed" className="sr-only">Slow mode speed in MiB/s</Label>
          <div className="flex items-center gap-2">
            <Input id="slow-speed" type="number" min="0.25" max="9536" step="0.25" className="w-24" value={settings.slowSpeed / 1048576} onChange={event => onUpdate("slowSpeed", Math.max(262144, Math.round(Number(event.target.value) * 1048576)))} />
            <span className="text-xs text-muted-foreground">MiB/s</span>
          </div>
        </Row>
        <Row title="Active downloads" description="Additional downloads wait in the queue.">
          <Label htmlFor="active-downloads" className="sr-only">Maximum active downloads</Label>
          <Input id="active-downloads" type="number" min="1" max="32" className="w-24" value={settings.maxActive} onChange={event => onUpdate("maxActive", Math.max(1, Math.min(32, Math.round(Number(event.target.value)))))} />
        </Row>
        <Row title="Download schedule" description="Outside this window, transfers wait in the queue. Manually paused downloads stay paused.">
          <Switch aria-label="Enable download schedule" checked={settings.schedule.enabled} onCheckedChange={enabled => onUpdate("schedule", { ...settings.schedule, enabled })} />
        </Row>
        <FieldGroup className="px-5 py-4">
          <div className="flex gap-4">
            <Field><FieldLabel htmlFor="schedule-start">Start (local time)</FieldLabel><Input id="schedule-start" type="time" value={settings.schedule.start} onChange={event => { if (event.target.value && event.target.value !== settings.schedule.stop) onUpdate("schedule", { ...settings.schedule, start: event.target.value }) }} /></Field>
            <Field><FieldLabel htmlFor="schedule-stop">Stop (local time)</FieldLabel><Input id="schedule-stop" type="time" value={settings.schedule.stop} onChange={event => { if (event.target.value && event.target.value !== settings.schedule.start) onUpdate("schedule", { ...settings.schedule, stop: event.target.value }) }} /></Field>
          </div>
          <Field><FieldLabel>Repeat days</FieldLabel>
            <ToggleGroup type="multiple" variant="outline" size="sm" className="justify-start" aria-label="Repeat days" value={settings.schedule.days.map(String)} onValueChange={days => { if (days.length) onUpdate("schedule", { ...settings.schedule, days: days.map(Number) }) }}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => <ToggleGroupItem key={day} value={String(index)} aria-label={day}>{day}</ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
          <Field><FieldLabel htmlFor="schedule-end">End date (optional)</FieldLabel><Input id="schedule-end" type="date" value={settings.schedule.endDate} onChange={event => onUpdate("schedule", { ...settings.schedule, endDate: event.target.value })} /></Field>
          <p className="text-xs text-muted-foreground">Overnight windows belong to the day they start. Keep Kitsune running; the schedule does not wake a sleeping PC. Torrent uploads stop when a torrent is paused or finished.</p>
        </FieldGroup>
        <div className="space-y-3 px-5 py-4">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Default connections</p>
            <p className="text-xs text-muted-foreground">
              How many parts a file is split into. More is usually faster, up to a point.
            </p>
          </div>
          <div className="flex gap-1.5">
            {CONNECTION_CHOICES.map((n) => (
              <button
                key={n}
                onClick={() => onUpdate("defaultConnections", n)}
                className={cn(
                  "flex-1 rounded-md border py-2 text-sm font-medium tabular-nums transition-colors",
                  settings.defaultConnections === n
                    ? "border-primary/50 bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Download folder</p>
            <p className="text-xs text-muted-foreground">
              Leave empty to use the system Downloads folder.
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={settings.saveDirectory ?? ""}
              placeholder="System Downloads folder"
              onChange={(e) => onUpdate("saveDirectory", e.target.value.trim() || null)}
              className="flex-1 font-mono text-xs"
            />
            <Button variant="secondary" size="icon" onClick={() => void chooseDirectory()}>
              <FolderOpen />
              <span className="sr-only">Browse</span>
            </Button>
          </div>
        </div>

        <Row
          title="Fetch details automatically"
          description="Look up filename and size as soon as a link arrives from the browser."
        >
          <Switch
            checked={settings.autoFetchMetadata}
            onCheckedChange={(checked) => onUpdate("autoFetchMetadata", checked)}
          />
        </Row>

        <Row
          title="Confirm before deleting files"
          description="Ask first when a removal would erase data from disk."
        >
          <Switch
            checked={settings.confirmDelete}
            onCheckedChange={(checked) => onUpdate("confirmDelete", checked)}
          />
        </Row>
      </Card>

      <Separator />

      <div className="flex items-center justify-between gap-6">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Reset settings</p>
          <p className="text-xs text-muted-foreground">
            Restore every preference above to its default.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            onReset()
            toast.success("Settings reset")
          }}
        >
          <RotateCcw />
          Reset
        </Button>
      </div>
    </div>
  )
}
