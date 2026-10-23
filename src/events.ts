import { atom, read, update } from 'claude-code'
import type { StateDollar } from 'claude-code'

import type { DriftEvent } from '../types'

import { EVENTS_CAP } from './state'

// The engine's scan needs each atom in the file that reads or writes it, so the atom is declared here. Ref and initial
// value match src/state.ts; the wiring test checks that they do.
const eventsAtom = atom({ plugin: 'stayontarget', key: 'events' } as const, [] as DriftEvent[])
export const __atoms = { eventsAtom }

const FOOTER_LINES = 10

export function newEventId(): string {
  return crypto.randomUUID()
}

function isOutOfScope(event: DriftEvent): boolean {
  return event.verdict === 'adjacent' || event.verdict === 'drift'
}

// Appends one verdict (FR-ST-2) and keeps the newest EVENTS_CAP. An in-scope verdict is listed only when the judge gave it:
// a cache or allowance hit is counted in the stats, not listed.
export async function recordEvent($: StateDollar, event: DriftEvent): Promise<void> {
  if (event.verdict === 'in-scope' && event.source !== 'judge') return
  await update($, eventsAtom, events => {
    const next = [...events, event]
    return next.length > EVENTS_CAP ? next.slice(next.length - EVENTS_CAP) : next
  })
}

// Sets the action of the event recorded for a tool call. A call with no event leaves the list as it is.
export async function setEventAction($: StateDollar, toolUseId: string, action: DriftEvent['action']): Promise<void> {
  await update($, eventsAtom, events =>
    events.map(event => (event.toolUseId === toolUseId && event.action !== action ? { ...event, action } : event)),
  )
}

// The adjacent and drift events of one main turn, oldest first. Subagent calls made during the turn carry its id too.
export function eventsForTurn(events: DriftEvent[], mainTurnId: string): DriftEvent[] {
  return events.filter(event => event.mainTurnId === mainTurnId && isOutOfScope(event))
}

// The footer of one main turn, as the stored events stand now (FR-RS-5).
export async function footerFor($: StateDollar, mainTurnId: string): Promise<string | null> {
  return footerText(eventsForTurn(await read($, eventsAtom), mainTurnId))
}

// The turn footer (FR-RS-5): at most FOOTER_LINES bullets, then a count of the rest. Null when there is nothing to show.
export function footerText(events: DriftEvent[]): string | null {
  const shown = events.filter(isOutOfScope)
  if (shown.length === 0) return null
  const lines = ['stayontarget: out-of-scope actions this turn']
  for (const event of shown.slice(0, FOOTER_LINES)) {
    lines.push(`• ${event.verdict}: ${event.tool} ${event.target} (${event.reason})`)
  }
  if (shown.length > FOOTER_LINES) lines.push(`…and ${shown.length - FOOTER_LINES} more`)
  return lines.join('\n')
}
