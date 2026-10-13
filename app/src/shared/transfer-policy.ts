import type { TransferSettings } from './ipc'

export const DEFAULT_TRANSFERS: TransferSettings = {
  speedLimit: 0,
  slowMode: false,
  slowSpeed: 2 * 1024 * 1024,
  maxActive: 3,
  schedule: { enabled: false, start: '00:00', stop: '07:00', days: [0, 1, 2, 3, 4, 5, 6], endDate: '' }
}

export function validateTransfers(value: TransferSettings): TransferSettings {
  for (const rate of [value.speedLimit, value.slowSpeed]) {
    if (!Number.isSafeInteger(rate) || rate < 0 || (rate > 0 && rate < 32) || rate > 10_000_000_000) throw new Error('Invalid speed limit')
  }
  if (value.slowSpeed === 0) throw new Error('Slow mode speed must be greater than zero')
  if (!Number.isInteger(value.maxActive) || value.maxActive < 1 || value.maxActive > 32) throw new Error('Choose 1–32 active downloads')
  const schedule = value.schedule
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.stop)) throw new Error('Invalid schedule time')
  if (schedule.enabled && (schedule.start === schedule.stop || schedule.days.length === 0)) throw new Error('Choose different start and stop times and at least one day')
  if (!schedule.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6)) throw new Error('Invalid repeat days')
  if (schedule.endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.endDate) || Number.isNaN(Date.parse(schedule.endDate)))) throw new Error('Invalid end date')
  return structuredClone(value)
}

/** Overnight windows belong to their start day, including the end-date check. */
export function scheduleAllows(settings: TransferSettings, now = new Date()): boolean {
  const schedule = settings.schedule
  if (!schedule.enabled) return true
  const minutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
  const start = minutes(schedule.start)
  const stop = minutes(schedule.stop)
  const current = now.getHours() * 60 + now.getMinutes()
  const startDay = new Date(now)
  if (start > stop) {
    if (current >= stop && current < start) return false
    if (current < stop) startDay.setDate(startDay.getDate() - 1)
  } else if (current < start || current >= stop) return false
  const date = `${startDay.getFullYear()}-${String(startDay.getMonth() + 1).padStart(2, '0')}-${String(startDay.getDate()).padStart(2, '0')}`
  return schedule.days.includes(startDay.getDay()) && (!schedule.endDate || date <= schedule.endDate)
}

export function effectiveRate(settings: TransferSettings): number {
  return settings.slowMode ? settings.slowSpeed : settings.speedLimit
}
