import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Allowance, Charter, DriftEvent, Stats } from '../types'

import { refreshStatus } from './actions'
import { messageOf } from './model'
import { EMPTY_STATS, EVENTS_CAP } from './state'

// The engine's scan needs each atom in the file that reads or writes it, so the atoms are declared here. Ref and initial
// value match src/state.ts; the wiring test checks that they do for the modules it lists.
const charterAtom = atom({ plugin: 'stayontarget', key: 'charter' } as const, null as Charter | null)
const eventsAtom = atom({ plugin: 'stayontarget', key: 'events' } as const, [] as DriftEvent[])
const allowancesAtom = atom({ plugin: 'stayontarget', key: 'allowances' } as const, [] as Allowance[])
const statsAtom = atom({ plugin: 'stayontarget', key: 'stats' } as const, EMPTY_STATS)
export const __atoms = { charterAtom, eventsAtom, allowancesAtom, statsAtom }

export type Snapshot = {
  v: 1
  sessionId: string
  savedAt: number
  charter: Charter | null
  events: DriftEvent[]
  allowances: Allowance[]
  stats: Stats
}

type IndexEntry = { sessionId: string; savedAt: number }

// The engine nouns persistence uses: the store, the four state atoms, the clock and the session's id, the status line and
// the debug log.
export type PersistDollar = Pick<EngineInterface, 'store' | 'state' | 'clock' | 'session' | 'ui'>

// FR-ST-3: 20 sessions of this size, and the index, stay under the engine's 4 MiB store total.
export const SNAPSHOT_MAX_BYTES = 196608
export const MAX_SESSIONS = 20

// FR-ST-3: writes are coalesced to at most one per this many milliseconds.
const SAVE_DELAY_MS = 2000
// A store call that has not answered by then is a failure, unless a save is given its own budget.
const STORE_DEADLINE_MS = 1000
// A session.end save gets the hook's remaining budget less this margin for the reset that follows it, or this much when the
// budget is not metered (FR-ST-4).
const SESSION_END_FALLBACK_MS = 1000
const BUDGET_MARGIN_MS = 200
// The request text cut to its head and its tail when the snapshot is still too big after its oldest events are gone.
const REQUEST_HEAD = 2000
const REQUEST_TAIL = 2000
const SESSION_PREFIX = 'session:'
const INDEX_KEY = 'index'

const VERDICTS: readonly unknown[] = ['in-scope', 'adjacent', 'drift', 'unchecked']
const SOURCES: readonly unknown[] = ['judge', 'cache', 'allowance', 'none']
const ACTIONS: readonly unknown[] = ['none', 'note', 'ask', 'unchecked']
const STATUSES: readonly unknown[] = ['open', 'allowed', 'dismissed']

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const isText = (x: unknown): x is string => typeof x === 'string'
const isFlag = (x: unknown): x is boolean => typeof x === 'boolean'
const isTextList = (x: unknown): boolean => Array.isArray(x) && x.every(isText)
const isOneOf = (values: readonly unknown[], x: unknown): boolean => values.includes(x)
const isNullOr = (check: (x: unknown) => boolean, x: unknown): boolean => x === null || check(x)

function isCharter(x: unknown): boolean {
  return (
    isRecord(x) &&
    isText(x.id) &&
    isNumber(x.rev) &&
    isText(x.request) &&
    isNullOr(isText, x.goal) &&
    isTextList(x.inScope) &&
    isTextList(x.outOfScope) &&
    isFlag(x.distilled) &&
    Array.isArray(x.editedFields) &&
    x.editedFields.every(field => field === 'goal') &&
    isTextList(x.pendingText) &&
    isNumber(x.createdAt)
  )
}

function isEvent(x: unknown): boolean {
  return (
    isRecord(x) &&
    isText(x.id) &&
    isText(x.toolUseId) &&
    isNullOr(isText, x.charterId) &&
    isNumber(x.charterRev) &&
    isNullOr(isText, x.mainTurnId) &&
    isNullOr(isText, x.agentId) &&
    isText(x.tool) &&
    isText(x.target) &&
    isOneOf(VERDICTS, x.verdict) &&
    isText(x.reason) &&
    isOneOf(SOURCES, x.source) &&
    isOneOf(ACTIONS, x.action) &&
    isOneOf(STATUSES, x.status) &&
    isNumber(x.at)
  )
}

function isAllowance(x: unknown): boolean {
  return isRecord(x) && isText(x.charterId) && isText(x.tool) && isText(x.target) && isNumber(x.at)
}

function isStats(x: unknown): boolean {
  return (
    isRecord(x) &&
    isNumber(x.judged) &&
    isNumber(x.cacheHits) &&
    isNumber(x.allowanceHits) &&
    isNumber(x.unchecked) &&
    isNumber(x.inputTokens) &&
    isNumber(x.outputTokens) &&
    isNumber(x.charterUpdates) &&
    isNumber(x.charterFailures) &&
    isFlag(x.persistFailed)
  )
}

// FR-ST-3: structural validation of every field. Events are bounded by EVENTS_CAP before they are looked at.
export function isSnapshot(x: unknown): x is Snapshot {
  return (
    isRecord(x) &&
    x.v === 1 &&
    isText(x.sessionId) &&
    isNumber(x.savedAt) &&
    isNullOr(isCharter, x.charter) &&
    Array.isArray(x.events) &&
    x.events.length <= EVENTS_CAP &&
    x.events.every(isEvent) &&
    Array.isArray(x.allowances) &&
    x.allowances.every(isAllowance) &&
    isStats(x.stats)
  )
}

function fits(s: Snapshot): boolean {
  return new TextEncoder().encode(JSON.stringify(s)).length <= SNAPSHOT_MAX_BYTES
}

// The newest items that fit, given that the full list does not: the fewest of the oldest dropped. Fitting only gets easier
// as more is dropped, so a binary search finds the cut in about log2(n) measurements.
function keepNewest<T>(items: readonly T[], fitsWith: (kept: T[]) => boolean): T[] {
  let lo = 0
  let hi = items.length
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (fitsWith(items.slice(mid))) hi = mid
    else lo = mid
  }
  return items.slice(hi)
}

function headAndTail(text: string): string {
  return text.length <= REQUEST_HEAD + REQUEST_TAIL ? text : `${text.slice(0, REQUEST_HEAD)}\n…\n${text.slice(-REQUEST_TAIL)}`
}

// The text of a charter item or goal, cut to ITEM_MAX characters when the snapshot is still too big.
const ITEM_MAX = 200
const cutItem = (text: string): string => text.slice(0, ITEM_MAX)

// FR-ST-3: a snapshot within SNAPSHOT_MAX_BYTES, where it can be. Each step runs only when the one before it left the
// snapshot too big: the oldest events; the request cut to its head and tail; the oldest allowances (the list has no bound of
// its own); the oldest pending entries; then the goal and the charter's items cut to ITEM_MAX characters. A snapshot that is
// still too big comes back over the cap, and saveNow refuses to write it.
export function fitSnapshot(s: Snapshot): Snapshot {
  if (fits(s)) return s
  const byEvents: Snapshot = { ...s, events: keepNewest(s.events, kept => fits({ ...s, events: kept })) }
  if (fits(byEvents)) return byEvents
  const trimmed: Snapshot = {
    ...byEvents,
    charter: s.charter === null ? null : { ...s.charter, request: headAndTail(s.charter.request) },
  }
  if (fits(trimmed)) return trimmed
  const byAllowances: Snapshot = {
    ...trimmed,
    allowances: keepNewest(trimmed.allowances, kept => fits({ ...trimmed, allowances: kept })),
  }
  if (fits(byAllowances) || byAllowances.charter === null) return byAllowances

  const charter = byAllowances.charter
  const withPending = (pendingText: string[]): Snapshot => ({ ...byAllowances, charter: { ...charter, pendingText } })
  const byPending = withPending(keepNewest(charter.pendingText, kept => fits(withPending(kept))))
  if (fits(byPending)) return byPending

  return {
    ...byPending,
    charter: {
      ...charter,
      pendingText: byPending.charter?.pendingText ?? [],
      goal: charter.goal === null ? null : cutItem(charter.goal),
      inScope: charter.inScope.map(cutItem),
      outOfScope: charter.outOfScope.map(cutItem),
    },
  }
}

// Waits for `work`, but no longer than `ms`, and no longer than `signal` allows: a dispatch that is cut ends the wait with it.
// The wait's timer is ended as soon as the work answers.
async function within<T>($: Pick<PersistDollar, 'clock'>, work: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  const expiry = new AbortController()
  const cut = () => expiry.abort()
  signal?.addEventListener('abort', cut, { once: true })
  const late = $.clock
    .sleep(ms, { signal: expiry.signal })
    .then(() => {
      throw new Error('the store did not answer in time')
    })
  try {
    return await Promise.race([work, late])
  } finally {
    signal?.removeEventListener('abort', cut)
    expiry.abort()
  }
}

function isIndexEntry(x: unknown): boolean {
  return isRecord(x) && isText(x.sessionId) && isNumber(x.savedAt)
}

function isIndex(x: unknown): x is IndexEntry[] {
  return Array.isArray(x) && x.length <= MAX_SESSIONS && x.every(isIndexEntry)
}

// The index as stored, plus every session key the index does not list (FR-ST-3): a snapshot whose index write failed is
// added here as the oldest. Keys are read by name only; no snapshot is read.
async function indexOf($: PersistDollar): Promise<IndexEntry[]> {
  const stored = await $.store.get(INDEX_KEY)
  const listed: IndexEntry[] = isIndex(stored) ? stored : []
  const known = new Set(listed.map(entry => entry.sessionId))
  const orphans = (await $.store.keys())
    .filter(key => key.startsWith(SESSION_PREFIX))
    .map(key => key.slice(SESSION_PREFIX.length))
    .filter(sessionId => !known.has(sessionId))
    .map(sessionId => ({ sessionId, savedAt: 0 }))
  return [...orphans, ...listed]
}

// The state holds nothing worth a snapshot: what a /clear leaves behind (FR-ST-4).
function isInitialState(charter: Charter | null, events: DriftEvent[], allowances: Allowance[], stats: Stats): boolean {
  return (
    charter === null &&
    events.length === 0 &&
    allowances.length === 0 &&
    Object.keys(EMPTY_STATS).every(key => key === 'persistFailed' || stats[key as keyof Stats] === EMPTY_STATS[key as keyof Stats])
  )
}

// Reads the four atoms as they stand now and builds the snapshot of them, fitted and verified against the cap. Null when the
// state is initial, which has nothing to keep. Rejects when even the fitted snapshot is over the cap (FR-ST-3).
// `live` is checked after each await: a scheduled save that a /clear overtook answers `false` and reads nothing further.
async function buildSnapshot($: PersistDollar, sessionId: string, live: () => boolean): Promise<Snapshot | null | false> {
  const [charter, events, allowances, stats] = await Promise.all([
    read($, charterAtom),
    read($, eventsAtom),
    read($, allowancesAtom),
    read($, statsAtom),
  ])
  if (!live()) return false
  if (isInitialState(charter, events, allowances, stats)) return null
  const savedAt = await $.clock.now()
  if (!live()) return false
  const snapshot = fitSnapshot({ v: 1, sessionId, savedAt, charter, events, allowances, stats })
  if (!fits(snapshot)) throw new Error('the snapshot is over the store cap')
  return snapshot
}

// Writes one snapshot. The sessions past the cap are deleted first, so a store near its total has room for the new
// snapshot; then the snapshot; then the index, which lists this session in place of its old entry.
async function writeSnapshot($: PersistDollar, snapshot: Snapshot): Promise<void> {
  const { sessionId, savedAt } = snapshot
  const index = (await indexOf($)).filter(entry => entry.sessionId !== sessionId)
  index.push({ sessionId, savedAt })
  index.sort((a, b) => a.savedAt - b.savedAt)
  const evicted = index.splice(0, Math.max(0, index.length - MAX_SESSIONS))
  for (const entry of evicted) await $.store.delete(SESSION_PREFIX + entry.sessionId)

  await $.store.set(SESSION_PREFIX + sessionId, snapshot)
  await $.store.set(INDEX_KEY, index)
}

// The state is initial, so the session keeps nothing (FR-ST-3): its snapshot and its index entry go, if the index lists it.
// Nothing is written when it is not listed.
async function forgetSnapshot($: PersistDollar, sessionId: string): Promise<void> {
  const index = await indexOf($)
  if (!index.some(entry => entry.sessionId === sessionId)) return
  await $.store.delete(SESSION_PREFIX + sessionId)
  await $.store.set(
    INDEX_KEY,
    index.filter(entry => entry.sessionId !== sessionId),
  )
}

// Sets the `persistFailed` flag only when it changes, so the state write it makes does not start another save that writes
// the same flag. The status line is refreshed only when the flag moved.
async function setPersistFailed($: PersistDollar, failed: boolean): Promise<void> {
  try {
    if ((await read($, statsAtom)).persistFailed === failed) return
    await update($, statsAtom, stats => ({ ...stats, persistFailed: failed }))
  } catch (err) {
    $.ui.log(`stayontarget: save flag not set: ${messageOf(err)}`, { to: 'debug' })
    return
  }
  await refreshStatus($)
}

// The saves. One write runs at a time, since each rewrites the index. The write that runs is waited for until it settles or
// until STORE_ABANDON_MS passes, when the queue moves on (KI-5: a write that lands after that may overwrite a newer snapshot).
// Behind it, each session has at most one waiting save: a newer save for that session replaces the waiting one, and every
// caller that joined it gets the same outcome. A save for another session waits in its own place, in arrival order.
const STORE_ABANDON_MS = 30000

type Job = {
  sessionId: string
  built: Promise<Snapshot | null | false>
  live: () => boolean
  outcome: Promise<boolean>
  settle: (ok: boolean) => void
}

const waiting = new Map<string, Job>()
let writing = false

// The write of one job: the snapshot as it was built when asked for, or the removal of the session's snapshot when the state
// was initial (FR-ST-3). Its persistFailed is set from its own result.
async function runJob($: PersistDollar, job: Job): Promise<boolean> {
  try {
    const snapshot = await job.built
    // A scheduled save that a /clear overtook writes and deletes nothing (FR-ST-4): it is dropped, and this is not a failure.
    if (snapshot === false || !job.live()) return false
    if (snapshot === null) await forgetSnapshot($, job.sessionId)
    else await writeSnapshot($, snapshot)
    await setPersistFailed($, false)
    return true
  } catch (err) {
    $.ui.log(`stayontarget: snapshot not saved: ${messageOf(err)}`, { to: 'debug' })
    await setPersistFailed($, true)
    return false
  }
}

// Waits for `work`, or gives up after `ms` with false; the work keeps running, as an abandoned write does.
async function givenUp($: Pick<PersistDollar, 'clock'>, work: Promise<boolean>, ms: number): Promise<boolean> {
  const expiry = new AbortController()
  const late = $.clock.sleep(ms, { signal: expiry.signal }).then(
    () => false,
    () => false,
  )
  try {
    return await Promise.race([work, late])
  } finally {
    expiry.abort()
  }
}

// Runs the next waiting job, if none is running. Each job settles its callers, then the next one starts.
async function pump($: PersistDollar): Promise<void> {
  if (writing) return
  const first = waiting.keys().next()
  if (first.done) return
  const job = waiting.get(first.value)
  if (job === undefined) return
  waiting.delete(first.value)
  writing = true
  let ok = false
  try {
    ok = await givenUp($, runJob($, job), STORE_ABANDON_MS)
  } finally {
    writing = false
    job.settle(ok)
    kick($)
  }
}

function kick($: PersistDollar): void {
  void pump($).catch(() => undefined)
}

// Joins the waiting save for the session, or starts one. A newer snapshot replaces the waiting one's; the caller shares the
// outcome of the save it joined.
function enqueue(
  $: PersistDollar,
  sessionId: string,
  built: Promise<Snapshot | null | false>,
  live: () => boolean,
): Job {
  const existing = waiting.get(sessionId)
  if (existing !== undefined) {
    existing.built = built
    existing.live = live
    return existing
  }
  let settle: (ok: boolean) => void = () => undefined
  const outcome = new Promise<boolean>(resolve => {
    settle = resolve
  })
  const job: Job = { sessionId, built, live, outcome, settle }
  waiting.set(sessionId, job)
  kick($)
  return job
}

// FR-ST-3: writes the snapshot of the four atoms under `sessionId`. The atoms are read now, when the save is asked for, so a
// save that waits in the queue still holds the state it was asked about (FR-ST-4). The caller waits at most `deadlineMs`,
// queue wait included. A failure, an over-cap snapshot, or a missed deadline sets `persistFailed` and returns false; a
// success clears it. Never throws.
export async function saveNow(
  $: PersistDollar,
  sessionId: string,
  deadlineMs = STORE_DEADLINE_MS,
  signal?: AbortSignal,
  live: () => boolean = () => true,
): Promise<boolean> {
  const built = buildSnapshot($, sessionId, live)
  built.catch(() => undefined)
  const job = enqueue($, sessionId, built, live)
  try {
    return await within($, job.outcome, deadlineMs, signal)
  } catch (err) {
    $.ui.log(`stayontarget: snapshot not saved: ${messageOf(err)}`, { to: 'debug' })
    await setPersistFailed($, true)
    return false
  }
}

// At most one save is waiting for its timer. A change that lands while it waits is part of that save.
let pending = false
// While a /clear is under way, nothing is scheduled and a timer that falls due does nothing (FR-ST-4): the state it would save
// is the one the reset is leaving, under the id the session is leaving.
let suspended = false
// Counts the /clear suspensions. A scheduled save records it when its timer fires and drops itself if it has moved by the
// time it would write or delete (FR-ST-4), so a save already in flight cannot span a /clear.
let generation = 0

export function suspendPersist(): void {
  suspended = true
  generation += 1
}

export function resumePersist(): void {
  suspended = false
}

// FR-ST-3: schedules one save of the session's snapshot SAVE_DELAY_MS from now, unless one is already waiting. The state.set
// hook in register.tsx calls this on every write of the plugin's own state. A hot reload drops the timer; the next change
// schedules again.
export function schedulePersist($: PersistDollar): void {
  if (pending || suspended) return
  pending = true
  try {
    $.clock.after(SAVE_DELAY_MS, () => {
      pending = false
      if (suspended) return
      const at = generation
      void saveCurrent($, () => generation === at)
    })
  } catch (err) {
    pending = false
    $.ui.log(`stayontarget: save not scheduled: ${messageOf(err)}`, { to: 'debug' })
  }
}

async function saveCurrent($: PersistDollar, live: () => boolean): Promise<void> {
  try {
    const sessionId = await $.session.id()
    if (!live()) return
    await saveNow($, sessionId, STORE_DEADLINE_MS, undefined, live)
  } catch (err) {
    $.ui.log(`stayontarget: snapshot not saved: ${messageOf(err)}`, { to: 'debug' })
  }
}

// FR-ST-4: restores the snapshot stored under `sessionId` into the four atoms. A missing or invalid snapshot restores nothing
// and returns false. Never throws.
export async function restore($: PersistDollar, sessionId: string): Promise<boolean> {
  try {
    // A session with state that was ever written keeps it: a hot reload or a configuration change starts the session again
    // while the state survives, and a stored snapshot older than that state, or a snapshot of a session that was cleared, must
    // not come back. A value never written is at version 0, so only a session with no version on any of the four writes
    // restores (FR-ST-4).
    const written = await Promise.all([
      $.state.get({ plugin: 'stayontarget', key: 'charter' } as const),
      $.state.get({ plugin: 'stayontarget', key: 'events' } as const),
      $.state.get({ plugin: 'stayontarget', key: 'allowances' } as const),
      $.state.get({ plugin: 'stayontarget', key: 'stats' } as const),
    ])
    if (written.some(entry => entry.version !== 0)) return false
    const stored = await within($, $.store.get(SESSION_PREFIX + sessionId), STORE_DEADLINE_MS)
    if (!isSnapshot(stored) || stored.sessionId !== sessionId) return false
    const snapshot = stored
    await update($, charterAtom, () => snapshot.charter)
    await update($, eventsAtom, () => snapshot.events)
    await update($, allowancesAtom, () => snapshot.allowances)
    // The flag describes the store this session writes to, not the snapshot, so the restored session starts with it clear.
    await update($, statsAtom, () => ({ ...snapshot.stats, persistFailed: false }))
    return true
  } catch (err) {
    $.ui.log(`stayontarget: snapshot not restored: ${messageOf(err)}`, { to: 'debug' })
    return false
  }
}

// FR-ST-4: the four atoms back to their initial values, as a /clear leaves them.
export async function resetSessionState($: Pick<PersistDollar, 'state'>): Promise<void> {
  await update($, charterAtom, () => null)
  await update($, eventsAtom, () => [])
  await update($, allowancesAtom, () => [])
  await update($, statsAtom, () => EMPTY_STATS)
}

// The deadline for a session.end save: the hook's remaining budget less a margin, or a fixed second when no budget is read.
export function sessionEndDeadline(remainingMs: number | undefined): number {
  if (remainingMs === undefined || !Number.isFinite(remainingMs)) return SESSION_END_FALLBACK_MS
  return Math.max(0, remainingMs - BUDGET_MARGIN_MS)
}
