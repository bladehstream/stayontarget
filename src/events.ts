import { atom, read, update } from 'claude-code'
import type { StateDollar } from 'claude-code'

import type { DriftEvent } from '../types'

import { EVENTS_CAP } from './state'
import { printable } from './text'

// FR-UI-10: a live event may be one a 0.1.0 build left, with no excerpt or cwd. Every reader takes these accessors, so a
// missing field reads as the empty excerpt and no directory, never as undefined.
export const excerptOf = (event: DriftEvent): string => (typeof event.excerpt === 'string' ? event.excerpt : '')
export const cwdOf = (event: DriftEvent): string | null => (typeof event.cwd === 'string' ? event.cwd : null)

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

// One bullet of a footer: the bullet's text, and the id of the event it is for (FR-UI-8).
export type FooterRow = { bullet: string; eventId: string }

// A turn footer as built: its text, its bullets in print order, and the count line when some events are not printed.
export type Footer = { text: string; rows: FooterRow[]; more: string | null }

// A bullet is at most this many characters, and the whole footer stays within FOOTER_MAX: the engine cuts a turn text
// over 4,096 characters, which would make the text no longer the one remembered (FR-UI-8).
const BULLET_MAX = 300
const FOOTER_MAX = 4000

// A line of text with its whitespace runs, newlines included, each drawn as one space.
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function cutTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// The footer's first line. The turn's id is in it, so two turns with the same events never draw the same footer text.
export function footerHead(turnId: string): string {
  return `stayontarget: out-of-scope actions this turn (${turnId.slice(0, 8)})`
}

// The footer of one main turn, as the stored events stand now (FR-RS-5).
export async function footerFor($: StateDollar, mainTurnId: string): Promise<Footer | null> {
  return footerRows(eventsForTurn(await read($, eventsAtom), mainTurnId), mainTurnId)
}

// The turn footer (FR-RS-5) and its rows: at most FOOTER_LINES bullets, each one line of at most BULLET_MAX characters, and
// only while the whole text stays within FOOTER_MAX. The rest are counted in the `more` line. Null when there is nothing to show.
export function footerRows(events: DriftEvent[], turnId: string): Footer | null {
  const shown = events.filter(isOutOfScope)
  if (shown.length === 0) return null
  const head = footerHead(turnId)
  const rows: FooterRow[] = []
  let text = head
  for (const event of shown) {
    if (rows.length === FOOTER_LINES) break
    const bullet = cutTo(printable(oneLine(`• ${event.verdict}: ${event.tool} ${event.target} (${event.reason})`)), BULLET_MAX)
    const left = shown.length - rows.length - 1
    const more = left > 0 ? `…and ${left} more` : null
    const candidate = `${text}\n${bullet}${more === null ? '' : `\n${more}`}`
    if (candidate.length > FOOTER_MAX) break
    text = `${text}\n${bullet}`
    rows.push({ bullet, eventId: event.id })
  }
  const more = rows.length < shown.length ? `…and ${shown.length - rows.length} more` : null
  return { text: more === null ? text : `${text}\n${more}`, rows, more }
}

// The footer's text alone (FR-RS-5), or null.
export function footerText(events: DriftEvent[], turnId: string): string | null {
  return footerRows(events, turnId)?.text ?? null
}
