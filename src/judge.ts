import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Allowance, Charter, DriftEvent, Stats, Verdict } from '../types'

import type { Action } from './action'
import { REDACT_WINDOW_MARGIN, fingerprint } from './action'
import type { CharterDollar } from './charter'
import { ensureCharter } from './charter'
import type { Config } from './config'
import { callModel, messageOf, parseJsonObject } from './model'
import { JUDGE_INSTRUCTIONS } from './prompts'
import { redactText } from './redact'
import { EMPTY_STATS } from './state'

// The engine's scan needs each atom in the file that reads or writes it, so the atoms are declared here. Ref and initial
// value match src/state.ts; the wiring test checks that they do.
const allowancesAtom = atom({ plugin: 'stayontarget', key: 'allowances' } as const, [] as Allowance[])
const eventsAtom = atom({ plugin: 'stayontarget', key: 'events' } as const, [] as DriftEvent[])
const statsAtom = atom({ plugin: 'stayontarget', key: 'stats' } as const, EMPTY_STATS)
export const __atoms = { allowancesAtom, eventsAtom, statsAtom }

export type Decision = {
  verdict: Verdict
  reason: string
  source: 'judge' | 'cache' | 'allowance' | 'none'
  charterId: string | null
  charterRev: number
  // The head of the charter this was judged against (headOf), so a note quotes the charter the verdict is for.
  charterHead: string | null
}

const GOAL_HEAD_MAX = 120

// The person's goal, or else the head of their request, bounded: the words a verdict note or a strict ask quotes back.
export function headOf(charter: Charter): string {
  return (charter.goal ?? charter.request).slice(0, GOAL_HEAD_MAX)
}

type JudgedVerdict = Exclude<Verdict, 'unchecked'>
type Judged = { verdict: JudgedVerdict; reason: string }
type Usage = { inputTokens: number; outputTokens: number }
// A failed judgement's reason is already the unchecked reason (`judge <reason>`).
type Judgement = ({ ok: true } & Judged & { usage: Usage }) | { ok: false; reason: string; usage: Usage }
type JudgeAction = Extract<Action, { kind: 'ok' }>

// The engine nouns one model call uses: the model, the clock (through callModel) and the debug log.
export type JudgeDollar = Pick<EngineInterface, 'model' | 'clock' | 'ui'>
export type JudgeOnce = {
  verdict: Verdict
  reason: string
  ok: boolean
  inputTokens: number
  outputTokens: number
}

const VERDICTS: readonly string[] = ['in-scope', 'adjacent', 'drift']
const CACHE_MAX = 500
const RECENT_MAX = 8
const REQUEST_MAX = 4000
const REQUEST_HEAD = 1000
const REQUEST_TAIL = 2900
const REASON_MAX = 160
const JUDGE_MAX_TOKENS = 200
// One budget for the whole decision, charter resolution included (NFR-2). The judge gets what the charter left, and a
// judge call with less than JUDGE_MIN_MS left is not made.
const DECISION_DEADLINE_MS = 8000
const JUDGE_MIN_MS = 1000
const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 }

// FR-VD-3 step 4: verdicts of judge calls, by fingerprint. Insertion order is age order, so the oldest is evicted first.
const verdictCache = new Map<string, Judged>()
// Judge calls in flight, by fingerprint: a call that arrives while one is running shares it, so one fingerprint costs one
// model call (NFR-3) and the parallel calls of one step do not both pay for it (NFR-5).
const judging = new Map<string, Promise<Judgement>>()

export function clearVerdictCache(): void {
  verdictCache.clear()
  judging.clear()
}

// Decides one action's verdict in the order of FR-VD-3. Never throws: any failure is an unchecked decision (FR-VD-5).
export async function decide($: CharterDollar, cfg: Config, action: Action, now: number): Promise<Decision> {
  const decision = await run($, cfg, action, now).catch(err => {
    $.ui.log(`stayontarget: verdict failed: ${messageOf(err)}`, { to: 'debug' })
    return unchecked('internal error')
  })
  // Every unchecked decision is counted here, once (FR-RS-6); the paths above do not count their own.
  if (decision.verdict === 'unchecked') await count($, stats => ({ ...stats, unchecked: stats.unchecked + 1 }))
  $.ui.log(`stayontarget: ${action.tool} ${decision.verdict} (${decision.source}): ${decision.reason}`, { to: 'debug' })
  return decision
}

async function run($: CharterDollar, cfg: Config, action: Action, now: number): Promise<Decision> {
  if (action.kind === 'unsupported') return unchecked('no-target')
  const started = await $.clock.now()
  const charter = await ensureCharter($, cfg, now, DECISION_DEADLINE_MS)
  if (charter === null) return unchecked('no-charter')
  // Its budget ran out before the newest request was resolved: the charter is the old one, so nothing is checked
  // against it (FR-CH-7). No allowance, no cached verdict, no model call.
  if (charter.pendingText.length > 0) return unchecked('charter pending', charter)

  const allowances = await read($, allowancesAtom)
  const allowed = allowances.some(
    allowance =>
      allowance.charterId === charter.id && allowance.tool === action.tool && allowance.target === action.target,
  )
  if (allowed) {
    await count($, stats => ({ ...stats, allowanceHits: stats.allowanceHits + 1 }))
    return verdictOf(charter, 'in-scope', 'allowed by you', 'allowance')
  }

  const key = await fingerprint(charter.id, charter.rev, action.tool, action.judgeText)
  // Every await comes before the lookups. From the cache lookup to the flight registration nothing awaits, so a caller
  // always sees the cached verdict or the flight of the call that makes it (NFR-3, NFR-5).
  const remaining = DECISION_DEADLINE_MS - ((await $.clock.now()) - started)
  const cached = verdictCache.get(key)
  if (cached !== undefined) {
    await count($, stats => ({ ...stats, cacheHits: stats.cacheHits + 1 }))
    return verdictOf(charter, cached.verdict, cached.reason, 'cache')
  }
  if (remaining < JUDGE_MIN_MS) return unchecked('judge timeout', charter)

  const joined = judging.get(key)
  const owned = joined === undefined
  const judgement = joined ?? startJudge($, cfg, charter, action, key, remaining)
  const outcome = await withinBudget($, judgement, remaining)
  if (outcome === undefined) {
    // The call keeps running and its tokens still count (NFR-3); the decision does not wait for it.
    if (owned) void judgement.then(late => count($, stats => spent(stats, late.usage)))
    return unchecked('judge timeout', charter)
  }
  return settle($, charter, outcome, owned)
}

function startJudge(
  $: CharterDollar,
  cfg: Config,
  charter: Charter,
  action: JudgeAction,
  key: string,
  deadlineMs: number,
): Promise<Judgement> {
  const started: Promise<Judgement> = judge($, cfg, charter, action, key, deadlineMs).finally(() => {
    if (judging.get(key) === started) judging.delete(key)
  })
  judging.set(key, started)
  return started
}

// Waits for `work` at most `ms`: undefined when the budget runs out first. The timer is aborted once the race settles.
async function withinBudget($: CharterDollar, work: Promise<Judgement>, ms: number): Promise<Judgement | undefined> {
  const expiry = new AbortController()
  try {
    const expired = $.clock.sleep(ms, { signal: expiry.signal }).then(
      () => undefined,
      () => undefined,
    )
    return await Promise.race([work, expired])
  } finally {
    expiry.abort()
  }
}

// One model call and its reply, within `deadlineMs`. Never throws, and reads and writes no state or cache: the caller owns
// both. A failure is unchecked with reason `judge <reason>`; its tokens are reported on every outcome (NFR-3).
export async function judgeOnce(
  $: JudgeDollar,
  cfg: Config,
  charter: Charter,
  recent: DriftEvent[],
  action: JudgeAction,
  deadlineMs: number,
): Promise<JudgeOnce> {
  try {
    const outcome = await callModel($, {
      model: cfg.model,
      instructions: JUDGE_INSTRUCTIONS,
      body: buildJudgeBody(charter, recent, action),
      maxTokens: JUDGE_MAX_TOKENS,
      deadlineMs,
    })
    const tokens = { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens }
    if (!outcome.ok) return { verdict: 'unchecked', reason: `judge ${outcome.reason}`, ok: false, ...tokens }

    const parsed = parseVerdict(outcome.text)
    if (parsed === null) return { verdict: 'unchecked', reason: 'judge invalid-reply', ok: false, ...tokens }
    return { verdict: parsed.verdict, reason: parsed.reason, ok: true, ...tokens }
  } catch (err) {
    $.ui.log(`stayontarget: judge failed: ${messageOf(err)}`, { to: 'debug' })
    return { verdict: 'unchecked', reason: 'judge internal error', ok: false, inputTokens: 0, outputTokens: 0 }
  }
}

// One model call for a decision, within `deadlineMs`. Never throws; its tokens are reported on every outcome (NFR-3).
async function judge(
  $: CharterDollar,
  cfg: Config,
  charter: Charter,
  action: JudgeAction,
  key: string,
  deadlineMs: number,
): Promise<Judgement> {
  try {
    const events = await read($, eventsAtom)
    const once = await judgeOnce($, cfg, charter, events, action, deadlineMs)
    const usage = { inputTokens: once.inputTokens, outputTokens: once.outputTokens }
    if (!once.ok) return { ok: false, reason: once.reason, usage }

    const parsed = { verdict: once.verdict as JudgedVerdict, reason: once.reason }
    remember(key, parsed)
    return { ok: true, ...parsed, usage }
  } catch (err) {
    $.ui.log(`stayontarget: judge failed: ${messageOf(err)}`, { to: 'debug' })
    return { ok: false, reason: 'judge internal error', usage: NO_USAGE }
  }
}

// Counts a judgement for the caller that asked. Only the caller that made the model call counts its tokens; a caller that
// shared the call counts as a cache hit.
async function settle($: CharterDollar, charter: Charter, judgement: Judgement, owned: boolean): Promise<Decision> {
  const usage = owned ? judgement.usage : NO_USAGE
  if (!judgement.ok) {
    await count($, stats => spent(stats, usage))
    return unchecked(judgement.reason, charter)
  }
  if (owned) {
    await count($, stats => ({ ...spent(stats, usage), judged: stats.judged + 1 }))
    return verdictOf(charter, judgement.verdict, judgement.reason, 'judge')
  }
  await count($, stats => ({ ...stats, cacheHits: stats.cacheHits + 1 }))
  return verdictOf(charter, judgement.verdict, judgement.reason, 'cache')
}

function remember(key: string, judged: Judged): void {
  verdictCache.delete(key)
  verdictCache.set(key, judged)
  if (verdictCache.size > CACHE_MAX) {
    const oldest = verdictCache.keys().next().value
    if (oldest !== undefined) verdictCache.delete(oldest)
  }
}

function parseVerdict(text: string): Judged | null {
  const value = parseJsonObject(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  const verdict = fields.verdict
  const reason = fields.reason
  if (typeof verdict !== 'string' || !VERDICTS.includes(verdict)) return null
  if (typeof reason !== 'string' || reason.trim() === '') return null
  return { verdict: verdict as JudgedVerdict, reason: boundedReason(reason.trim()) }
}

// The model's reason is shown and stored, so it is redacted before it is kept, then bounded to REASON_MAX.
function boundedReason(text: string): string {
  const window = text.slice(0, REASON_MAX + REDACT_WINDOW_MARGIN)
  const redacted = redactText(window, text.length > window.length)
  if (redacted.length <= REASON_MAX) return redacted
  const last = redacted.charCodeAt(REASON_MAX - 1)
  return redacted.slice(0, last >= 0xd800 && last <= 0xdbff ? REASON_MAX - 1 : REASON_MAX)
}

export function buildJudgeBody(charter: Charter, recent: DriftEvent[], action: JudgeAction): string {
  return [
    'CHARTER',
    `goal: ${charter.goal ?? '(not distilled)'}`,
    `inScope: ${listOf(charter.inScope)}`,
    `outOfScope: ${listOf(charter.outOfScope)}`,
    'request:',
    capRequest(charter.request),
    '',
    'RECENT ACTIONS (oldest first)',
    recentLines(charter.id, recent),
    '',
    'PROPOSED ACTION',
    action.judgeText,
  ].join('\n')
}

function listOf(items: string[]): string {
  return items.length === 0 ? '(none)' : items.join('; ')
}

function capRequest(request: string): string {
  return request.length > REQUEST_MAX
    ? `${request.slice(0, REQUEST_HEAD)}\n…\n${request.slice(-REQUEST_TAIL)}`
    : request
}

// The last RECENT_MAX events of this charter, oldest first. Walks back from the newest and stops once it has them.
function recentLines(charterId: string, events: DriftEvent[]): string {
  const lines: string[] = []
  for (let i = events.length - 1; i >= 0 && lines.length < RECENT_MAX; i--) {
    const event = events[i]
    if (event !== undefined && event.charterId === charterId) {
      lines.push(`${event.verdict} | ${event.tool} | ${event.target}`)
    }
  }
  return lines.length === 0 ? '(none)' : lines.reverse().join('\n')
}

function verdictOf(charter: Charter, verdict: Verdict, reason: string, source: Decision['source']): Decision {
  return { verdict, reason, source, charterId: charter.id, charterRev: charter.rev, charterHead: headOf(charter) }
}

function unchecked(reason: string, charter: Charter | null = null): Decision {
  return {
    verdict: 'unchecked',
    reason,
    source: 'none',
    charterId: charter?.id ?? null,
    charterRev: charter?.rev ?? 0,
    charterHead: charter === null ? null : headOf(charter),
  }
}

function spent(stats: Stats, usage: Usage): Stats {
  return {
    ...stats,
    inputTokens: stats.inputTokens + usage.inputTokens,
    outputTokens: stats.outputTokens + usage.outputTokens,
  }
}

// A failed count leaves the decision as it is: the counters never change a verdict.
async function count($: CharterDollar, change: (stats: Stats) => Stats): Promise<void> {
  try {
    await update($, statsAtom, change)
  } catch (err) {
    $.ui.log(`stayontarget: stats not recorded: ${messageOf(err)}`, { to: 'debug' })
  }
}
