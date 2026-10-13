import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { Download } from '@/hooks/useDownloads'

export function RepairLinkDialog({ download, onClose, onRepair }: {
  download: Download | undefined
  onClose: () => void
  onRepair: (id: string, url: string) => Promise<void>
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { setUrl(''); setError('') }, [download?.id])
  const repair = async (): Promise<void> => {
    if (!download) return
    setBusy(true)
    setError('')
    try {
      const parsed = new URL(url.trim())
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an HTTP or HTTPS link')
      await onRepair(download.id, url.trim())
      onClose()
    } catch (error) { setError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <Dialog open={!!download} onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Repair expired link</DialogTitle>
        <DialogDescription>Paste a fresh link to {download?.filename}. Kitsune checks the file version before preserving your progress. The download stays paused until you resume it.</DialogDescription>
      </DialogHeader>
      <FieldGroup className="px-6"><Field data-invalid={!!error} data-disabled={busy}>
        <FieldLabel htmlFor="replacement-url">Fresh download URL</FieldLabel>
        <Input id="replacement-url" value={url} onChange={event => setUrl(event.target.value)} aria-invalid={!!error} autoFocus disabled={busy} />
        <FieldError>{error}</FieldError>
      </Field></FieldGroup>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={() => void repair()} disabled={busy || !url.trim()}>{busy ? 'Checking file…' : 'Check and replace link'}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
