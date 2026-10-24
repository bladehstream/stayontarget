import type { EngineInterface } from 'claude-code'

import type { DriftEvent } from '../types'

import type { Config } from './config'
import { messageOf } from './model'

// FR-RS-7: at most one drift toast per this many milliseconds.
const TOAST_GAP_MS = 30 * 1000
// FR-UI-9: at most one drift notification per this many milliseconds, on its own clock apart from the toast's.
const NOTIFY_GAP_MS = 60 * 1000

// The time of the last drift toast. Plugin state a hook shares with its later calls, as registry.ts keeps its entries.
let lastToastAt: number | null = null
// The time of the last drift notification, kept the same way.
let lastNotifyAt: number | null = null

// Shows a toast for a drift verdict when the setting `toasts` is on (FR-RS-7). Other verdicts never toast.
export function maybeToast($: Pick<EngineInterface, 'ui'>, cfg: Config, ev: DriftEvent, now: number): void {
  if (!cfg.toasts || ev.verdict !== 'drift') return
  if (lastToastAt !== null && now - lastToastAt < TOAST_GAP_MS) return
  lastToastAt = now
  $.ui.toast(`stayontarget: drift: ${ev.tool} ${ev.target}`)
}

// Sends a desktop notification for a drift verdict when the setting `notify` is on (FR-UI-9). Other verdicts never notify.
// A send the terminal did not take is logged, not retried. Never throws.
export async function maybeNotify($: Pick<EngineInterface, 'ui'>, cfg: Config, ev: DriftEvent, now: number): Promise<void> {
  if (!cfg.notify || ev.verdict !== 'drift') return
  if (lastNotifyAt !== null && now - lastNotifyAt < NOTIFY_GAP_MS) return
  lastNotifyAt = now
  try {
    const sent = await $.ui.notify(`${ev.tool} ${ev.target}: ${ev.reason}`, { title: 'stayontarget: drift' })
    if (!sent.isSent) $.ui.log(`stayontarget: notification not sent: ${sent.reason}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`stayontarget: notification not sent: ${messageOf(err)}`, { to: 'debug' })
  }
}
