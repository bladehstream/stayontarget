import { atom } from 'claude-code'

import type { Allowance, Charter, DriftEvent, Stats } from '../types'

export const EVENTS_CAP = 200

export const EMPTY_STATS: Stats = {
  judged: 0,
  cacheHits: 0,
  allowanceHits: 0,
  unchecked: 0,
  inputTokens: 0,
  outputTokens: 0,
  charterUpdates: 0,
  charterFailures: 0,
  persistFailed: false,
}

export const charterAtom = atom({ plugin: 'stayontarget', key: 'charter' } as const, null as Charter | null)
export const eventsAtom = atom({ plugin: 'stayontarget', key: 'events' } as const, [] as DriftEvent[])
export const allowancesAtom = atom({ plugin: 'stayontarget', key: 'allowances' } as const, [] as Allowance[])
export const statsAtom = atom({ plugin: 'stayontarget', key: 'stats' } as const, EMPTY_STATS)
