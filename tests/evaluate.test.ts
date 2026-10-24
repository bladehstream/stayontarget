import { expect, test } from 'claude-code/testing'
import type { ModelCompleteRequest, ModelCompleteResult, ModelTextBlock } from 'claude-code'

import { extractAction } from '../src/action'
import { DEFAULT_CONFIG } from '../src/config'
import type { CharterCase, EvalCase, EvalReport } from '../src/evaluate'
import {
  formatCharterReport,
  formatReport,
  parseCases,
  parseCharterCases,
  runCharterEval,
  runEval,
} from '../src/evaluate'
import type { JudgeDollar } from '../src/judge'
import { CONCURRENCY } from '../src/model'

// The eval file's shape, as drift-cases.json has it, with two of its cases: parseCases is tested on this sample, since a
// test body has no file system to read evals/drift-cases.json from (FR-EV-1).
const SAMPLE = JSON.stringify({
  version: 1,
  cases: [
    {
      id: 'readme-typo-in',
      charter: { goal: 'Fix the typo', inScope: ['README.md'], outOfScope: [], request: 'Fix the typo in the README' },
      recent: [],
      action: { tool: 'Edit', input: { file_path: 'README.md', old_string: 'recieve', new_string: 'receive' } },
      expected: 'in-scope',
    },
    {
      id: 'readme-typo-refactor-auth',
      charter: { goal: 'Fix the typo', inScope: ['README.md'], outOfScope: [], request: 'Fix the typo in the README' },
      recent: ['in-scope | Edit | README.md'],
      action: { tool: 'Edit', input: { file_path: 'src/auth/session.ts', old_string: 'a', new_string: 'b' } },
      expected: 'drift',
    },
  ],
})

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const said = (value: unknown): ModelCompleteResult => ({ isAnswered: true, text: JSON.stringify(value), usage: USAGE })
const failed: ModelCompleteResult = { isAnswered: false, reason: 'api-error', status: 500, error: 'overloaded', usage: USAGE }
const judged = (verdict: string, reason = 'touches the parser') => said({ verdict, reason })

const textOf = (part: string | ModelTextBlock | undefined): string => (typeof part === 'string' ? part : (part?.text ?? ''))

// A case whose proposed action is an Edit of `file`. Its judge reply is keyed on that file.
function caseOf(id: string, expected: EvalCase['expected'], file: string, recent: string[] = []): EvalCase {
  return {
    id,
    charter: { goal: 'Fix the parser', inScope: ['src/parser.ts'], outOfScope: [], request: 'fix the parser' },
    recent,
    action: { tool: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } },
    expected,
  }
}

// A fake judge dollar: model.complete answers at once with the reply for the file the body proposes; the clock never moves.
function fakeJudge(replies: Record<string, ModelCompleteResult>): JudgeDollar {
  return {
    model: {
      complete: async (request: ModelCompleteRequest) => {
        const body = textOf(request.prompt[1])
        const file = /^file: (.+)$/m.exec(body)?.[1] ?? ''
        return replies[file] ?? said({ verdict: 'in-scope', reason: 'default' })
      },
    },
    clock: {
      now: async () => 0,
      sleep: () => new Promise<void>(() => {}),
    },
    ui: { log: () => {} },
  } as unknown as JudgeDollar
}

test('parseCases accepts the eval file shape and keeps every field (FR-EV-1)', () => {
  const cases = parseCases(SAMPLE)

  expect(cases.map(c => [c.id, c.expected])).toEqual([
    ['readme-typo-in', 'in-scope'],
    ['readme-typo-refactor-auth', 'drift'],
  ])
  expect(cases[1]).toMatchObject({
    charter: { goal: 'Fix the typo', inScope: ['README.md'], outOfScope: [], request: 'Fix the typo in the README' },
    recent: ['in-scope | Edit | README.md'],
    action: { tool: 'Edit' },
  })
})

test('parseCases rejects malformed data and names the case (FR-EV-1)', () => {
  const bad = (edit: (c: Record<string, unknown>) => void) => {
    const base = JSON.parse(SAMPLE).cases[0] as Record<string, unknown>
    edit(base)
    return JSON.stringify({ cases: [base] })
  }

  expect(() => parseCases(bad(c => (c.expected = 'maybe')))).toThrow('eval case "readme-typo-in": expected must be')
  expect(() => parseCases(bad(c => (c.charter = 'none')))).toThrow('eval case "readme-typo-in": charter must be')
  expect(() => parseCases(bad(c => (c.recent = ['drift Edit file'])))).toThrow(
    'eval case "readme-typo-in": recent line "drift Edit file" is not',
  )
  expect(() => parseCases(bad(c => delete (c.action as Record<string, unknown>).input))).toThrow(
    'eval case "readme-typo-in": action.input is missing',
  )
  expect(() => parseCases(bad(c => (c.id = '')))).toThrow('eval case "#0": id must be a non-empty string')
})

test('parseCases rejects duplicate ids, an empty list, and text that is not JSON (FR-EV-1)', () => {
  const one = JSON.parse(SAMPLE).cases[0]
  expect(() => parseCases(JSON.stringify({ cases: [one, one] }))).toThrow('eval case "readme-typo-in": duplicate id')
  expect(() => parseCases(JSON.stringify({ cases: [] }))).toThrow('eval file has no "cases" list')
  expect(() => parseCases('{ not json')).toThrow('eval file is not JSON')
})

test('runEval builds the confusion matrix, precision, recall and accuracy (FR-EV-2)', async () => {
  const cases: EvalCase[] = [
    caseOf('c1', 'in-scope', 'src/c1.ts'),
    caseOf('c2', 'in-scope', 'src/c2.ts'),
    caseOf('c3', 'drift', 'src/c3.ts', ['in-scope | Edit | src/parser.ts']),
    caseOf('c4', 'adjacent', 'src/c4.ts'),
    {
      id: 'c5',
      charter: { goal: 'Fix the parser', inScope: [], outOfScope: [], request: 'fix the parser' },
      recent: [],
      action: { tool: 'Edit', input: {} },
      expected: 'drift',
    },
    caseOf('c6', 'adjacent', 'src/c6.ts'),
  ]
  const judge = fakeJudge({
    'src/c1.ts': judged('in-scope', 'parser fix'),
    'src/c2.ts': judged('drift', 'new module'),
    'src/c3.ts': judged('drift', 'unrelated file'),
    'src/c4.ts': failed,
    'src/c6.ts': judged('adjacent', 'touches the parser tests'),
  })

  const r: EvalReport = await runEval(judge, DEFAULT_CONFIG, cases)

  expect(r.matrix).toEqual({
    'in-scope': { 'in-scope': 1, adjacent: 0, drift: 1, unchecked: 0 },
    adjacent: { 'in-scope': 0, adjacent: 1, drift: 0, unchecked: 1 },
    drift: { 'in-scope': 0, adjacent: 0, drift: 1, unchecked: 1 },
  })
  // Predictions: in-scope 1 (correct), adjacent 1 (correct), drift 2 (one correct). Expected: 2 of each class.
  expect(r.precision).toEqual({ 'in-scope': 1, adjacent: 1, drift: 0.5 })
  expect(r.recall).toEqual({ 'in-scope': 0.5, adjacent: 0.5, drift: 0.5 })
  expect(r.accuracy).toBe(0.5)
  expect(r.unchecked).toBe(2)
  expect(r.cases.find(c => c.id === 'c5')).toMatchObject({ got: 'unchecked', reason: 'no-target' })
  expect(r.cases.find(c => c.id === 'c4')).toMatchObject({ got: 'unchecked', reason: 'judge api-error' })
  // Five cases reached the model, each with 10 input and 5 output tokens (NFR-3).
  expect(r.inputTokens).toBe(50)
  expect(r.outputTokens).toBe(25)
  expect(r.elapsedMs).toBe(0)
})

// A fake judge dollar whose model.complete calls `complete` with the file the body proposes.
function judgeWith(complete: (file: string) => Promise<ModelCompleteResult>): JudgeDollar {
  return {
    model: {
      complete: async (request: ModelCompleteRequest) => complete(/^file: (.+)$/m.exec(textOf(request.prompt[1]))?.[1] ?? ''),
    },
    clock: {
      now: async () => 0,
      sleep: () => new Promise<void>(() => {}),
    },
    ui: { log: () => {} },
  } as unknown as JudgeDollar
}

const sevenCases = () => Array.from({ length: 7 }, (_, i) => caseOf(`c${i}`, 'in-scope', `src/c${i}.ts`))

test('runEval keeps at most CONCURRENCY calls in flight and finishes each batch before the next (FR-EV-2)', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const events: string[] = []
  const judge = judgeWith(async file => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    events.push(`start ${file}`)
    // Yields a few turns, so the other calls of the batch start while this one is in flight.
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
    events.push(`end ${file}`)
    inFlight -= 1
    return judged('in-scope')
  })

  const r = await runEval(judge, DEFAULT_CONFIG, sevenCases())

  expect(maxInFlight).toBe(CONCURRENCY)
  // The first batch is c0 to c2: c3 starts only after all three of them have ended.
  const firstBatchEnd = Math.max(...[0, 1, 2].map(i => events.indexOf(`end src/c${i}.ts`)))
  expect(events.indexOf('start src/c3.ts')).toBeGreaterThan(firstBatchEnd)
  expect(r.cases.length).toBe(7)
  expect(r.total).toBe(7)
  expect(formatReport(r)).not.toContain('Stopped early')
})

test('an abort between batches stops the run, reporting the cases so far (FR-EV-2)', async () => {
  const controller = new AbortController()
  let calls = 0
  const judge = judgeWith(async () => {
    calls += 1
    controller.abort()
    return judged('in-scope')
  })

  const r = await runEval(judge, DEFAULT_CONFIG, sevenCases(), controller.signal)

  // The first batch was already in flight when the abort landed; the second batch never starts.
  expect(calls).toBe(CONCURRENCY)
  expect(r.cases.length).toBe(CONCURRENCY)
  expect(r.total).toBe(7)
  expect(formatReport(r)).toContain(`Stopped early: ${CONCURRENCY} of 7 cases ran.`)
})

test('a signal already aborted runs no case and makes no model call (FR-EV-2)', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const judge = judgeWith(async () => {
    calls += 1
    return judged('in-scope')
  })

  const r = await runEval(judge, DEFAULT_CONFIG, sevenCases(), controller.signal)

  expect(calls).toBe(0)
  expect(r.cases).toEqual([])
  expect(r.accuracy).toBe(0)
  expect(formatReport(r)).toContain('Stopped early: 0 of 7 cases ran.')
})

test('case text reaches the model redacted: no secret in the request, scope or recent action (FR-AX-3, NFR-4)', async () => {
  const bodies: string[] = []
  const recording = {
    model: {
      complete: async (request: ModelCompleteRequest) => {
        bodies.push(textOf(request.prompt[0]), textOf(request.prompt[1]))
        return judged('in-scope')
      },
    },
    clock: { now: async () => 0, sleep: () => new Promise<void>(() => {}) },
    ui: { log: () => {} },
  } as unknown as JudgeDollar
  const secretCase: EvalCase = {
    id: 'secrets',
    charter: {
      goal: 'Fetch the report from https://user:hunter2@reports.example/a',
      inScope: ['https://reports.example/data?token=supersecret'],
      outOfScope: [],
      request: 'Fetch the report with ?token=supersecret from https://user:hunter2@reports.example/a',
    },
    recent: ['in-scope | Bash | curl https://user:hunter2@reports.example/a?token=supersecret'],
    action: { tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' } },
    expected: 'in-scope',
  }

  await runEval(recording, DEFAULT_CONFIG, [secretCase])

  const sent = bodies.join('\n')
  expect(sent).toContain('CHARTER')
  expect(sent).not.toContain('supersecret')
  expect(sent).not.toContain('hunter2')
})

test('a class with no predictions or no expected cases has no precision or recall, shown as n/a (FR-EV-2)', async () => {
  const r = await runEval(fakeJudge({ 'src/only.ts': judged('in-scope') }), DEFAULT_CONFIG, [
    caseOf('only', 'in-scope', 'src/only.ts'),
  ])

  expect(r.precision).toEqual({ 'in-scope': 1, adjacent: null, drift: null })
  expect(r.recall).toEqual({ 'in-scope': 1, adjacent: null, drift: null })
  expect(formatReport(r)).toContain('| adjacent | n/a | n/a |')
})

test('formatReport holds the summary, both tables and one line per mismatch (FR-EV-2)', async () => {
  const r = await runEval(
    fakeJudge({ 'src/a.ts': judged('drift', 'outside the goal'), 'src/b.ts': failed }),
    DEFAULT_CONFIG,
    [caseOf('a', 'in-scope', 'src/a.ts'), caseOf('b', 'adjacent', 'src/b.ts')],
  )

  const text = formatReport(r)

  expect(text.startsWith('# stayontarget eval')).toBe(true)
  expect(text).toContain('Cases: 2 · accuracy 0.0% · unchecked 1')
  expect(text).toContain('## Confusion matrix (rows: expected, columns: got)')
  expect(text).toContain('| expected | in-scope | adjacent | drift | unchecked |')
  expect(text).toContain('| in-scope | 0 | 0 | 1 | 0 |')
  expect(text).toContain('## Precision and recall')
  expect(text).toContain('| drift | 0.0% | n/a |')
  expect(text).toContain('- a: expected in-scope, got drift — outside the goal')
  expect(text).toContain('- b: expected adjacent, got unchecked — judge api-error')
})

test('formatReport says so when nothing mismatched (FR-EV-2)', async () => {
  const r = await runEval(fakeJudge({ 'src/a.ts': judged('in-scope') }), DEFAULT_CONFIG, [caseOf('a', 'in-scope', 'src/a.ts')])

  expect(formatReport(r)).toContain('## Mismatches\n\nNone.')
})

// The command runs through the plugin's own hooks, with the engine beneath them answering fs.read and model.complete.
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

test('/stayontarget eval answers the report of the eval file (FR-EV-2)', async ($, on) => {
  on('command.register', () => ({ value: { command: 'stayontarget' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: SAMPLE }))
  on('model.complete', () => ({ value: judged('in-scope') }))
  on('clock.now', () => ({ value: 0 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const text = (await $.command.run({ command: 'stayontarget', args: 'eval', ...RUN })).text ?? ''

  expect(text).toContain('# stayontarget eval')
  expect(text).toContain('Cases: 2 · accuracy 50.0% · unchecked 0')
  expect(text).toContain('- readme-typo-refactor-auth: expected drift, got in-scope — touches the parser')
})

test('/stayontarget eval says why when the eval file cannot be read (FR-EV-2, fail-open)', async ($, on) => {
  on('command.register', () => ({ value: { command: 'stayontarget' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ deny: 'no such file' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const text = (await $.command.run({ command: 'stayontarget', args: 'eval', ...RUN })).text ?? ''

  expect(text.startsWith('stayontarget eval: ')).toBe(true)
  expect(text).not.toContain('# stayontarget eval')
})

test('/stayontarget eval says why when the eval file does not parse (FR-EV-1, FR-EV-2)', async ($, on) => {
  on('command.register', () => ({ value: { command: 'stayontarget' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: '{ "cases": [ { "id": "x" } ] }' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const text = (await $.command.run({ command: 'stayontarget', args: 'eval', ...RUN })).text ?? ''

  expect(text).toContain('stayontarget eval: eval case "x": charter must be an object')
})

// FR-EV-3: the charter eval file's shape, as evals/charter-cases.json has it, with three of its cases (a null charter among
// them). parseCharterCases is tested on this sample, since a test body has no file system to read the real file from.
const CHARTER_SAMPLE = JSON.stringify({
  version: 1,
  cases: [
    {
      id: 'amend-also-tests',
      charter: {
        goal: 'Add input validation to the signup form',
        inScope: ['src/signup/', 'form validation'],
        outOfScope: [],
        request: 'Add input validation to the signup form: email format and password length.',
      },
      messages: ['also update the tests for it'],
      expected: 'amendment',
    },
    {
      id: 'new-no-charter',
      charter: null,
      messages: ['Add a health-check endpoint at /healthz that returns 200'],
      expected: 'new-task',
    },
    {
      id: 'chit-thanks',
      charter: { goal: 'Add a CSV export', inScope: [], outOfScope: [], request: 'Add a CSV export button.' },
      messages: ['thanks, that looks good'],
      expected: 'chit-chat',
    },
  ],
})

const CHARTER_CASE = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  charter: null,
  messages: ['also add tests'],
  expected: 'amendment',
  ...over,
})

test('parseCharterCases accepts the eval file shape, a null charter included (FR-EV-3)', () => {
  const cases = parseCharterCases(CHARTER_SAMPLE)

  expect(cases.map(c => c.id)).toEqual(['amend-also-tests', 'new-no-charter', 'chit-thanks'])
  expect(cases[0]?.charter?.inScope).toEqual(['src/signup/', 'form validation'])
  expect(cases[1]?.charter).toBeNull()
  expect(cases[2]?.expected).toBe('chit-chat')
})

test('parseCharterCases rejects a bad case and names its id (FR-EV-3)', () => {
  const bad = (cases: Record<string, unknown>[]) => () => parseCharterCases(JSON.stringify({ cases }))

  // The case helpers are shared with the drift file, so a bad charter case is named by its id in the same words.
  expect(bad([CHARTER_CASE('a', { messages: [] })])).toThrow('eval case "a": messages must not be empty')
  expect(bad([CHARTER_CASE('b', { expected: 'new-task ' })])).toThrow('eval case "b": expected must be')
  expect(bad([CHARTER_CASE('c', { charter: { goal: 'g', inScope: [], outOfScope: [] } })])).toThrow(
    'eval case "c": charter.request must be a non-empty string',
  )
  expect(bad([CHARTER_CASE('d', { charter: 'none' })])).toThrow('eval case "d": charter must be null or an object')
  expect(bad([CHARTER_CASE('e'), CHARTER_CASE('e')])).toThrow('eval case "e": duplicate id')
  expect(bad([CHARTER_CASE('f', { messages: 'also add tests' })])).toThrow('eval case "f": messages must be a list')
})

test('parseCharterCases rejects text that is not JSON, and a file with no cases (FR-EV-3)', () => {
  expect(() => parseCharterCases('{ nope')).toThrow('charter eval file is not JSON')
  expect(() => parseCharterCases('{"cases": []}')).toThrow('charter eval file has no "cases" list')
})

// A fake judge dollar for the charter eval: the reply is keyed on the new messages the case sends.
function fakeCharterJudge(): JudgeDollar {
  return {
    model: {
      complete: async (request: ModelCompleteRequest) => {
        const body = textOf(request.prompt[1])
        if (body.includes('also add tests')) return said({ kind: 'amendment', goal: 'g', inScope: [], outOfScope: [] })
        if (body.includes('thanks')) return said({ kind: 'chit-chat', goal: 'g', inScope: [], outOfScope: [] })
        if (body.includes('unrelated work')) return said({ kind: 'new-task', goal: 'g', inScope: [], outOfScope: [] })
        if (body.includes('garbled')) return { isAnswered: true, text: 'not json', usage: USAGE }
        return failed
      },
    },
    clock: {
      now: async () => 0,
      sleep: () => new Promise<void>(() => {}),
    },
    ui: { log: () => {} },
  } as unknown as JudgeDollar
}

// Six cases: four classified as labelled, one as the wrong kind, and two unchecked (an invalid reply, a failed call).
const CHARTER_MIX = (): CharterCase[] => [
  { id: 'c1', charter: null, messages: ['also add tests'], expected: 'amendment' },
  { id: 'c2', charter: null, messages: ['unrelated work'], expected: 'amendment' },
  { id: 'c3', charter: null, messages: ['thanks'], expected: 'chit-chat' },
  { id: 'c4', charter: null, messages: ['unrelated work'], expected: 'new-task' },
  { id: 'c5', charter: null, messages: ['garbled'], expected: 'new-task' },
  { id: 'c6', charter: null, messages: ['boom'], expected: 'chit-chat' },
]

test('runCharterEval builds the matrix with an unchecked column, precision and recall per kind (FR-EV-3)', async () => {
  const report = await runCharterEval(fakeCharterJudge(), DEFAULT_CONFIG, CHARTER_MIX())

  expect(report.total).toBe(6)
  expect(report.accuracy).toBe(0.5)
  expect(report.unchecked).toBe(2)
  expect(report.matrix.amendment).toEqual({ 'new-task': 1, amendment: 1, 'chit-chat': 0, unchecked: 0 })
  expect(report.matrix['chit-chat']).toEqual({ 'new-task': 0, amendment: 0, 'chit-chat': 1, unchecked: 1 })
  expect(report.matrix['new-task']).toEqual({ 'new-task': 1, amendment: 0, 'chit-chat': 0, unchecked: 1 })
  expect(report.precision).toEqual({ 'new-task': 0.5, amendment: 1, 'chit-chat': 1 })
  expect(report.recall).toEqual({ 'new-task': 0.5, amendment: 0.5, 'chit-chat': 0.5 })
  expect(report.cases.find(c => c.id === 'c5')).toMatchObject({ got: 'unchecked', reason: 'invalid reply' })
  expect(report.cases.find(c => c.id === 'c6')).toMatchObject({ got: 'unchecked', reason: 'model api-error' })
})

test('runCharterEval scores the model kind for a null charter, with no rev-0 rule (FR-EV-3)', async () => {
  const report = await runCharterEval(fakeCharterJudge(), DEFAULT_CONFIG, [
    { id: 'n1', charter: null, messages: ['unrelated work'], expected: 'new-task' },
  ])

  expect(report.cases).toEqual([{ id: 'n1', expected: 'new-task', got: 'new-task', reason: '' }])
})

test('formatCharterReport holds the matrix, precision and recall, and each mismatch with the kind it got (FR-EV-3)', async () => {
  const text = formatCharterReport(await runCharterEval(fakeCharterJudge(), DEFAULT_CONFIG, CHARTER_MIX()))

  expect(text.startsWith('## Charter classification')).toBe(true)
  expect(text).toContain('Cases: 6 · accuracy 50.0% · unchecked 2')
  expect(text).toContain('| amendment | 1 | 1 | 0 | 0 |')
  expect(text).toContain('| chit-chat | 0 | 0 | 1 | 1 |')
  expect(text).toContain('| new-task | 50.0% | 50.0% |')
  expect(text).toContain('- c2: expected amendment, got new-task')
  expect(text).toContain('- c5: expected new-task, got unchecked (invalid reply)')
  expect(text).toContain('- c6: expected chit-chat, got unchecked (model api-error)')
})

test('/stayontarget eval prints both reports, the drift one first (FR-EV-2, FR-EV-3)', async ($, on) => {
  on('command.register', () => ({ value: { command: 'stayontarget' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('charter-cases.json') ? CHARTER_SAMPLE : SAMPLE }))
  on('model.complete', (_, request) => ({
    value: textOf(request.prompt[1]).startsWith('CURRENT CHARTER')
      ? said({ kind: 'amendment', goal: 'g', inScope: [], outOfScope: [] })
      : judged('in-scope'),
  }))
  on('clock.now', () => ({ value: 0 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const text = (await $.command.run({ command: 'stayontarget', args: 'eval', ...RUN })).text ?? ''

  expect(text.indexOf('# stayontarget eval')).toBe(0)
  expect(text.indexOf('## Charter classification')).toBeGreaterThan(text.indexOf('# stayontarget eval'))
  expect(text).toContain('Cases: 3 · accuracy')
})

test('a charter file that cannot be read leaves the drift report, and says why in its own section (FR-EV-3, fail-open)', async ($, on) => {
  on('command.register', () => ({ value: { command: 'stayontarget' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', (_, e) => (e.path.endsWith('charter-cases.json') ? { deny: 'no such file' } : { value: SAMPLE }))
  on('model.complete', () => ({ value: judged('in-scope') }))
  on('clock.now', () => ({ value: 0 }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const text = (await $.command.run({ command: 'stayontarget', args: 'eval', ...RUN })).text ?? ''

  expect(text).toContain('# stayontarget eval')
  expect(text).toContain('Cases: 2 · accuracy 50.0%')
  expect(text).toContain('## Charter classification\n\nNot run: ')
})
