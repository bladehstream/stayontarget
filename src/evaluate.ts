import type { DriftEvent, Charter, Verdict } from '../types'

import { REDACT_WINDOW_MARGIN, bound, extractAction } from './action'
import { CHARTER_MAX_TOKENS, askBody, charterOfCase, parseReply } from './charter'
import type { Config } from './config'
import type { JudgeDollar } from './judge'
import { judgeOnce } from './judge'
import { CONCURRENCY, callModel, messageOf } from './model'
import { CHARTER_INSTRUCTIONS } from './prompts'
import { redactText } from './redact'

// FR-EV-1: one labelled case of the eval set (evals/drift-cases.json). `expected` is the verdict the case should get.
export type EvalClass = 'in-scope' | 'adjacent' | 'drift'
export type EvalCase = {
  id: string
  charter: { goal: string; inScope: string[]; outOfScope: string[]; request: string }
  recent: string[]
  action: { tool: string; input: unknown }
  expected: EvalClass
}

export type EvalReport = {
  cases: { id: string; expected: EvalClass; got: Verdict; reason: string }[]
  // matrix[expected][got]: how often each expected class got each verdict, unchecked included.
  matrix: Record<EvalClass, Record<Verdict, number>>
  // Precision over the predictions of a class; recall over the cases expected to be that class. null when the
  // denominator is zero (no predictions, or no expected cases).
  precision: Record<EvalClass, number | null>
  recall: Record<EvalClass, number | null>
  accuracy: number
  unchecked: number
  inputTokens: number
  outputTokens: number
  elapsedMs: number
  // How many cases the file holds, and how many ran: fewer when the run was stopped.
  total: number
}

const CLASSES: readonly EvalClass[] = ['in-scope', 'adjacent', 'drift']
const VERDICTS: readonly Verdict[] = ['in-scope', 'adjacent', 'drift', 'unchecked']
const MAX_CASES = 200
const MAX_LIST = 50
// The judge's wait for each case. A batch's calls never queue, so this only bounds a call that the model holds.
const EVAL_DEADLINE_MS = 60_000

type Judged = Pick<EvalReport['cases'][number], 'got' | 'reason'> & { inputTokens: number; outputTokens: number }
type Fields = Record<string, unknown>

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(id: string, detail: string): never {
  throw new Error(`eval case "${id}": ${detail}`)
}

function stringsOf(value: unknown, id: string, field: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) fail(id, `${field} must be a list of at most ${MAX_LIST} strings`)
  for (const item of value) if (typeof item !== 'string') fail(id, `${field} must hold only strings`)
  return value as string[]
}

function textOf(value: unknown, id: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(id, `${field} must be a non-empty string`)
  return value
}

// A recent line is `<verdict> | <tool> | <target>`; the split is on the first two separators only, so the target keeps
// any others. Null when the line does not have that shape or its verdict is not a judged one.
function splitRecent(line: string): { verdict: EvalClass; tool: string; target: string } | null {
  const first = line.indexOf(' | ')
  const second = first === -1 ? -1 : line.indexOf(' | ', first + 3)
  if (second === -1) return null
  const verdict = line.slice(0, first)
  if (!CLASSES.includes(verdict as EvalClass)) return null
  return { verdict: verdict as EvalClass, tool: line.slice(first + 3, second), target: line.slice(second + 3) }
}

// Validates the whole file before anything is judged; a bad case throws with its id.
export function parseCases(json: string): EvalCase[] {
  let root: unknown
  try {
    root = JSON.parse(json)
  } catch (err) {
    throw new Error(`eval file is not JSON: ${messageOf(err)}`)
  }
  const list = isRecord(root) ? root.cases : undefined
  if (!Array.isArray(list) || list.length === 0) throw new Error('eval file has no "cases" list')
  if (list.length > MAX_CASES) throw new Error(`eval file has more than ${MAX_CASES} cases`)

  const seen = new Set<string>()
  return list.map((raw, index): EvalCase => {
    if (!isRecord(raw)) throw new Error(`eval case #${index}: not an object`)
    const id = textOf(raw.id, `#${index}`, 'id')
    if (seen.has(id)) fail(id, 'duplicate id')
    seen.add(id)

    if (!isRecord(raw.charter)) fail(id, 'charter must be an object')
    const charter = raw.charter
    const goal = textOf(charter.goal, id, 'charter.goal')
    const request = textOf(charter.request, id, 'charter.request')
    const inScope = stringsOf(charter.inScope, id, 'charter.inScope')
    const outOfScope = stringsOf(charter.outOfScope, id, 'charter.outOfScope')

    const recent = stringsOf(raw.recent, id, 'recent')
    for (const line of recent) if (splitRecent(line) === null) fail(id, `recent line "${line}" is not "<verdict> | <tool> | <target>"`)

    if (!isRecord(raw.action)) fail(id, 'action must be an object')
    const tool = textOf(raw.action.tool, id, 'action.tool')
    if (!('input' in raw.action)) fail(id, 'action.input is missing')

    if (!CLASSES.includes(raw.expected as EvalClass)) fail(id, 'expected must be in-scope, adjacent or drift')
    return {
      id,
      charter: { goal, inScope, outOfScope, request },
      recent,
      action: { tool, input: raw.action.input },
      expected: raw.expected as EvalClass,
    }
  })
}

// Case text as the judge sees it: redacted over a window with a margin, so a secret cut at the bound is still seen, then
// bounded. The same helpers action.ts and charter.ts use on production text.
function clean(text: string, max: number): string {
  const window = text.slice(0, max + REDACT_WINDOW_MARGIN)
  return bound(redactText(window, text.length > window.length), max)
}

const REQUEST_CASE_MAX = 4000
const ITEM_CASE_MAX = 200
const TOOL_CASE_MAX = 120

// The charter the case describes, as the judge sees one.
function charterOf(c: EvalCase): Charter {
  return {
    id: `eval-${c.id}`,
    rev: 1,
    request: clean(c.charter.request, REQUEST_CASE_MAX),
    goal: clean(c.charter.goal, ITEM_CASE_MAX),
    inScope: c.charter.inScope.map(item => clean(item, ITEM_CASE_MAX)),
    outOfScope: c.charter.outOfScope.map(item => clean(item, ITEM_CASE_MAX)),
    distilled: true,
    editedFields: [],
    pendingText: [],
    createdAt: 0,
  }
}

// The recent lines as the events buildJudgeBody reads. Each carries the case's charter id, so none is dropped.
function recentOf(c: EvalCase): DriftEvent[] {
  return c.recent.map((line, index): DriftEvent => {
    const parts = splitRecent(line)
    if (parts === null) throw new Error(`eval case "${c.id}": recent line "${line}" is not "<verdict> | <tool> | <target>"`)
    return {
      id: `eval-${c.id}-${index}`,
      toolUseId: '',
      charterId: `eval-${c.id}`,
      charterRev: 1,
      mainTurnId: null,
      agentId: null,
      tool: clean(parts.tool, TOOL_CASE_MAX),
      target: clean(parts.target, ITEM_CASE_MAX),
      verdict: parts.verdict,
      reason: '',
      excerpt: '',
      cwd: null,
      source: 'judge',
      action: 'none',
      status: 'open',
      at: 0,
    }
  })
}

// One case through the production judge. An action the mod cannot check is a mismatch with no model call; a failure is an
// unchecked verdict. Never throws, so one case cannot end the run.
async function evaluateCase($: JudgeDollar, cfg: Config, c: EvalCase): Promise<Judged> {
  try {
    const action = extractAction(c.action.tool, c.action.input, null)
    if (action.kind !== 'ok') return { got: 'unchecked', reason: action.reason, inputTokens: 0, outputTokens: 0 }
    const once = await judgeOnce($, cfg, charterOf(c), recentOf(c), action, EVAL_DEADLINE_MS)
    return { got: once.verdict, reason: once.reason, inputTokens: once.inputTokens, outputTokens: once.outputTokens }
  } catch (err) {
    $.ui.log(`stayontarget: eval case ${c.id} failed: ${messageOf(err)}`, { to: 'debug' })
    return { got: 'unchecked', reason: 'internal error', inputTokens: 0, outputTokens: 0 }
  }
}

// Runs the cases in batches of CONCURRENCY, each batch awaited before the next starts, so a batch's calls never queue
// for a model slot: a queue wait would count against the hook's budget. A signal aborted between batches stops the run
// with the cases so far reported. Never throws.
export async function runEval(
  $: JudgeDollar,
  cfg: Config,
  cases: EvalCase[],
  signal?: AbortSignal,
): Promise<EvalReport> {
  const started = await $.clock.now()
  const judged: Judged[] = []
  for (let i = 0; i < cases.length && signal?.aborted !== true; i += CONCURRENCY) {
    const batch = cases.slice(i, i + CONCURRENCY)
    judged.push(...(await Promise.all(batch.map(c => evaluateCase($, cfg, c)))))
  }
  const elapsedMs = (await $.clock.now()) - started

  const matrix = Object.fromEntries(
    CLASSES.map(expected => [expected, Object.fromEntries(VERDICTS.map(got => [got, 0]))]),
  ) as EvalReport['matrix']
  const cells = judged.map((result, index) => {
    const c = cases[index] as EvalCase
    matrix[c.expected][result.got] += 1
    return { id: c.id, expected: c.expected, got: result.got, reason: result.reason }
  })

  const precision = {} as EvalReport['precision']
  const recall = {} as EvalReport['recall']
  for (const cls of CLASSES) {
    const predicted = cells.filter(x => x.got === cls).length
    const correct = cells.filter(x => x.got === cls && x.expected === cls).length
    const expected = cells.filter(x => x.expected === cls).length
    precision[cls] = predicted === 0 ? null : correct / predicted
    recall[cls] = expected === 0 ? null : correct / expected
  }

  const correct = cells.filter(x => x.got === x.expected).length
  return {
    cases: cells,
    matrix,
    precision,
    recall,
    accuracy: cells.length === 0 ? 0 : correct / cells.length,
    unchecked: cells.filter(x => x.got === 'unchecked').length,
    inputTokens: judged.reduce((sum, j) => sum + j.inputTokens, 0),
    outputTokens: judged.reduce((sum, j) => sum + j.outputTokens, 0),
    elapsedMs,
    total: cases.length,
  }
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

// The report as Markdown: the summary, the confusion matrix, precision and recall, then every mismatch.
export function formatReport(r: EvalReport): string {
  const lines = [
    '# stayontarget eval',
    '',
    `Cases: ${r.cases.length} · accuracy ${percent(r.accuracy)} · unchecked ${r.unchecked} · ` +
      `tokens in ${r.inputTokens} / out ${r.outputTokens} · elapsed ${r.elapsedMs} ms`,
    ...(r.cases.length < r.total ? [`Stopped early: ${r.cases.length} of ${r.total} cases ran.`] : []),
    '',
    '## Confusion matrix (rows: expected, columns: got)',
    '',
    `| expected | ${VERDICTS.join(' | ')} |`,
    `|---|${VERDICTS.map(() => '---').join('|')}|`,
    ...CLASSES.map(expected => `| ${expected} | ${VERDICTS.map(got => r.matrix[expected][got]).join(' | ')} |`),
    '',
    '## Precision and recall',
    '',
    '| class | precision | recall |',
    '|---|---|---|',
    ...CLASSES.map(cls => `| ${cls} | ${percent(r.precision[cls])} | ${percent(r.recall[cls])} |`),
    '',
    '## Mismatches',
    '',
  ]
  const mismatches = r.cases.filter(c => c.got !== c.expected)
  if (mismatches.length === 0) lines.push('None.')
  for (const c of mismatches) lines.push(`- ${c.id}: expected ${c.expected}, got ${c.got} — ${c.reason}`)
  return lines.join('\n')
}

// FR-EV-3: one labelled case of the charter eval (evals/charter-cases.json). `charter` is null for a session with no task
// yet; `messages` are the new messages the reading is about, oldest first; `expected` is the kind the case should get.
export type CharterKind = 'new-task' | 'amendment' | 'chit-chat'
export type CharterCase = {
  id: string
  charter: { goal: string; inScope: string[]; outOfScope: string[]; request: string } | null
  messages: string[]
  expected: CharterKind
}

// The columns of the charter matrix: a model's kind, or unchecked (a failed call or an invalid reply).
export type CharterColumn = CharterKind | 'unchecked'
const CHARTER_KINDS: readonly CharterKind[] = ['new-task', 'amendment', 'chit-chat']
const CHARTER_COLUMNS: readonly CharterColumn[] = [...CHARTER_KINDS, 'unchecked']

export type CharterEvalReport = {
  cases: { id: string; expected: CharterKind; got: CharterColumn; reason: string }[]
  // matrix[expected][got]: how often each expected kind got each column.
  matrix: Record<CharterKind, Record<CharterColumn, number>>
  // As EvalReport: null when the denominator is zero.
  precision: Record<CharterKind, number | null>
  recall: Record<CharterKind, number | null>
  accuracy: number
  unchecked: number
  inputTokens: number
  outputTokens: number
  elapsedMs: number
  total: number
}

// Validates the whole charter file before anything is classified; a bad case throws with its id. The shape is the one the
// file is labelled in: id, charter (null or the four fields), messages (non-empty), and expected (one of the three kinds).
export function parseCharterCases(json: string): CharterCase[] {
  let root: unknown
  try {
    root = JSON.parse(json)
  } catch (err) {
    throw new Error(`charter eval file is not JSON: ${messageOf(err)}`)
  }
  const list = isRecord(root) ? root.cases : undefined
  if (!Array.isArray(list) || list.length === 0) throw new Error('charter eval file has no "cases" list')
  if (list.length > MAX_CASES) throw new Error(`charter eval file has more than ${MAX_CASES} cases`)

  const seen = new Set<string>()
  return list.map((raw, index): CharterCase => {
    if (!isRecord(raw)) throw new Error(`charter eval case #${index}: not an object`)
    const id = textOf(raw.id, `#${index}`, 'id')
    if (seen.has(id)) fail(id, 'duplicate id')
    seen.add(id)

    let charter: CharterCase['charter'] = null
    if (raw.charter !== null) {
      if (!isRecord(raw.charter)) fail(id, 'charter must be null or an object')
      charter = {
        goal: textOf(raw.charter.goal, id, 'charter.goal'),
        inScope: stringsOf(raw.charter.inScope, id, 'charter.inScope'),
        outOfScope: stringsOf(raw.charter.outOfScope, id, 'charter.outOfScope'),
        request: textOf(raw.charter.request, id, 'charter.request'),
      }
    }

    const messages = stringsOf(raw.messages, id, 'messages')
    if (messages.length === 0) fail(id, 'messages must not be empty')
    if (!CHARTER_KINDS.includes(raw.expected as CharterKind)) fail(id, 'expected must be new-task, amendment or chit-chat')
    return { id, charter, messages, expected: raw.expected as CharterKind }
  })
}

type Classified = { got: CharterColumn; reason: string; inputTokens: number; outputTokens: number }

// One case through the production charter prompt and parser (FR-EV-3). The model's own kind is scored: no rev-0 rule, no
// state, no stats. Never throws, so one case cannot end the run.
async function classifyCase($: JudgeDollar, cfg: Config, c: CharterCase): Promise<Classified> {
  try {
    const charter = charterOfCase(`eval-${c.id}`, c.charter, c.messages)
    const outcome = await callModel($, {
      model: cfg.model,
      instructions: CHARTER_INSTRUCTIONS,
      body: askBody(charter),
      maxTokens: CHARTER_MAX_TOKENS,
      deadlineMs: EVAL_DEADLINE_MS,
    })
    const tokens = { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens }
    if (!outcome.ok) return { got: 'unchecked', reason: `model ${outcome.reason}`, ...tokens }
    const reply = parseReply(outcome.text)
    if (reply === null) return { got: 'unchecked', reason: 'invalid reply', ...tokens }
    return { got: reply.kind, reason: '', ...tokens }
  } catch (err) {
    $.ui.log(`stayontarget: charter eval case ${c.id} failed: ${messageOf(err)}`, { to: 'debug' })
    return { got: 'unchecked', reason: 'internal error', inputTokens: 0, outputTokens: 0 }
  }
}

// Runs the charter cases in batches of CONCURRENCY, as runEval does (FR-VD-6). A signal aborted between batches stops the
// run with the cases so far reported. Never throws.
export async function runCharterEval(
  $: JudgeDollar,
  cfg: Config,
  cases: CharterCase[],
  signal?: AbortSignal,
): Promise<CharterEvalReport> {
  const started = await $.clock.now()
  const judged: Classified[] = []
  for (let i = 0; i < cases.length && signal?.aborted !== true; i += CONCURRENCY) {
    const batch = cases.slice(i, i + CONCURRENCY)
    judged.push(...(await Promise.all(batch.map(c => classifyCase($, cfg, c)))))
  }
  const elapsedMs = (await $.clock.now()) - started

  const matrix = Object.fromEntries(
    CHARTER_KINDS.map(expected => [expected, Object.fromEntries(CHARTER_COLUMNS.map(got => [got, 0]))]),
  ) as CharterEvalReport['matrix']
  const cells = judged.map((result, index) => {
    const c = cases[index] as CharterCase
    matrix[c.expected][result.got] += 1
    return { id: c.id, expected: c.expected, got: result.got, reason: result.reason }
  })

  const precision = {} as CharterEvalReport['precision']
  const recall = {} as CharterEvalReport['recall']
  for (const kind of CHARTER_KINDS) {
    const predicted = cells.filter(x => x.got === kind).length
    const correct = cells.filter(x => x.got === kind && x.expected === kind).length
    const expected = cells.filter(x => x.expected === kind).length
    precision[kind] = predicted === 0 ? null : correct / predicted
    recall[kind] = expected === 0 ? null : correct / expected
  }

  const correct = cells.filter(x => x.got === x.expected).length
  return {
    cases: cells,
    matrix,
    precision,
    recall,
    accuracy: cells.length === 0 ? 0 : correct / cells.length,
    unchecked: cells.filter(x => x.got === 'unchecked').length,
    inputTokens: judged.reduce((sum, j) => sum + j.inputTokens, 0),
    outputTokens: judged.reduce((sum, j) => sum + j.outputTokens, 0),
    elapsedMs,
    total: cases.length,
  }
}

// The charter report as a section of Markdown: the summary, the matrix with an unchecked column, precision and recall per
// kind, then every mismatch with the kind the reply gave.
export function formatCharterReport(r: CharterEvalReport): string {
  const lines = [
    '## Charter classification',
    '',
    `Cases: ${r.cases.length} · accuracy ${percent(r.accuracy)} · unchecked ${r.unchecked} · ` +
      `tokens in ${r.inputTokens} / out ${r.outputTokens} · elapsed ${r.elapsedMs} ms`,
    ...(r.cases.length < r.total ? [`Stopped early: ${r.cases.length} of ${r.total} cases ran.`] : []),
    '',
    '### Matrix (rows: expected, columns: got)',
    '',
    `| expected | ${CHARTER_COLUMNS.join(' | ')} |`,
    `|---|${CHARTER_COLUMNS.map(() => '---').join('|')}|`,
    ...CHARTER_KINDS.map(
      expected => `| ${expected} | ${CHARTER_COLUMNS.map(got => r.matrix[expected][got]).join(' | ')} |`,
    ),
    '',
    '### Precision and recall',
    '',
    '| kind | precision | recall |',
    '|---|---|---|',
    ...CHARTER_KINDS.map(kind => `| ${kind} | ${percent(r.precision[kind])} | ${percent(r.recall[kind])} |`),
    '',
    '### Mismatches',
    '',
  ]
  const mismatches = r.cases.filter(c => c.got !== c.expected)
  if (mismatches.length === 0) lines.push('None.')
  for (const c of mismatches) {
    const detail = c.got === 'unchecked' ? ` (${c.reason})` : ''
    lines.push(`- ${c.id}: expected ${c.expected}, got ${c.got}${detail}`)
  }
  return lines.join('\n')
}
