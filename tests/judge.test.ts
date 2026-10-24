import { expect, test } from 'claude-code/testing'
import type { ModelCompleteResult, ModelTextBlock } from 'claude-code'

import type { Allowance, Charter, DriftEvent } from '../types'
import { extractAction } from '../src/action'
import type { Action } from '../src/action'
import type { CharterDollar } from '../src/charter'
import { DEFAULT_CONFIG } from '../src/config'
import { buildJudgeBody, clearVerdictCache, decide } from '../src/judge'
import { JUDGE_INSTRUCTIONS } from '../src/prompts'
import { allowancesAtom, charterAtom, eventsAtom, statsAtom } from '../src/state'
import { world } from './fake'
import type { World } from './fake'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const cfg = DEFAULT_CONFIG

const said = (value: unknown): ModelCompleteResult => ({ isAnswered: true, text: JSON.stringify(value), usage: USAGE })
const ABORTED: ModelCompleteResult = { isAnswered: false, reason: 'aborted', usage: USAGE }
const judged = (verdict: string, reason = 'touches the parser') => said({ verdict, reason })
const newTask = (goal: string, inScope: string[]) => ({ kind: 'new-task', goal, inScope, outOfScope: [] })
// The text of one part of a request's prompt.
const textOf = (part: string | ModelTextBlock | undefined): string => (typeof part === 'string' ? part : (part?.text ?? ''))

// A distilled charter with nothing pending, so a decision makes no charter call of its own.
function charter(overrides: Partial<Charter> = {}): Charter {
  return {
    id: 'c1',
    rev: 2,
    request: 'fix the parser',
    goal: 'fix the parser',
    inScope: ['src/parser.ts'],
    outOfScope: [],
    distilled: true,
    editedFields: [],
    pendingText: [],
    createdAt: 0,
    ...overrides,
  }
}

// An Edit of src/parser.ts whose new text is `next`: a different `next` is a different change to the same file.
function edit(next: string): Action {
  return extractAction('Edit', { file_path: 'C:\\repo\\src\\parser.ts', old_string: 'a', new_string: next }, 'C:\\repo')
}

function event(id: string, charterId: string, target: string): DriftEvent {
  return {
    id,
    toolUseId: `t-${id}`,
    charterId,
    charterRev: 1,
    mainTurnId: null,
    agentId: null,
    tool: 'Bash',
    target,
    verdict: 'drift',
    reason: 'r',
    excerpt: '',
    cwd: null,
    source: 'judge',
    action: 'note',
    status: 'open',
    at: 0,
  }
}

function seeded(w: World, value: Charter | null = charter()) {
  w.seed(charterAtom.ref, value)
}

test('an unsupported action is unchecked as no-target, with no charter read and no model call (FR-VD-3)', async () => {
  const w = world()
  clearVerdictCache()
  const action = extractAction('Edit', {}, null)

  expect(await decide(w.$, cfg, action, 0)).toEqual({
    verdict: 'unchecked',
    reason: 'no-target',
    source: 'none',
    charterHead: null,
    charterId: null,
    charterRev: 0,
  })
  expect(w.requests.length).toBe(0)
})

test('with no charter the action is unchecked as no-charter, with no model call (FR-VD-3)', async () => {
  const w = world()
  clearVerdictCache()

  expect(await decide(w.$, cfg, edit('x'), 0)).toEqual({
    verdict: 'unchecked',
    reason: 'no-charter',
    source: 'none',
    charterHead: null,
    charterId: null,
    charterRev: 0,
  })
  expect(w.requests.length).toBe(0)
})

test('a judged action carries the charter and its rev, and counts its tokens (FR-VD-3, NFR-3)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('in-scope'))

  expect(await pending).toEqual({
    verdict: 'in-scope',
    reason: 'touches the parser',
    source: 'judge',
    charterHead: 'fix the parser',
    charterId: 'c1',
    charterRev: 2,
  })
  expect(w.stats()).toMatchObject({ judged: 1, unchecked: 0, inputTokens: 10, outputTokens: 5 })
  expect(w.requests[0]?.maxTokens).toBe(200)
  expect(w.requests[0]?.model).toBe('haiku')
  expect(textOf(w.requests[0]?.prompt[0])).toBe(JUDGE_INSTRUCTIONS)
})

test('a reason with newlines is one line in the decision (FR-UI-6)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('drift', 'first\nsecond   line'))

  expect((await pending).reason).toBe('first second line')
})

test('an allowance for the same charter, tool and target is in-scope and beats the cache (FR-VD-3)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const first = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('drift'))
  await first

  const allowance: Allowance = { charterId: 'c1', tool: 'Edit', target: 'src/parser.ts', at: 0 }
  w.seed(allowancesAtom.ref, [allowance])
  expect(await decide(w.$, cfg, edit('x'), 0)).toEqual({
    verdict: 'in-scope',
    reason: 'allowed by you',
    source: 'allowance',
    charterHead: 'fix the parser',
    charterId: 'c1',
    charterRev: 2,
  })
  expect(w.requests.length).toBe(1)
  expect(w.stats()).toMatchObject({ allowanceHits: 1, cacheHits: 0 })
})

test('an allowance applies only to its own charter, tool and target (FR-VD-3)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)
  w.seed(allowancesAtom.ref, [
    { charterId: 'other', tool: 'Edit', target: 'src/parser.ts', at: 0 },
    { charterId: 'c1', tool: 'Write', target: 'src/parser.ts', at: 0 },
    { charterId: 'c1', tool: 'Edit', target: 'src/lexer.ts', at: 0 },
  ] satisfies Allowance[])

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('adjacent'))

  expect(await pending).toMatchObject({ verdict: 'adjacent', source: 'judge' })
  expect(w.stats().allowanceHits).toBe(0)
})

test('a repeated action is answered from the cache without a model call (FR-VD-3)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const first = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('adjacent', 'nearby fix'))
  await first

  expect(await decide(w.$, cfg, edit('x'), 0)).toEqual({
    verdict: 'adjacent',
    reason: 'nearby fix',
    source: 'cache',
    charterHead: 'fix the parser',
    charterId: 'c1',
    charterRev: 2,
  })
  expect(w.requests.length).toBe(1)
  expect(w.stats()).toMatchObject({ judged: 1, cacheHits: 1 })
})

test('the same file with a different change is judged again (FR-VD-3)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const first = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('in-scope'))
  await first

  const second = decide(w.$, cfg, edit('y'), 0)
  await w.answer(judged('drift'))

  expect(await second).toMatchObject({ verdict: 'drift', source: 'judge' })
  expect(w.requests.length).toBe(2)
  expect(textOf(w.requests[1]?.prompt[1])).toContain('new:\ny')
  expect(w.stats()).toMatchObject({ judged: 2, cacheHits: 0 })
})

test('a parallel identical action shares the one judge call in flight (NFR-3, NFR-5)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const first = decide(w.$, cfg, edit('x'), 0)
  const second = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('in-scope'))

  expect(await first).toMatchObject({ verdict: 'in-scope', source: 'judge' })
  expect(await second).toMatchObject({ verdict: 'in-scope', reason: 'touches the parser' })
  expect(w.requests.length).toBe(1)
  expect(w.stats().judged + w.stats().cacheHits).toBe(2)
})

test('a second caller that misses the cache while the first judge settles gets the verdict with no second call (NFR-3, NFR-5)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const first = decide(w.$, cfg, edit('x'), 0)
  await w.dispatched()
  // The second caller's clock reads, in order: decide's start, ensureCharter's start, then the budget read after the
  // fingerprint, which is where it could have been overtaken before its lookups. The first judge settles at that read.
  w.interleaveAt(w.nowCalls() + 3, () => {
    void w.answer(judged('in-scope'))
  })
  const second = decide(w.$, cfg, edit('x'), 0)

  expect(await first).toMatchObject({ verdict: 'in-scope', source: 'judge' })
  expect(await second).toMatchObject({ verdict: 'in-scope', source: 'cache' })
  expect(w.requests.length).toBe(1)
  expect(w.stats()).toMatchObject({ judged: 1, cacheHits: 1 })
})

test('the verdict cache keeps 500 entries and evicts the oldest (FR-VD-3)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  for (let i = 0; i < 501; i++) {
    const pending = decide(w.$, cfg, edit(`change ${i}`), 0)
    await w.answer(judged('in-scope'))
    await pending
  }
  expect(w.requests.length).toBe(501)

  expect(await decide(w.$, cfg, edit('change 500'), 0)).toMatchObject({ source: 'cache' })
  expect(w.requests.length).toBe(501)

  const pending = decide(w.$, cfg, edit('change 0'), 0)
  await w.answer(judged('drift'))
  expect(await pending).toMatchObject({ verdict: 'drift', source: 'judge' })
  expect(w.requests.length).toBe(502)
})

test('clearVerdictCache forgets the cached verdicts (FR-VD-3)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const first = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('in-scope'))
  await first

  clearVerdictCache()
  const second = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('in-scope'))
  expect(await second).toMatchObject({ source: 'judge' })
  expect(w.requests.length).toBe(2)
})

test('an invalid reply is unchecked as invalid-reply and is not cached (FR-VD-5)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const first = decide(w.$, cfg, edit('x'), 0)
  await w.answer({ isAnswered: true, text: 'I think this is fine.', usage: USAGE })

  expect(await first).toEqual({
    verdict: 'unchecked',
    reason: 'judge invalid-reply',
    source: 'none',
    charterHead: 'fix the parser',
    charterId: 'c1',
    charterRev: 2,
  })
  expect(w.stats()).toMatchObject({ unchecked: 1, judged: 0, inputTokens: 10, outputTokens: 5 })

  const second = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('in-scope'))
  expect(await second).toMatchObject({ verdict: 'in-scope', source: 'judge' })
  expect(w.requests.length).toBe(2)
})

test('a reply needs a known verdict and a non-empty reason (FR-VD-5)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const unknown = decide(w.$, cfg, edit('x'), 0)
  await w.answer(said({ verdict: 'maybe', reason: 'unsure' }))
  expect(await unknown).toMatchObject({ verdict: 'unchecked', reason: 'judge invalid-reply' })

  const blank = decide(w.$, cfg, edit('y'), 0)
  await w.answer(said({ verdict: 'drift', reason: '   ' }))
  expect(await blank).toMatchObject({ verdict: 'unchecked', reason: 'judge invalid-reply' })
  expect(w.stats().unchecked).toBe(2)
})

test('a reason longer than 160 characters is cut to 160 (FR-VD-4)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('drift', 'x'.repeat(400)))

  expect((await pending).reason).toBe('x'.repeat(160))
})

test('a reason carrying a credential is redacted before it is kept (NFR-4)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('drift', 'writes token=s3cret123 into the file'))

  const { reason } = await pending
  expect(reason).not.toContain('s3cret123')
  expect(reason).toContain('«redacted»')
})

test('a model timeout is unchecked as timeout and is not cached (FR-VD-5, FR-VD-6)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const first = decide(w.$, cfg, edit('x'), 0)
  await w.dispatched()
  w.setNow(8000)
  await w.answer(ABORTED)

  expect(await first).toMatchObject({ verdict: 'unchecked', reason: 'judge timeout', source: 'none' })
  expect(w.stats()).toMatchObject({ unchecked: 1, inputTokens: 10 })

  const second = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('in-scope'))
  expect(await second).toMatchObject({ verdict: 'in-scope', source: 'judge' })
  expect(w.requests.length).toBe(2)
})

test('a model api error is unchecked with its reason and is not cached (FR-VD-5)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.answer({ isAnswered: false, reason: 'api-error', status: 500, error: 'overloaded', usage: USAGE })

  expect(await pending).toMatchObject({ verdict: 'unchecked', reason: 'judge api-error' })
  expect(w.stats().unchecked).toBe(1)
})

test('the request, both scope lists and the proposed action reach the judge body, with the exclusion stated (FR-VD-4)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w, charter({ outOfScope: ['the public API'] }))

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('drift'))
  await pending

  const [instructions, body] = w.requests[0]?.prompt ?? []
  expect(textOf(instructions)).toContain('An explicit exclusion always wins')
  expect(textOf(body)).toContain('inScope: src/parser.ts')
  expect(textOf(body)).toContain('outOfScope: the public API')
  expect(textOf(body)).toContain('request:\nfix the parser')
  expect(textOf(body)).toContain('PROPOSED ACTION\ntool: Edit')
})

test('the body lists the last eight events of this charter, oldest first, and "(none)" when there are none (FR-VD-4)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)
  const mine = Array.from({ length: 10 }, (_, i) => event(`e${i}`, 'c1', `src/file${i}.ts`))
  w.seed(eventsAtom.ref, [event('x', 'other', 'src/elsewhere.ts'), ...mine])

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('drift'))
  await pending

  const body = textOf(w.requests[0]?.prompt[1])
  expect(body).toContain(
    'RECENT ACTIONS (oldest first)\n' +
      Array.from({ length: 8 }, (_, i) => `drift | Bash | src/file${i + 2}.ts`).join('\n') +
      '\n\nPROPOSED ACTION',
  )
  expect(body).not.toContain('src/elsewhere.ts')
})

test('buildJudgeBody formats the charter, its placeholders and the proposed action (FR-VD-4)', () => {
  const action = edit('x')
  if (action.kind !== 'ok') throw new Error('expected a supported action')

  expect(buildJudgeBody(charter({ goal: null, inScope: [], request: 'short' }), [], action)).toBe(
    [
      'CHARTER',
      'goal: (not distilled)',
      'inScope: (none)',
      'outOfScope: (none)',
      'request:',
      'short',
      '',
      'RECENT ACTIONS (oldest first)',
      '(none)',
      '',
      'PROPOSED ACTION',
      action.judgeText,
    ].join('\n'),
  )
})

test('a request over 4,000 characters keeps its first 1,000 and last 2,900 around a marker (FR-VD-4)', () => {
  const action = edit('x')
  if (action.kind !== 'ok') throw new Error('expected a supported action')
  const request = `${'h'.repeat(1000)}${'m'.repeat(3000)}${'t'.repeat(2900)}`

  const body = buildJudgeBody(charter({ request }), [], action)

  expect(body).toContain(`request:\n${'h'.repeat(1000)}\n…\n${'t'.repeat(2900)}\n\nRECENT ACTIONS`)
  expect(body).not.toContain('m'.repeat(10))
})

test('a failure inside the decision is unchecked as internal error and never throws (FR-VD-5)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)
  const broken = {
    ...w.$,
    state: {
      get: (ref: { key: string }) => {
        if (ref.key === allowancesAtom.ref.key) throw new Error('boom')
        return w.$.state.get(ref as never)
      },
      set: w.$.state.set,
    },
  } as unknown as CharterDollar

  expect(await decide(broken, cfg, edit('x'), 0)).toEqual({
    verdict: 'unchecked',
    reason: 'internal error',
    source: 'none',
    charterHead: null,
    charterId: null,
    charterRev: 0,
  })
  expect(w.logs).toContain('stayontarget: verdict failed: boom')
  expect(w.requests.length).toBe(0)
  expect(w.stats().unchecked).toBe(1)
})

test('each unchecked decision adds exactly one to stats.unchecked, whatever its path (FR-RS-6)', async () => {
  const w = world()
  clearVerdictCache()

  await decide(w.$, cfg, extractAction('Edit', {}, null), 0)
  expect(w.stats().unchecked).toBe(1)

  await decide(w.$, cfg, edit('x'), 0)
  expect(w.stats().unchecked).toBe(2)

  seeded(w)
  const invalid = decide(w.$, cfg, edit('y'), 0)
  await w.answer(said({ verdict: 'maybe', reason: 'unsure' }))
  await invalid
  expect(w.stats().unchecked).toBe(3)

  const timedOut = decide(w.$, cfg, edit('z'), 0)
  await w.dispatched()
  w.setNow(8000)
  await timedOut
  expect(w.stats().unchecked).toBe(4)
  await w.answer(judged('in-scope'))
  await w.flush()
})

test('a fake sleep whose abort arrives after it woke leaves the other waits alone (fake clock)', async () => {
  const w = world()
  const first = new AbortController()
  const firstWait = w.$.clock.sleep(1000, { signal: first.signal })
  let secondWoke = false
  void w.$.clock.sleep(2000).then(() => {
    secondWoke = true
  })

  w.setNow(1000)
  await firstWait
  first.abort()
  w.setNow(2000)
  await w.flush()

  expect(secondWoke).toBe(true)
})

test('a charter answered at 7,500 ms leaves too little for a judge call: unchecked as judge timeout, decided by 8 s (NFR-2)', async () => {
  const w = world()
  clearVerdictCache()
  w.seed(charterAtom.ref, charter({ distilled: false, pendingText: ['also tidy the lexer'], rev: 0 }))

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.dispatched()
  w.setNow(7500)
  await w.answer(said(newTask('fix the parser', ['src/parser.ts'])))

  expect(await pending).toEqual({
    verdict: 'unchecked',
    reason: 'judge timeout',
    source: 'none',
    charterHead: 'fix the parser',
    charterId: w.charter()?.id ?? null,
    charterRev: w.charter()?.rev ?? 0,
  })
  expect(w.requests.length).toBe(1)
  expect(w.stats()).toMatchObject({ unchecked: 1, judged: 0 })
})

test('a charter call that never answers ends the decision at 8 s, unchecked, with no judge call (NFR-2)', async () => {
  const w = world()
  clearVerdictCache()
  w.seed(charterAtom.ref, charter({ distilled: false, pendingText: ['fix the parser'], rev: 0 }))

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.dispatched()
  w.setNow(8000)

  expect(await pending).toMatchObject({ verdict: 'unchecked', reason: 'charter pending' })
  expect(w.requests.length).toBe(1)

  await w.answer(ABORTED)
  await w.flush()
})

test('an unresolved charter is unchecked as charter pending, though an allowance matches (FR-CH-7)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)
  w.seed(allowancesAtom.ref, [{ charterId: 'c1', tool: 'Edit', target: 'src/parser.ts', at: 0 }])
  w.bump(c => ({ ...c, pendingText: ['New task: only update README, do not edit parser.ts'] }))

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.dispatched()
  w.setNow(8000)

  expect(await pending).toEqual({
    verdict: 'unchecked',
    reason: 'charter pending',
    source: 'none',
    charterHead: 'fix the parser',
    charterId: 'c1',
    charterRev: 2,
  })
  expect(w.stats()).toMatchObject({ allowanceHits: 0, unchecked: 1 })
  expect(w.requests.length).toBe(1)

  await w.answer(ABORTED)
  await w.flush()
})

test('an unresolved charter is unchecked as charter pending, though a verdict is cached for the fingerprint (FR-CH-7)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const first = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('in-scope'))
  await first

  w.bump(c => ({ ...c, pendingText: ['New task: only update README, do not edit parser.ts'] }))
  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.dispatched()
  w.setNow(8000)

  expect(await pending).toMatchObject({ verdict: 'unchecked', reason: 'charter pending' })
  expect(w.stats()).toMatchObject({ cacheHits: 0, unchecked: 1 })

  await w.answer(ABORTED)
  await w.flush()
})

test('a charter answered at 3,000 ms leaves the judge at most 5,000 ms (NFR-2)', async () => {
  const w = world()
  clearVerdictCache()
  w.seed(charterAtom.ref, charter({ distilled: false, pendingText: ['fix the parser'], rev: 0 }))

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.dispatched()
  w.setNow(3000)
  await w.answer(said(newTask('fix the parser', ['src/parser.ts'])))
  await w.dispatched()

  expect(w.requests.length).toBe(2)
  expect(w.requests[1]?.timeoutMs).toBeLessThanOrEqual(5000)
  await w.answer(judged('in-scope'))
  expect(await pending).toMatchObject({ verdict: 'in-scope', source: 'judge' })
})

test('a judge call that outlasts the budget is unchecked at 8 s, and its tokens still count (NFR-2, NFR-3)', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.dispatched()
  w.setNow(8000)

  expect(await pending).toMatchObject({ verdict: 'unchecked', reason: 'judge timeout' })
  expect(w.stats()).toMatchObject({ unchecked: 1, inputTokens: 0 })

  await w.answer(judged('in-scope'))
  await w.flush()
  expect(w.stats()).toMatchObject({ inputTokens: 10, outputTokens: 5 })
})

test('every decision is logged to debug with its verdict and source', async () => {
  const w = world()
  clearVerdictCache()
  seeded(w)

  const pending = decide(w.$, cfg, edit('x'), 0)
  await w.answer(judged('in-scope'))
  await pending

  expect(w.logs).toContain('stayontarget: Edit in-scope (judge): touches the parser')
})
