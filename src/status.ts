import { atom, read } from 'claude-code'
import type { StateDollar } from 'claude-code'

import type { Charter, DriftEvent, Stats } from '../types'

import { EMPTY_STATS } from './state'

// The engine's scan needs each atom in the file that reads or writes it, so the atoms are declared here. Ref and initial
// value match src/state.ts; the wiring test checks that they do.
const charterAtom = atom({ plugin: 'stayontarget', key: 'charter' } as const, null as Charter | null)
const eventsAtom = atom({ plugin: 'stayontarget', key: 'events' } as const, [] as DriftEvent[])
const statsAtom = atom({ plugin: 'stayontarget', key: 'stats' } as const, EMPTY_STATS)
export const __atoms = { charterAtom, eventsAtom, statsAtom }

// The status line as the stored charter, events and stats stand now (FR-RS-6).
export async function currentStatus($: StateDollar): Promise<string> {
  const [charter, events, stats] = await Promise.all([read($, charterAtom), read($, eventsAtom), read($, statsAtom)])
  return statusText(charter, events, stats)
}

// The status line for the current state (FR-RS-6). Counts are for the charter the person is working under; the
// undistilled and unsaved notices follow whatever the counts say.
export function statusText(charter: Charter | null, events: DriftEvent[], stats: Stats): string {
  const base = charter === null ? 'stayontarget: no charter yet' : onCharter(charter, events)
  const undistilled = charter !== null && charter.request !== '' && !charter.distilled ? ' · charter not distilled' : ''
  return `${base}${undistilled}${stats.persistFailed ? ' · not saved' : ''}`
}

// An event belongs to a charter when it names the charter's id, or when it is an unchecked decision with no charter (a call
// that named no target) made at or after the charter's creation. The status line, the pane's counts and its list all use
// this one rule.
export function belongsHere(charter: Charter, event: DriftEvent): boolean {
  if (event.charterId === charter.id) return true
  return event.charterId === null && event.at >= charter.createdAt
}

function onCharter(charter: Charter, events: DriftEvent[]): string {
  let drift = 0
  let adjacent = 0
  let unchecked = 0
  for (const event of events) {
    if (event.verdict === 'unchecked') {
      if (belongsHere(charter, event)) unchecked += 1
      continue
    }
    if (event.charterId !== charter.id || event.status !== 'open') continue
    if (event.verdict === 'drift') drift += 1
    if (event.verdict === 'adjacent') adjacent += 1
  }

  const parts: string[] = []
  if (drift > 0) parts.push(`${drift} drift`)
  if (adjacent > 0) parts.push(`${adjacent} adjacent`)
  if (parts.length > 0) {
    if (unchecked > 0) parts.push(`${unchecked} unchecked`)
    return `stayontarget: ${parts.join(' · ')}`
  }
  if (unchecked > 0) return `stayontarget: degraded (${unchecked} unchecked)`
  return 'stayontarget: on target'
}
