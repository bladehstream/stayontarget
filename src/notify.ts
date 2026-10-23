import type { EngineInterface } from 'claude-code'

import type { DriftEvent } from '../types'

import type { Config } from './config'

// FR-RS-7: at most one drift toast per this many milliseconds.
const TOAST_GAP_MS = 30 * 1000

// The time of the last drift toast. Plugin state a hook shares with its later calls, as registry.ts keeps its entries.
let lastToastAt: number | null = null

// Shows a toast for a drift verdict when the setting `toasts` is on (FR-RS-7). Other verdicts never toast.
export function maybeToast($: Pick<EngineInterface, 'ui'>, cfg: Config, ev: DriftEvent, now: number): void {
  if (!cfg.toasts || ev.verdict !== 'drift') return
  if (lastToastAt !== null && now - lastToastAt < TOAST_GAP_MS) return
  lastToastAt = now
  $.ui.toast(`stayontarget: drift: ${ev.tool} ${ev.target}`)
}
