import { atom, read, update } from 'claude-code'
import type { EngineInterface, StateDollar } from 'claude-code'

import type { Charter } from '../types'

import { REDACT_WINDOW_MARGIN } from './action'
import type { Config } from './config'
import { callModel, messageOf, parseJsonObject } from './model'
import type { ModelOutcome } from './model'
import { CHARTER_INSTRUCTIONS } from './prompts'
import { redactText } from './redact'
import { EMPTY_STATS } from './state'

// The engine's scan needs each atom in the file that reads or writes it, so the atoms are declared here. Ref and initial
// value match src/state.ts; the wiring test checks that they do.
const charterAtom = atom({ plugin: 'stayontarget', key: 'charter' } as const, null as Charter | null)
const statsAtom = atom({ plugin: 'stayontarget', key: 'stats' } as const, EMPTY_STATS)
export const __atoms = { charterAtom, statsAtom }

// The engine nouns the charter lifecycle uses: the model and clock (through callModel), the state (through read and
// update) and the debug log. Each function takes the narrowest slice it needs.
export type CharterDollar = Pick<EngineInterface, 'model' | 'clock' | 'state' | 'ui'>
type TurnDollar = Pick<EngineInterface, 'state' | 'ui'>

const ENTRY_MAX = 4000
const SKILL_MAX = 1500
const SKILL_WINDOW_MS = 10 * 60 * 1000
const ITEM_MAX = 200
const LIST_MAX = 8
const REQUEST_MAX = 6000
const REQUEST_HEAD = 2000
const REQUEST_TAIL = 3900
const REQUEST_CONTEXT = 2000
const PENDING_MAX = 16
const CHARTER_DEADLINE_MS = 8000
// The shortest time left for a recompute to be worth a model call (FR-VD-6 budget).
const RECOMPUTE_MIN_MS = 1000
const CHARTER_MAX_TOKENS = 400
const AMENDMENT_SEPARATOR = '\n---\n'
const KINDS: readonly string[] = ['new-task', 'amendment', 'chit-chat']

type Kind = 'new-task' | 'amendment' | 'chit-chat'
type Distilled = { kind: Kind; goal: string; inScope: string[]; outOfScope: string[] }
type Usage = { inputTokens: number; outputTokens: number }
type Attempt = { reply: Distilled | null; detail: string; usage: Usage }

// The command mark and the skill body it may capture. Module-level, not state: they live between two hook calls only.
let commandMarkAt: number | null = null
let skillBody: string | null = null

// Redacts a window of the text, as action.ts does, so a secret cut at the bound is still seen. Keeps at most `max`.
// `cut` says the text itself was truncated before it got here (the caller sliced it), so its end may be mid-secret.
function redactedBound(text: string, max: number, cut = false): string {
  const window = text.slice(0, max + REDACT_WINDOW_MARGIN)
  const redacted = redactText(window, cut || text.length > window.length)
  if (redacted.length <= max) return redacted
  const last = redacted.charCodeAt(max - 1)
  return redacted.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

function capRequest(text: string): string {
  return text.length <= REQUEST_MAX ? text : `${text.slice(0, REQUEST_HEAD)}\n…\n${text.slice(-REQUEST_TAIL)}`
}

// Keeps the newest PENDING_MAX entries; `dropped` counts the oldest ones let go.
function appendPending(pending: readonly string[], entry: string): { list: string[]; dropped: number } {
  const next = [...pending, entry]
  const dropped = Math.max(0, next.length - PENDING_MAX)
  return { list: next.slice(dropped), dropped }
}

function newCharter(id: string, now: number, entry: string): Charter {
  return {
    id,
    rev: 0,
    request: '',
    goal: null,
    inScope: [],
    outOfScope: [],
    distilled: false,
    editedFields: [],
    pendingText: [entry],
    createdAt: now,
  }
}

// FR-CH-2: a main turn's text becomes pending text. Marks and the captured skill body are used by this turn only.
export async function onMainTurnStart($: TurnDollar, text: string, now: number): Promise<void> {
  const body = skillBody
  commandMarkAt = null
  skillBody = null
  try {
    const head = text.slice(0, ENTRY_MAX + REDACT_WINDOW_MARGIN)
    if (head.trim() === '') return
    const entry = redactedBound(body === null ? head : `${head}\n${body}`, ENTRY_MAX, text.length > head.length)
    const id = crypto.randomUUID()
    let dropped = 0
    await update($, charterAtom, charter => {
      if (charter === null) {
        dropped = 0
        return newCharter(id, now, entry)
      }
      const appended = appendPending(charter.pendingText, entry)
      dropped = appended.dropped
      return { ...charter, pendingText: appended.list }
    })
    if (dropped > 0) $.ui.log(`stayontarget: charter pending overflow, dropped ${dropped}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`stayontarget: pending text not recorded: ${messageOf(err)}`, { to: 'debug' })
  }
}

// FR-CH-6: a person's prompt delivered into a running main turn is pending text like a turn's own. It leaves the command
// mark and the captured skill body alone: those belong to the turn that began with them.
export async function appendDelivered($: TurnDollar, text: string, now: number): Promise<void> {
  try {
    const head = text.slice(0, ENTRY_MAX + REDACT_WINDOW_MARGIN)
    if (head.trim() === '') return
    const entry = redactedBound(head, ENTRY_MAX, text.length > head.length)
    const id = crypto.randomUUID()
    let dropped = 0
    await update($, charterAtom, charter => {
      if (charter === null) {
        dropped = 0
        return newCharter(id, now, entry)
      }
      const appended = appendPending(charter.pendingText, entry)
      dropped = appended.dropped
      return { ...charter, pendingText: appended.list }
    })
    if (dropped > 0) $.ui.log(`stayontarget: charter pending overflow, dropped ${dropped}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`stayontarget: delivered text not recorded: ${messageOf(err)}`, { to: 'debug' })
  }
}

// FR-CH-3: a slash command or typed skill marks the next turn; the skill's body that fires then is kept for it.
export function onCommandSubmitted(now: number): void {
  commandMarkAt = now
}

export function onSkillPrompt(text: string, now: number): void {
  if (commandMarkAt === null || now - commandMarkAt >= SKILL_WINDOW_MS) return
  skillBody = redactedBound(text, SKILL_MAX)
}

// Single-flight per (id, rev) (FR-CH-5): a caller that arrives while an update of that charter is running shares it.
// Text that arrived meanwhile is folded in by the update's own recompute.
const inFlight = new Map<string, Promise<Charter | null>>()

// FR-CH-4 and FR-CH-5: resolves pending text into the charter with at most one model call per (id, rev). A failure
// returns the charter with the pending text merged unverified (FR-CH-7). Never throws. The whole call, joining a flight
// included, finishes within `budgetMs` (NFR-2): on budget out it returns the charter as it stands, and a flight it started
// keeps running and commits on its own.
export async function ensureCharter(
  $: CharterDollar,
  cfg: Config,
  now: number,
  budgetMs = CHARTER_DEADLINE_MS,
): Promise<Charter | null> {
  try {
    const started = await $.clock.now()
    const charter = await read($, charterAtom)
    if (charter === null || charter.pendingText.length === 0) return charter

    const key = flightKey(charter)
    const flight = inFlight.get(key) ?? startFlight($, cfg, now, key, charter, Math.min(budgetMs, CHARTER_DEADLINE_MS))
    return await joinWithin($, flight, budgetMs - ((await $.clock.now()) - started))
  } catch (err) {
    $.ui.log(`stayontarget: charter update failed: ${messageOf(err)}`, { to: 'debug' })
    return null
  }
}

// Registers the flight for `charter`'s revision before its first await, so no other caller can miss it. The stored promise
// never rejects: a flight that fails after its caller has left (joins time out) logs, and settles as the charter as read.
function startFlight(
  $: CharterDollar,
  cfg: Config,
  now: number,
  key: string,
  charter: Charter,
  deadlineMs: number,
): Promise<Charter | null> {
  const work: Promise<Charter | null> = resolve($, cfg, now, key, charter, deadlineMs)
    .catch(async err => {
      $.ui.log(`stayontarget: charter update failed: ${messageOf(err)}`, { to: 'debug' })
      return await read($, charterAtom).catch(() => null)
    })
    .finally(() => {
      if (inFlight.get(key) === work) inFlight.delete(key)
    })
  inFlight.set(key, work)
  return work
}

function flightKey(charter: Charter): string {
  return `${charter.id}:${charter.rev}`
}

// One model call for `base`, committed only if the base still stands (FR-CH-5).
async function attempt(
  $: CharterDollar,
  cfg: Config,
  base: Charter,
  now: number,
  deadlineMs: number,
): Promise<{ applied: boolean; charter: Charter | null }> {
  const result = await ask($, cfg, base, deadlineMs)
  const applied = await commit($, base, result.reply, now)
  await record($, result, applied.applied)
  return applied
}

// One attempt, plus one recompute when the base changed while the model call ran (FR-CH-5). Both share one deadline
// of `deadlineMs` from the start (no unbounded wait); a recompute with less than RECOMPUTE_MIN_MS left is skipped,
// and the pending text stays pending for the next ensure. The recompute is single-flight too: if the charter's
// revision moved on and a flight for it is already running, this call shares that flight instead of calling the model.
// `base` is the charter ensureCharter read to make the key: the first attempt uses it as it is, with no second read, so
// the attempt is for the revision its key names (a stale base is caught by the CAS commit).
async function resolve(
  $: CharterDollar,
  cfg: Config,
  now: number,
  key: string,
  base: Charter,
  deadlineMs: number,
): Promise<Charter | null> {
  const started = await $.clock.now()
  const budget = async () => deadlineMs - ((await $.clock.now()) - started)

  const first = await attempt($, cfg, base, now, await budget())
  if (first.applied) return first.charter

  // Every await comes first. The map check and the registration below run in one synchronous step, so no other
  // caller can register a flight for this revision in between (FR-CH-5).
  const current = await read($, charterAtom)
  if (current === null || current.pendingText.length === 0) return current
  const next = flightKey(current)
  const remaining = await budget()
  if (remaining < RECOMPUTE_MIN_MS) return current

  if (next === key) {
    const second = await attempt($, cfg, current, now, remaining)
    return second.applied ? second.charter : read($, charterAtom)
  }

  const sharing = inFlight.get(next)
  if (sharing !== undefined) return await joinWithin($, sharing, remaining)

  // This recompute becomes the flight for the revision it works on, registered before its model call starts.
  const recompute: Promise<Charter | null> = attempt($, cfg, current, now, remaining)
    .then(done => (done.applied ? done.charter : read($, charterAtom)))
    .finally(() => {
      if (inFlight.get(next) === recompute) inFlight.delete(next)
    })
  inFlight.set(next, recompute)
  return await recompute
}

// Waits for another flight within the remaining budget (no unbounded wait). On budget out, returns the charter as it
// stands; the other flight keeps running and commits on its own.
async function joinWithin($: CharterDollar, sharing: Promise<Charter | null>, remaining: number): Promise<Charter | null> {
  const expiry = new AbortController()
  const expired = $.clock.sleep(remaining, { signal: expiry.signal }).then(
    () => ({ done: false as const }),
    () => ({ done: false as const }),
  )
  const joined = sharing.then(charter => ({ done: true as const, charter }))
  const outcome = await Promise.race([joined, expired])
  expiry.abort()
  return outcome.done ? outcome.charter : read($, charterAtom)
}

async function ask($: CharterDollar, cfg: Config, base: Charter, deadlineMs: number): Promise<Attempt> {
  const outcome: ModelOutcome = await callModel($, {
    model: cfg.model,
    instructions: CHARTER_INSTRUCTIONS,
    body: askBody(base),
    maxTokens: CHARTER_MAX_TOKENS,
    deadlineMs,
  })
  // Usage counts on every outcome the model reported, failures included (NFR-3).
  const usage = { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens }
  if (!outcome.ok) return { reply: null, detail: `${outcome.reason}: ${outcome.detail}`, usage }

  const reply = parseReply(outcome.text)
  return reply === null ? { reply: null, detail: 'invalid reply', usage } : { reply, detail: reply.kind, usage }
}

function askBody(charter: Charter): string {
  const current =
    noTaskYet(charter)
      ? 'none'
      : JSON.stringify({
          goal: charter.goal,
          inScope: charter.inScope,
          outOfScope: charter.outOfScope,
          request: charter.request.slice(-REQUEST_CONTEXT),
        })
  const messages = charter.pendingText.map((text, i) => `${i + 1}. ${text}`).join('\n')
  return `CURRENT CHARTER:\n${current}\n\nNEW MESSAGES:\n${messages}`
}

function clean(text: string): string {
  return redactedBound(text.trim(), ITEM_MAX)
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items: unknown[] = value.slice(0, LIST_MAX)
  if (!items.every((item): item is string => typeof item === 'string')) return null
  return items.map(item => clean(item))
}

function parseReply(text: string): Distilled | null {
  const value = parseJsonObject(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  const kind = fields.kind
  const goal = fields.goal
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null
  if (typeof goal !== 'string' || goal.trim() === '') return null
  const inScope = stringList(fields.inScope)
  const outOfScope = stringList(fields.outOfScope)
  if (inScope === null || outOfScope === null) return null
  return { kind: kind as Kind, goal: clean(goal), inScope, outOfScope }
}

function sameBase(current: Charter, base: Charter): boolean {
  return (
    current.id === base.id &&
    current.rev === base.rev &&
    current.pendingText.length === base.pendingText.length &&
    current.pendingText.every((text, i) => text === base.pendingText[i])
  )
}

// A charter with no task yet has an empty request: nothing has been distilled or merged into it. An edit may have
// moved its rev already, so this, not the rev, is what says it is the first resolution.
function noTaskYet(charter: Charter): boolean {
  return charter.request === ''
}

// Applies a reply (or the failure) to the charter the attempt was based on. Pure: the update may run it more than once.
function applyAttempt(current: Charter, reply: Distilled | null, freshId: string, now: number): Charter {
  const pending = current.pendingText.join('\n')
  const first = noTaskYet(current)

  // FR-CH-7: merged unverified as an amendment; the goal and scope are left as they were.
  if (reply === null) {
    const request = first ? pending : `${current.request}${AMENDMENT_SEPARATOR}${pending}`
    return { ...current, rev: current.rev + 1, request: capRequest(request), distilled: false, pendingText: [] }
  }

  // A charter with no task yet has its first reply as a new task (FR-CH-4). It keeps its id, its createdAt and any
  // field the person edited; only the fields the person did not edit take the reply.
  const kind: Kind = first ? 'new-task' : reply.kind
  if (kind === 'chit-chat') return { ...current, pendingText: [] }

  if (kind === 'new-task' && first) {
    return {
      ...current,
      rev: current.rev + 1,
      request: capRequest(pending),
      goal: current.editedFields.includes('goal') ? current.goal : reply.goal,
      inScope: reply.inScope,
      outOfScope: reply.outOfScope,
      distilled: true,
      pendingText: [],
    }
  }

  if (kind === 'new-task') {
    return {
      ...current,
      id: freshId,
      rev: 1,
      request: capRequest(pending),
      goal: reply.goal,
      inScope: reply.inScope,
      outOfScope: reply.outOfScope,
      distilled: true,
      editedFields: [],
      pendingText: [],
      createdAt: now,
    }
  }

  return {
    ...current,
    rev: current.rev + 1,
    request: capRequest(`${current.request}${AMENDMENT_SEPARATOR}${pending}`),
    goal: current.editedFields.includes('goal') ? current.goal : reply.goal,
    inScope: reply.inScope,
    outOfScope: reply.outOfScope,
    distilled: true,
    pendingText: [],
  }
}

// Commits the attempt only if its base is still current. The flag is read from the last run of the update.
async function commit(
  $: CharterDollar,
  base: Charter,
  reply: Distilled | null,
  now: number,
): Promise<{ applied: boolean; charter: Charter | null }> {
  const freshId = crypto.randomUUID()
  const result: { applied: boolean } = { applied: false }
  const charter = await update($, charterAtom, current => {
    if (current === null || !sameBase(current, base)) {
      result.applied = false
      return current
    }
    result.applied = true
    return applyAttempt(current, reply, freshId, now)
  })
  return { applied: result.applied, charter }
}

// Tokens count whether or not the attempt was applied; the outcome counters count only an applied one.
async function record($: CharterDollar, attempt: Attempt, applied: boolean): Promise<void> {
  const counted = applied ? (attempt.reply === null ? 'failure' : 'update') : null
  await update($, statsAtom, stats => ({
    ...stats,
    inputTokens: stats.inputTokens + attempt.usage.inputTokens,
    outputTokens: stats.outputTokens + attempt.usage.outputTokens,
    charterUpdates: stats.charterUpdates + (counted === 'update' ? 1 : 0),
    charterFailures: stats.charterFailures + (counted === 'failure' ? 1 : 0),
  }))
  const outcome = attempt.reply === null ? `not distilled (${attempt.detail})` : attempt.detail
  $.ui.log(`stayontarget: charter ${outcome}${applied ? '' : ', discarded: base changed'}`, { to: 'debug' })
}

// FR-CH-8: the person's goal, trimmed and bounded; it counts as an edit, so a later amendment keeps it.
export async function editGoal($: StateDollar, goal: string): Promise<void> {
  const text = redactedBound(goal, ITEM_MAX).trim()
  if (text === '') return
  const goalEdited: Charter['editedFields'] = ['goal']
  await update($, charterAtom, charter =>
    charter === null
      ? null
      : {
          ...charter,
          goal: text,
          editedFields: charter.editedFields.includes('goal') ? charter.editedFields : goalEdited,
          rev: charter.rev + 1,
        },
  )
}

// FR-CH-8: the next main turn creates a new charter.
export async function startNewTask($: StateDollar): Promise<void> {
  await update($, charterAtom, () => null)
}
