import { expect, test } from 'claude-code/testing'
import type { ModelCompleteRequest, ModelCompleteResult, ModelTextBlock } from 'claude-code'

import type { Charter, ReadAs, Stats } from '../types'
import { DEFAULT_CONFIG } from '../src/config'
import type { CharterDollar } from '../src/charter'
import {
  addScopeItem,
  answerReadAs,
  appendDelivered,
  editGoal,
  ensureCharter,
  onCommandSubmitted,
  onMainTurnStart,
  onSkillPrompt,
  removeScopeItem,
  startNewTask,
} from '../src/charter'
import { getModelStats } from '../src/model'
import { CHARTER_INSTRUCTIONS } from '../src/prompts'
import { EMPTY_STATS, charterAtom, readAsAtom, statsAtom } from '../src/state'

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const cfg = DEFAULT_CONFIG

type Ref = { plugin: string; key: string; id?: string }
type Entry = { value: unknown; version: number }

// A fake `$` with the nouns the charter lifecycle uses. The state is a versioned in-memory store that answers `get` and
// `set(…, { ifVersion })` as the engine does, so the real `read` and `update` run against it. Model calls are held until
// the test answers them, and the clock moves only when the test moves it. The test body's `$` has no `clock`, so the
// module is driven through this fake.
function world() {
  let clock = 0
  let nowCalls = 0
  let interleave: { at: number; run: () => void } | null = null
  const sleeps: { due: number; wake: () => void }[] = []
  const store = new Map<string, Entry>()
  const keyOf = (ref: Ref) => [ref.plugin, ref.key, ref.id ?? ''].join('/')
  const charterKey = keyOf(charterAtom.ref)
  const statsKey = keyOf(statsAtom.ref)
  const requests: ModelCompleteRequest[] = []
  const holds: ((reply: ModelCompleteResult) => void)[] = []
  const logs: string[] = []
  let refusals = 0
  // Runs once, inside the next `set`, before its version check: a write that lands between update's read and write.
  let racing: (() => void) | null = null
  // One-shot holds: the next write of a key waits until its release runs.
  const gates = new Map<string, Promise<void>>()

  const write = (key: string, value: unknown) => {
    const version = (store.get(key)?.version ?? 0) + 1
    store.set(key, { value, version })
    return version
  }

  const $ = {
    state: {
      get: async (ref: Ref) => {
        const entry = store.get(keyOf(ref))
        return { value: entry?.value, version: entry?.version ?? 0 }
      },
      set: async (ref: Ref, value: unknown, options?: { ifVersion?: number }) => {
        // A held write waits for its release before its version is checked, as a write the store has not yet answered.
        const gate = gates.get(keyOf(ref))
        if (gate !== undefined) {
          gates.delete(keyOf(ref))
          await gate
        }
        if (racing !== null) {
          const race = racing
          racing = null
          race()
        }
        const key = keyOf(ref)
        const version = store.get(key)?.version ?? 0
        if (options?.ifVersion !== undefined && options.ifVersion !== version) {
          refusals += 1
          return { isSet: false, version }
        }
        return { isSet: true, version: write(key, value) }
      },
    },
    model: {
      complete: (request: ModelCompleteRequest) => {
        requests.push(request)
        return new Promise<ModelCompleteResult>(resolve => {
          holds.push(resolve)
        })
      },
    },
    clock: {
      now: async () => {
        nowCalls += 1
        if (interleave !== null && interleave.at === nowCalls) {
          const run = interleave.run
          interleave = null
          run()
        }
        return clock
      },
      sleep: (ms: number, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          const entry = { due: clock + ms, wake: resolve }
          sleeps.push(entry)
          options?.signal?.addEventListener(
            'abort',
            () => {
              // A wait that has already woken is no longer listed: its abort must not remove another wait.
              const index = sleeps.indexOf(entry)
              if (index !== -1) sleeps.splice(index, 1)
              reject(new Error('sleep aborted'))
            },
            { once: true },
          )
        }),
    // A timer runs when the clock reaches it, as a sleep does: `setNow` wakes both.
    after: (ms: number, fire: () => void) => {
      const entry = { due: clock + ms, wake: fire }
      sleeps.push(entry)
      return {
        cancel: () => {
          const index = sleeps.indexOf(entry)
          if (index !== -1) sleeps.splice(index, 1)
        },
      }
    },
    },
    ui: {
      log: (text: string) => {
        logs.push(text)
      },
    },
  } as unknown as CharterDollar

  // Lets every chained continuation run: the module's promises settle within a few dozen microtask turns.
  const flush = async () => {
    for (let turn = 0; turn < 100; turn++) await Promise.resolve()
  }

  // Answers the oldest held model call, once it has been dispatched.
  async function answer(reply: ModelCompleteResult): Promise<void> {
    await flush()
    const hold = holds.shift()
    if (hold === undefined) throw new Error('no model call was dispatched')
    hold(reply)
  }

  return {
    $,
    requests,
    holds,
    logs,
    flush,
    answer,
    race: (change: () => void) => {
      racing = change
    },
    bump: (change: (charter: Charter) => Charter) => {
      const current = store.get(charterKey)?.value as Charter | null | undefined
      if (current === null || current === undefined) throw new Error('no charter to bump')
      write(charterKey, change(current))
    },
    refusals: () => refusals,
    // Holds the next write of `ref` until the returned release runs.
    hold: (ref: Ref): (() => void) => {
      let release: () => void = () => undefined
      gates.set(keyOf(ref), new Promise<void>(resolve => (release = resolve)))
      return () => release()
    },
    // Moves the clock to `ms`, waking each sleep that comes due on the way, in order.
    setNow: (ms: number) => {
      clock = ms
      for (;;) {
        const due = sleeps.filter(s => s.due <= clock).sort((a, b) => a.due - b.due)[0]
        if (due === undefined) break
        sleeps.splice(sleeps.indexOf(due), 1)
        due.wake()
      }
    },
    nowCalls: () => nowCalls,
    // Runs `run` at the `at`-th clock read from now on: a point inside an update where another caller can interleave.
    interleaveAt: (at: number, run: () => void) => {
      interleave = { at, run }
    },
    charter: () => (store.get(charterKey)?.value as Charter | null | undefined) ?? null,
    readAs: () => (store.get(keyOf(readAsAtom.ref))?.value as ReadAs | null | undefined) ?? null,
    stats: () => (store.get(statsKey)?.value as Stats | undefined) ?? EMPTY_STATS,
  }
}

type World = ReturnType<typeof world>

const said = (value: unknown): ModelCompleteResult => ({ isAnswered: true, text: JSON.stringify(value), usage: USAGE })
const newTask = (goal: string, inScope: string[] = [], outOfScope: string[] = []) => ({
  kind: 'new-task',
  goal,
  inScope,
  outOfScope,
})
const amendment = (goal: string, inScope: string[] = [], outOfScope: string[] = []) => ({
  kind: 'amendment',
  goal,
  inScope,
  outOfScope,
})
const chitChat = { kind: 'chit-chat', goal: 'unchanged', inScope: [], outOfScope: [] }

// Runs an ensure and answers its one model call with `reply`.
async function distil(w: World, reply: ModelCompleteResult) {
  const pending = ensureCharter(w.$, cfg, 0)
  await w.answer(reply)
  return pending
}

test('the first turn creates a rev-0 charter with its text pending (FR-CH-2)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1000)

  expect(w.charter()).toMatchObject({
    rev: 0,
    goal: null,
    distilled: false,
    request: '',
    pendingText: ['build the parser'],
    createdAt: 1000,
  })
  expect(w.charter()?.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(w.requests.length).toBe(0)
})

test('a turn with blank text creates no charter and no pending text (FR-CH-2)', async () => {
  const w = world()
  await onMainTurnStart(w.$, '', 1000)
  await onMainTurnStart(w.$, '   \n ', 1000)

  expect(w.charter()).toBe(null)
})

test('a turn is redacted and bounded to 4,000 characters before it is kept (NFR-4)', async () => {
  const w = world()
  await onMainTurnStart(w.$, `run with token=s3cret123 ${'x'.repeat(10000)}`, 1000)

  const [entry] = w.charter()?.pendingText ?? []
  expect(entry).toBeDefined()
  expect(entry).not.toContain('s3cret123')
  expect(entry).toContain('«redacted»')
  expect((entry ?? '').length).toBeLessThanOrEqual(4000)
})

test('pending text keeps the newest sixteen entries and logs what it drops', async () => {
  const w = world()
  for (let i = 1; i <= 16; i++) await onMainTurnStart(w.$, `turn ${i}`, i)
  expect(w.logs.some(line => line.includes('pending overflow'))).toBe(false)

  await onMainTurnStart(w.$, 'turn 17', 17)
  expect(w.charter()?.pendingText).toHaveLength(16)
  expect(w.charter()?.pendingText[0]).toBe('turn 2')
  expect(w.logs).toContain('stayontarget: charter pending overflow, dropped 1')
})

test('a skill body is kept only after a command mark and within ten minutes (FR-CH-3)', async () => {
  const w = world()
  const lastPending = () => w.charter()?.pendingText.at(-1)

  // No command mark: the body is ignored.
  onSkillPrompt('SKILL-A', 0)
  await onMainTurnStart(w.$, 'go', 1)
  expect(lastPending()).toBe('go')

  // Marked and within ten minutes: the body follows the command's text, and the mark is spent by the turn.
  onCommandSubmitted(0)
  onSkillPrompt('SKILL-B', 599999)
  await onMainTurnStart(w.$, '/fix', 600000)
  expect(lastPending()).toBe('/fix\nSKILL-B')

  // Marked but ten minutes or more ago: ignored.
  onCommandSubmitted(0)
  onSkillPrompt('SKILL-C', 600000)
  await onMainTurnStart(w.$, 'late', 600001)
  expect(lastPending()).toBe('late')

  // A body fired after a turn has started, with no new mark, is not kept.
  onSkillPrompt('SKILL-D', 600002)
  await onMainTurnStart(w.$, 'next', 600003)
  expect(lastPending()).toBe('next')
})

test('a captured skill body is bounded to 1,500 characters (FR-CH-3)', async () => {
  const w = world()
  onCommandSubmitted(0)
  onSkillPrompt('s'.repeat(5000), 0)
  await onMainTurnStart(w.$, 'go', 1)

  const entry = w.charter()?.pendingText.at(-1) ?? ''
  expect(entry.startsWith('go\n')).toBe(true)
  expect(entry.length).toBeLessThanOrEqual(4 + 1500)
})

test('the first update of a charter is always a new task, whatever the model says (FR-CH-4)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1000)
  const before = w.charter()

  const after = await distil(w, said(amendment('Build parser', ['src/parser.ts'])))

  expect(after).toMatchObject({
    id: before?.id,
    rev: 1,
    request: 'build the parser',
    goal: 'Build parser',
    inScope: ['src/parser.ts'],
    distilled: true,
    pendingText: [],
  })
  expect(w.requests[0]?.prompt).toEqual([
    { text: CHARTER_INSTRUCTIONS, cache: true },
    { text: 'CURRENT CHARTER:\nnone\n\nNEW MESSAGES:\n1. build the parser' },
  ])
  expect(getModelStats().inFlight).toBe(0)
})

test('new-task, amendment and chit-chat each move the charter as FR-CH-4 says', async () => {
  const w = world()

  await onMainTurnStart(w.$, 'build the parser', 1)
  await distil(w, said(newTask('Build parser')))
  const first = w.charter()
  expect(first).toMatchObject({ rev: 1, goal: 'Build parser', request: 'build the parser' })

  await onMainTurnStart(w.$, 'also update the tests', 2)
  await distil(w, said(amendment('Build parser and tests')))
  expect(w.charter()).toMatchObject({
    id: first?.id,
    rev: 2,
    goal: 'Build parser and tests',
    request: 'build the parser\n---\nalso update the tests',
    distilled: true,
  })

  await onMainTurnStart(w.$, 'thanks', 3)
  await distil(w, said(chitChat))
  expect(w.charter()).toMatchObject({ id: first?.id, rev: 2, goal: 'Build parser and tests', pendingText: [] })

  await onMainTurnStart(w.$, 'write a poem', 4)
  await distil(w, said(newTask('Write a poem')))
  expect(w.charter()).toMatchObject({ rev: 1, goal: 'Write a poem', request: 'write a poem' })
  expect(w.charter()?.id).not.toBe(first?.id)
  expect(getModelStats().inFlight).toBe(0)
})

test('a goal the person edited survives an amendment (FR-CH-8, FR-CH-4)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1)
  await distil(w, said(newTask('Build parser')))

  await editGoal(w.$, '  Only the lexer  ')
  expect(w.charter()).toMatchObject({ rev: 2, goal: 'Only the lexer', editedFields: ['goal'] })

  await onMainTurnStart(w.$, 'also add tests', 2)
  await distil(w, said(amendment('Model goal', ['src/lexer.ts'])))
  expect(w.charter()).toMatchObject({ rev: 3, goal: 'Only the lexer', inScope: ['src/lexer.ts'], editedFields: ['goal'] })

  await editGoal(w.$, '   ')
  expect(w.charter()?.goal).toBe('Only the lexer')

  await startNewTask(w.$)
  expect(w.charter()).toBe(null)
  expect(getModelStats().inFlight).toBe(0)
})

test('editing the goal with no charter changes nothing (FR-CH-8)', async () => {
  const w = world()
  await editGoal(w.$, 'anything')
  expect(w.charter()).toBe(null)
})

test('a reply that is not JSON fails the update: the text is kept unverified and counted (FR-CH-7)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  await distil(w, { isAnswered: true, text: 'not json at all', usage: USAGE })

  expect(w.charter()).toMatchObject({ rev: 1, goal: null, distilled: false, request: 'build it', pendingText: [] })
  expect(w.stats()).toMatchObject({ charterFailures: 1, charterUpdates: 0, inputTokens: 10, outputTokens: 5 })
  expect(w.logs).toContain('stayontarget: charter not distilled (invalid reply)')
  expect(getModelStats().inFlight).toBe(0)
})

test('a failed model call merges the text as an amendment and keeps the goal (FR-CH-7)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1)
  await distil(w, said(newTask('Build parser')))

  await onMainTurnStart(w.$, 'also tests', 2)
  await distil(w, { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: USAGE })

  expect(w.charter()).toMatchObject({
    rev: 2,
    goal: 'Build parser',
    distilled: false,
    request: 'build the parser\n---\nalso tests',
    pendingText: [],
  })
  expect(w.stats()).toMatchObject({ charterFailures: 1, charterUpdates: 1 })
  expect(w.logs).toContain('stayontarget: charter not distilled (api-error: status 500 server_error)')
})

test('a reply outside the schema fails the update (FR-CH-7)', async () => {
  const invalid = [
    { kind: 'bogus', goal: 'g', inScope: [], outOfScope: [] },
    { kind: 'amendment', goal: '   ', inScope: [], outOfScope: [] },
    { kind: 'new-task', goal: 'g', inScope: [1], outOfScope: [] },
    { kind: 'new-task', goal: 'g', inScope: 'src', outOfScope: [] },
    { kind: 'new-task', outOfScope: [] },
  ]
  for (const reply of invalid) {
    const w = world()
    await onMainTurnStart(w.$, 'build it', 1)
    await distil(w, said(reply))
    expect(w.charter()).toMatchObject({ distilled: false, goal: null })
    expect(w.stats().charterFailures).toBe(1)
  }
})

test('lists are cut to eight items of two hundred characters (FR-CH-4)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  await distil(w, said(newTask('g', Array.from({ length: 10 }, () => 'a'.repeat(300)))))

  const inScope = w.charter()?.inScope ?? []
  expect(inScope).toHaveLength(8)
  expect(inScope.every(item => item.length === 200)).toBe(true)
})

test('concurrent ensures make one model call and share its result (FR-CH-5)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)

  const first = ensureCharter(w.$, cfg, 0)
  const second = ensureCharter(w.$, cfg, 0)
  await w.answer(said(newTask('Build it')))
  const [a, b] = await Promise.all([first, second])

  expect(w.requests.length).toBe(1)
  expect(a).toEqual(b)
  expect(a).toMatchObject({ rev: 1, goal: 'Build it' })
  expect(w.stats().charterUpdates).toBe(1)

  // Nothing pending now: no further model call.
  await ensureCharter(w.$, cfg, 0)
  expect(w.requests.length).toBe(1)
})

test('a change to the pending text during the call discards the result and recomputes once (FR-CH-5)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)

  const pending = ensureCharter(w.$, cfg, 0)
  await w.flush()
  await onMainTurnStart(w.$, 'also tests', 2)
  w.holds.shift()?.(said(newTask('Build it')))
  await w.flush()

  expect(w.requests.length).toBe(2)
  expect(w.requests[1]?.prompt).toEqual([
    { text: CHARTER_INSTRUCTIONS, cache: true },
    { text: 'CURRENT CHARTER:\nnone\n\nNEW MESSAGES:\n1. build it\n2. also tests' },
  ])
  await w.answer(said(newTask('Build it and tests')))

  expect(await pending).toMatchObject({ rev: 1, goal: 'Build it and tests', request: 'build it\nalso tests', pendingText: [] })
  expect(w.stats()).toMatchObject({ charterUpdates: 1, inputTokens: 20 })
  expect(getModelStats().inFlight).toBe(0)
})

test('a second change during the recompute returns the charter unchanged (FR-CH-5)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)

  const pending = ensureCharter(w.$, cfg, 0)
  await w.flush()
  await onMainTurnStart(w.$, 'also tests', 2)
  w.holds.shift()?.(said(newTask('Build it')))
  await w.flush()
  await onMainTurnStart(w.$, 'and docs', 3)
  await w.answer(said(newTask('Build it and tests')))

  expect(w.requests.length).toBe(2)
  expect(await pending).toMatchObject({ rev: 0, goal: null, distilled: false })
  expect(w.charter()?.pendingText).toEqual(['build it', 'also tests', 'and docs'])
  expect(w.stats().charterUpdates).toBe(0)
  expect(getModelStats().inFlight).toBe(0)
})

test('a write that lands between update\'s read and write is retried, and no turn is lost (NFR-5)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'first', 1)

  // Another writer lands inside the next state write, after update has read the charter.
  w.race(() => w.bump(charter => ({ ...charter, pendingText: [...charter.pendingText, 'racer'] })))
  await onMainTurnStart(w.$, 'mine', 2)

  expect(w.refusals()).toBe(1)
  expect(w.charter()?.pendingText).toEqual(['first', 'racer', 'mine'])
})

test('the request keeps its first 2,000 and last 3,900 characters past 6,000 (FR-CH-4)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'H'.repeat(4000), 1)
  await distil(w, said(newTask('Big task')))
  await onMainTurnStart(w.$, 'T'.repeat(4000), 2)
  await distil(w, said(amendment('Big task, amended')))

  const request = w.charter()?.request ?? ''
  expect(request.length).toBeLessThanOrEqual(6000)
  expect(request.startsWith('H'.repeat(2000) + '\n…\n')).toBe(true)
  expect(request.endsWith('T'.repeat(3900))).toBe(true)
  expect(getModelStats().inFlight).toBe(0)
})

test('the model call carries the charter instructions at low effort, 400 tokens, within 8 s (FR-VD-6)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  await distil(w, said(newTask('Build it')))

  const [request] = w.requests
  expect(request).toMatchObject({ model: 'haiku', maxTokens: 400, effort: 'low', timeoutMs: 8000 })
  const [instructions] = (request?.prompt ?? []) as readonly ModelTextBlock[]
  expect(instructions).toEqual({ text: CHARTER_INSTRUCTIONS, cache: true })
})

test('a state read that fails leaves no charter and logs, without throwing (fail-open)', async () => {
  const w = world()
  const broken = {
    ...w.$,
    state: {
      get: async () => {
        throw new Error('state unavailable')
      },
      set: w.$.state.set,
    },
  } as unknown as CharterDollar

  expect(await ensureCharter(broken, cfg, 0)).toBe(null)
  expect(w.logs).toContain('stayontarget: charter update failed: state unavailable')
})

test('a failed turn-start write logs and resolves, without throwing (fail-open)', async () => {
  const w = world()
  const broken = {
    ...w.$,
    state: {
      get: w.$.state.get,
      set: async () => {
        throw new Error('write refused')
      },
    },
  } as unknown as CharterDollar

  await onMainTurnStart(broken, 'build it', 1)
  expect(w.logs).toContain('stayontarget: pending text not recorded: write refused')
})

test('a turn cut inside a URL username leaks none of the username, to the charter or the model (FR-AX-3, NFR-4)', async () => {
  const w = world()
  // The username runs past the kept window: only the cut flag tells redaction that the URL is cut.
  const username = 'k'.repeat(1000)
  await onMainTurnStart(w.$, `${' '.repeat(3970)}https://${username}@example.com/path`, 1)
  const pending = ensureCharter(w.$, cfg, 0)
  await w.answer(said(newTask('Build it')))
  await pending

  expect(w.charter()?.pendingText[0] ?? '').not.toContain('kkkk')
  const body = (w.requests[0]?.prompt as readonly ModelTextBlock[] | undefined)?.[1]?.text ?? ''
  expect(body).not.toContain('kkkk')
})

test('a caller arriving during an update shares it: at most two model calls, both turns kept (FR-CH-5)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  const first = ensureCharter(w.$, cfg, 0)
  await w.flush()
  await onMainTurnStart(w.$, 'also tests', 2)
  const second = ensureCharter(w.$, cfg, 0)
  await w.flush()
  expect(w.requests.length).toBe(1)

  // The first attempt's base changed meanwhile, so it recomputes once, with both turns.
  w.holds.shift()?.(said(newTask('Build it')))
  await w.flush()
  await w.answer(said(newTask('Build it and tests')))
  const [a, b] = await Promise.all([first, second])

  expect(w.requests.length).toBe(2)
  expect(a).toEqual(b)
  expect(w.charter()).toMatchObject({ rev: 1, request: 'build it\nalso tests', pendingText: [] })
  expect(getModelStats().inFlight).toBe(0)
})

test('the tokens of a failed or blank reply count in the stats too (NFR-3)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  await distil(w, {
    isAnswered: false,
    reason: 'empty-reply',
    usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  expect(w.stats()).toMatchObject({ inputTokens: 7, outputTokens: 3, charterFailures: 1 })

  await onMainTurnStart(w.$, 'more', 2)
  await distil(w, {
    isAnswered: true,
    text: '  ',
    usage: { input_tokens: 4, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
  expect(w.stats()).toMatchObject({ inputTokens: 11, outputTokens: 5, charterFailures: 2 })
})

test('one deadline covers both attempts: a recompute that would start too late is skipped (FR-VD-6)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  const pending = ensureCharter(w.$, cfg, 0)
  await w.flush()
  await onMainTurnStart(w.$, 'also tests', 2)
  w.setNow(7500)
  await w.answer(said(newTask('Build it')))

  expect(await pending).toMatchObject({ rev: 0, pendingText: ['build it', 'also tests'] })
  expect(w.requests.length).toBe(1)
  expect(getModelStats().inFlight).toBe(0)
})

test('a recompute joins the flight of the revision it moved to: two model calls, one charter (FR-CH-5)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  const a = ensureCharter(w.$, cfg, 0)
  await w.flush()
  // The person edits the goal while A's call is held, which bumps the rev; B starts a flight for the new rev.
  await editGoal(w.$, 'mine')
  const b = ensureCharter(w.$, cfg, 0)
  await w.flush()
  expect(w.requests.length).toBe(2)

  // A's call answers after its base moved: its commit misses and it shares B's flight, with no third call.
  await w.answer(said(newTask('Build it')))
  await w.flush()
  expect(w.requests.length).toBe(2)
  await w.answer(said(newTask('Build it and more')))
  const [ra, rb] = await Promise.all([a, b])

  expect(w.requests.length).toBe(2)
  expect(ra).toEqual(rb)
  expect(w.charter()).toMatchObject({ rev: 2, goal: 'mine', pendingText: [] })
  expect(getModelStats().inFlight).toBe(0)
})

test('a goal edited before the first distillation survives it: same id, the person\'s goal, the reply\'s scope (FR-CH-4, FR-CH-8)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  const before = w.charter()
  await editGoal(w.$, 'mine')
  await distil(w, said(newTask('Model goal', ['src/x.ts'])))

  expect(w.charter()).toMatchObject({
    id: before?.id,
    goal: 'mine',
    editedFields: ['goal'],
    inScope: ['src/x.ts'],
    distilled: true,
    pendingText: [],
  })
})

test('joining a newer flight is bounded: A resolves at 8 s with the current charter, and B still commits (FR-VD-6)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  const a = ensureCharter(w.$, cfg, 0)
  await w.flush()
  await editGoal(w.$, 'mine')
  w.setNow(7000)
  const b = ensureCharter(w.$, cfg, 0)
  await w.flush()
  expect(w.requests.length).toBe(2)

  // A's base is stale at 8 s and no budget is left to join with, so A returns without waiting for B.
  w.setNow(8000)
  await w.answer(said(newTask('Build it')))
  expect(await a).toMatchObject({ rev: 1, pendingText: ['build it'] })
  expect(w.holds.length).toBe(1)

  await w.answer(said(newTask('Build it and more')))
  expect(await b).toMatchObject({ rev: 2, goal: 'mine', pendingText: [] })
  expect(w.requests.length).toBe(2)
  expect(getModelStats().inFlight).toBe(0)
})

test('a join that outlives its budget returns the charter as it stands, and the other flight still commits (FR-VD-6)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  const a = ensureCharter(w.$, cfg, 0)
  await w.flush()
  await editGoal(w.$, 'mine')
  w.setNow(7000)
  const b = ensureCharter(w.$, cfg, 0)
  await w.flush()

  // A's answer lands at 7 s with 1 s left: it joins B's flight, which does not finish within A's budget.
  await w.answer(said(newTask('Build it')))
  await w.flush()
  expect(w.holds.length).toBe(1)
  w.setNow(8000)
  expect(await a).toMatchObject({ rev: 1, pendingText: ['build it'] })

  await w.answer(said(newTask('Build it and more')))
  expect(await b).toMatchObject({ rev: 2, goal: 'mine', pendingText: [] })
  expect(w.requests.length).toBe(2)
  expect(getModelStats().inFlight).toBe(0)
})

test('a caller that arrives in the gap before a recompute joins it: one model call for that revision (FR-CH-5)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  const a = ensureCharter(w.$, cfg, 0)
  await w.flush()
  await editGoal(w.$, 'mine')

  // The clock read after A's first attempt is the one inside the gap; a caller arriving there must not start its own call.
  let c: Promise<Charter | null> | undefined
  w.interleaveAt(w.nowCalls() + 2, () => {
    c = ensureCharter(w.$, cfg, 0)
  })
  await w.answer(said(newTask('Build it')))
  await w.flush()
  expect(w.requests.length).toBe(2)

  await w.answer(said(newTask('Build it and more')))
  expect(await a).toEqual(await c)
  expect(w.requests.length).toBe(2)
  expect(getModelStats().inFlight).toBe(0)
})

test('an edit between the read that makes a flight key and its first attempt leaves one model call per revision (FR-CH-5)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  // The first clock read after ensureCharter's own start and charter read is inside resolve, before its first attempt:
  // the edit lands there, so the attempt is for the revision the key names (rev 0), not the one the edit made.
  let edit: Promise<void> | undefined
  w.interleaveAt(w.nowCalls() + 2, () => {
    edit = editGoal(w.$, 'mine')
  })
  const a = ensureCharter(w.$, cfg, 0)
  await w.flush()
  await edit
  expect(w.requests.length).toBe(1)
  expect(((w.requests[0]?.prompt as readonly ModelTextBlock[])[1]?.text ?? '')).toContain('CURRENT CHARTER:\nnone')

  // B starts for the edited revision: it makes the one call for that revision.
  const b = ensureCharter(w.$, cfg, 0)
  await w.flush()
  expect(w.requests.length).toBe(2)

  // A's base is stale: its commit misses and its recompute joins B's flight, with no third call.
  await w.answer(said(newTask('Build it')))
  await w.flush()
  expect(w.requests.length).toBe(2)
  await w.answer(said(newTask('Build it and more')))

  expect(await a).toEqual(await b)
  expect(w.charter()).toMatchObject({ rev: 2, goal: 'mine', pendingText: [] })
  expect(getModelStats().inFlight).toBe(0)
})

test('the recompute is given only the time the first attempt left (FR-VD-6)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  const pending = ensureCharter(w.$, cfg, 0)
  await w.flush()
  await onMainTurnStart(w.$, 'also tests', 2)
  w.setNow(3000)
  await w.answer(said(newTask('Build it')))
  await w.flush()
  expect(w.requests[1]?.timeoutMs).toBe(5000)
  await w.answer(said(newTask('Build it and tests')))

  expect(await pending).toMatchObject({ rev: 1, pendingText: [] })
  expect(getModelStats().inFlight).toBe(0)
})

test('a flight whose commit throws after its joiner timed out does not reject unhandled, and logs it (FR-CH-7, NFR-5)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  let armed = false
  // The state write for the charter throws once armed: the commit of the flight fails after its joiner has left.
  const failing = {
    ...w.$,
    state: {
      get: w.$.state.get,
      set: (ref: { key: string }, value: unknown, options?: { ifVersion?: number }) =>
        armed && ref.key === charterAtom.ref.key
          ? Promise.reject(new Error('disk gone'))
          : w.$.state.set(ref as never, value as Charter | null, options),
    },
  } as unknown as CharterDollar

  const a = ensureCharter(failing, cfg, 0)
  await w.flush()
  const b = ensureCharter(failing, cfg, 0, 2000)
  await w.flush()
  w.setNow(2000)
  expect(await b).toMatchObject({ rev: 0, pendingText: ['build it'] })

  armed = true
  await w.answer(said(newTask('Build it')))
  expect(await a).toMatchObject({ rev: 0, pendingText: ['build it'] })
  expect(w.logs).toContain('stayontarget: charter update failed: disk gone')
  expect(getModelStats().inFlight).toBe(0)
})

test('a caller joining a slow flight with a 2 s budget returns by 2 s with the charter as it stands, and the flight still commits (NFR-2)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build it', 1)
  const a = ensureCharter(w.$, cfg, 0)
  await w.flush()

  const b = ensureCharter(w.$, cfg, 0, 2000)
  await w.flush()
  w.setNow(2000)
  expect(await b).toMatchObject({ rev: 0, pendingText: ['build it'] })

  await w.answer(said(newTask('Build it')))
  expect(await a).toMatchObject({ rev: 1, pendingText: [] })
  expect(getModelStats().inFlight).toBe(0)
})

test('the person adds a scope item: trimmed, redacted, cut to 200, marked edited and raising rev (FR-UI-10, FR-CH-8)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1)
  await distil(w, said(newTask('Build parser', ['src/a.ts'])))

  await addScopeItem(w.$, 'inScope', '  src/b.ts  ')
  expect(w.charter()).toMatchObject({ rev: 2, inScope: ['src/a.ts', 'src/b.ts'], editedFields: ['inScope'] })

  await addScopeItem(w.$, 'outOfScope', 'password=hunter2 ' + 'x'.repeat(300))
  const out = w.charter()?.outOfScope[0] ?? ''
  expect(out).not.toContain('hunter2')
  expect(out.length).toBeLessThanOrEqual(200)
  expect(w.charter()).toMatchObject({ rev: 3, editedFields: ['inScope', 'outOfScope'] })

  await addScopeItem(w.$, 'inScope', 'src/c.ts')
  expect(w.charter()?.editedFields).toEqual(['inScope', 'outOfScope'])
})

test('an empty or duplicate scope item changes nothing (FR-UI-10)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1)
  await distil(w, said(newTask('Build parser', ['src/a.ts'])))

  await addScopeItem(w.$, 'inScope', '   ')
  await addScopeItem(w.$, 'inScope', 'src/a.ts')
  expect(w.charter()).toMatchObject({ rev: 1, inScope: ['src/a.ts'], editedFields: [] })
})

test('a ninth scope item is refused and logged (FR-UI-10)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1)
  await distil(w, said(newTask('Build parser', Array.from({ length: 8 }, (_, i) => `f${i}.ts`))))

  await addScopeItem(w.$, 'inScope', 'ninth.ts')
  expect(w.charter()).toMatchObject({ rev: 1, editedFields: [] })
  expect(w.charter()?.inScope).toHaveLength(8)
  expect(w.logs.some(line => line.includes('at most 8'))).toBe(true)
})

test('a scope item is removed by index; an index out of range changes nothing (FR-UI-10)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1)
  await distil(w, said(newTask('Build parser', ['src/a.ts', 'src/b.ts'])))

  await removeScopeItem(w.$, 'inScope', 5)
  await removeScopeItem(w.$, 'inScope', -1)
  expect(w.charter()).toMatchObject({ rev: 1, inScope: ['src/a.ts', 'src/b.ts'], editedFields: [] })

  await removeScopeItem(w.$, 'inScope', 0)
  expect(w.charter()).toMatchObject({ rev: 2, inScope: ['src/b.ts'], editedFields: ['inScope'] })
})

test('editing scope with no charter changes nothing (FR-UI-10)', async () => {
  const w = world()
  await addScopeItem(w.$, 'inScope', 'src/a.ts')
  await removeScopeItem(w.$, 'outOfScope', 0)
  expect(w.charter()).toBe(null)
})

test('an amendment keeps an edited list and replaces an unedited one (FR-CH-5)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1)
  await distil(w, said(newTask('Build parser', ['src/a.ts'], ['docs/x.md'])))
  await addScopeItem(w.$, 'inScope', 'src/mine.ts')

  await onMainTurnStart(w.$, 'also the lexer', 2)
  await distil(w, said(amendment('Build parser', ['src/model.ts'], ['tests/y.ts'])))
  expect(w.charter()).toMatchObject({ inScope: ['src/a.ts', 'src/mine.ts'], outOfScope: ['tests/y.ts'], editedFields: ['inScope'] })
})

test('the first resolution keeps a list the person edited before it (FR-CH-4)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1)
  await addScopeItem(w.$, 'outOfScope', 'docs/')
  await distil(w, said(newTask('Build parser', ['src/a.ts'], ['tests/y.ts'])))
  expect(w.charter()).toMatchObject({ outOfScope: ['docs/'], inScope: ['src/a.ts'], distilled: true })
})

test('a goal edit after a list edit keeps the list edited, so an amendment keeps both (FR-CH-5, FR-CH-8)', async () => {
  const w = world()
  await onMainTurnStart(w.$, 'build the parser', 1)
  await distil(w, said(newTask('Build parser', ['src/a.ts'])))
  await addScopeItem(w.$, 'inScope', 'src/mine.ts')
  await editGoal(w.$, 'Only the lexer')
  expect(w.charter()?.editedFields).toEqual(['inScope', 'goal'])

  await onMainTurnStart(w.$, 'also the docs', 2)
  await distil(w, said(amendment('Model goal', ['src/model.ts'])))
  expect(w.charter()).toMatchObject({ goal: 'Only the lexer', inScope: ['src/a.ts', 'src/mine.ts'], editedFields: ['inScope', 'goal'] })
})

// FR-CH-10: the "Read as" line. A charter with a task, then turns the model reads as the given replies.
const failedReply: ModelCompleteResult = { isAnswered: false, reason: 'api-error', status: 500, error: 'overloaded', usage: USAGE }

async function withTask(w: World): Promise<void> {
  await onMainTurnStart(w.$, 'build the parser', 1)
  await distil(w, said(newTask('Build parser')))
}

async function readingOf(w: World, text: string, reply: ModelCompleteResult): Promise<Charter | null> {
  await onMainTurnStart(w.$, text, 1)
  return distil(w, reply)
}

test('an amendment on a charter with a task is recorded with what it read and the charter before it (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  const before = w.charter()

  const after = await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))

  expect(w.readAs()).toEqual({
    reading: 'amendment',
    head: 'also update the tests',
    before,
    consumed: ['also update the tests'],
    afterId: after?.id,
    afterRev: 2,
    at: 0,
  })
})

test('a new-task reading on a charter with a task is recorded against the new charter (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  const before = w.charter()

  const after = await readingOf(w, 'write the docs', said(newTask('Write docs')))

  expect(w.readAs()).toMatchObject({ reading: 'new-task', head: 'write the docs', afterId: after?.id, afterRev: 1 })
  expect(after?.id).not.toBe(before?.id)
  expect(w.readAs()?.before).toEqual(before)
})

test('no reading is recorded for chit-chat, the first charter, or the failure merge (FR-CH-10)', async () => {
  const chat = world()
  await withTask(chat)
  await readingOf(chat, 'thanks', said(chitChat))
  expect(chat.readAs()).toBeNull()

  const first = world()
  await onMainTurnStart(first.$, 'build the parser', 1)
  await distil(first, said(amendment('Build parser')))
  expect(first.readAs()).toBeNull()

  const failed = world()
  await withTask(failed)
  await readingOf(failed, 'more', failedReply)
  expect(failed.readAs()).toBeNull()
  expect(failed.charter()).toMatchObject({ distilled: false })
})

test('the head of a reading is redacted, one line, and cut to 80 characters (FR-CH-10, FR-AX-3)', async () => {
  const w = world()
  await withTask(w)

  await readingOf(w, `password=hunter2\nand ${'x'.repeat(200)}`, said(amendment('Build parser and more')))

  expect(w.readAs()?.head.length).toBe(80)
  expect(w.readAs()?.head.startsWith('password=«redacted» and ')).toBe(true)
  expect(w.readAs()?.head).not.toContain('hunter2')
})

test('a new main turn clears the reading, even one with no text (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))
  expect(w.readAs()).not.toBeNull()

  await onMainTurnStart(w.$, '', 2)

  expect(w.readAs()).toBeNull()
})

test('a Same task correction forces the next update to an amendment, whatever the model says, and the field is consumed (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  const before = w.charter()
  await readingOf(w, 'a second thing', said(newTask('Other work')))

  expect(await answerReadAs(w.$, 'same-task', 3)).toBe(true)
  expect(w.charter()).toMatchObject({ id: before?.id, rev: 1, pendingText: ['a second thing'], forcedReading: 'amendment' })
  expect(w.readAs()).toBeNull()

  const after = await distil(w, said(newTask('Other work')))

  expect(after).toMatchObject({ id: before?.id, rev: 2, distilled: true, goal: 'Other work' })
  expect(after?.request).toBe('build the parser\n---\na second thing')
  expect(after).not.toHaveProperty('forcedReading')
  // F3: the forced update is the person's own answer, so no reading is shown for it.
  expect(w.readAs()).toBeNull()
})

test('New task from an amendment: a fresh rev-0 charter holds the consumed text, and the next ensure distils it (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  const old = w.charter()
  await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))

  expect(await answerReadAs(w.$, 'new-task', 9)).toBe(true)
  expect(w.charter()).toMatchObject({
    rev: 0,
    request: '',
    goal: null,
    distilled: false,
    pendingText: ['also update the tests'],
    createdAt: 9,
  })
  expect(w.charter()?.id).not.toBe(old?.id)
  expect(w.readAs()).toBeNull()

  const after = await distil(w, said(newTask('Update the tests')))

  expect(after).toMatchObject({ rev: 1, request: 'also update the tests', distilled: true, goal: 'Update the tests' })
  expect(after?.id).not.toBe(old?.id)
})

test('Not a change restores the charter before the update exactly, and drops the consumed text (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  const before = w.charter()
  await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))

  expect(await answerReadAs(w.$, 'no-change', 3)).toBe(true)

  expect(w.charter()).toEqual(before)
  expect(w.readAs()).toBeNull()
})

test('Not a change from a new-task reading restores the charter before it exactly (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  const before = w.charter()
  await readingOf(w, 'write the docs', said(newTask('Write docs')))

  expect(await answerReadAs(w.$, 'no-change', 3)).toBe(true)

  expect(w.charter()).toEqual(before)
})

test('Same task from an amendment restores the charter before it, with the consumed text forced (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  const before = w.charter()
  await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))

  expect(await answerReadAs(w.$, 'same-task', 3)).toBe(true)

  expect(w.charter()).toMatchObject({
    id: before?.id,
    rev: 1,
    request: 'build the parser',
    pendingText: ['also update the tests'],
    forcedReading: 'amendment',
  })
  expect(w.readAs()).toBeNull()
})

test('New task from a new-task reading: a fresh rev-0 charter holds the consumed text (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  const old = w.charter()
  await readingOf(w, 'write the docs', said(newTask('Write docs')))

  expect(await answerReadAs(w.$, 'new-task', 9)).toBe(true)

  expect(w.charter()).toMatchObject({ rev: 0, request: '', pendingText: ['write the docs'], createdAt: 9 })
  expect(w.charter()?.id).not.toBe(old?.id)
  expect(w.readAs()).toBeNull()
})

test('OK from a new-task reading clears it and changes nothing (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  await readingOf(w, 'write the docs', said(newTask('Write docs')))
  const shown = w.charter()

  expect(await answerReadAs(w.$, 'accept', 3)).toBe(false)

  expect(w.charter()).toEqual(shown)
  expect(w.readAs()).toBeNull()
})

test('a prompt delivered after a reading blocks every correction, which leaves the pending text and clears the line (FR-CH-10)', async () => {
  for (const choice of ['new-task', 'same-task', 'no-change', 'accept'] as const) {
    const w = world()
    await withTask(w)
    await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))
    await appendDelivered(w.$, 'and the docs too', 2)
    const shown = w.charter()

    expect(await answerReadAs(w.$, choice, 3)).toBe(false)

    expect(w.charter()).toEqual(shown)
    expect(w.charter()?.pendingText).toEqual(['and the docs too'])
    expect(w.readAs()).toBeNull()
  }
})

test('a reading expires ten minutes after it was recorded, with no redraw (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))

  w.setNow(599_999)
  await w.flush()
  expect(w.readAs()).not.toBeNull()

  w.setNow(600_000)
  await w.flush()
  expect(w.readAs()).toBeNull()
})

test('an expiry clears only its own reading: a newer reading keeps the line (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))
  w.setNow(300_000)
  await readingOf(w, 'and the docs', said(amendment('Build parser, tests and docs')))
  const newer = w.readAs()

  w.setNow(600_000)
  await w.flush()
  expect(w.readAs()).toEqual(newer)

  w.setNow(900_000)
  await w.flush()
  expect(w.readAs()).toBeNull()
})

test('a correction on a reading past ten minutes changes nothing and clears the line (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))
  const shown = w.charter()

  expect(await answerReadAs(w.$, 'no-change', 600_001)).toBe(false)

  expect(w.charter()).toEqual(shown)
  expect(w.readAs()).toBeNull()
  expect(w.logs).toContain('stayontarget: read-as correction skipped: reading expired')
})

test('a reading whose write is in flight when a main turn starts is not shown (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  await onMainTurnStart(w.$, 'also update the tests', 1)
  const release = w.hold(readAsAtom.ref)
  const pending = ensureCharter(w.$, cfg, 0)
  await w.answer(said(amendment('Build parser and its tests')))
  // The commit lands and its reading write waits at the hold: the charter is the one the reading committed.
  for (let turn = 0; turn < 5; turn++) await w.flush()
  expect(w.charter()).toMatchObject({ rev: 2, pendingText: [] })
  expect(w.readAs()).toBeNull()

  await onMainTurnStart(w.$, 'and something else', 2)
  release()
  await pending
  await w.flush()

  expect(w.readAs()).toBeNull()
})

test('a correction held on its charter write leaves a newer reading in place (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))
  const release = w.hold(charterAtom.ref)
  const correction = answerReadAs(w.$, 'no-change', 3)
  await w.flush()

  await readingOf(w, 'write the docs', said(newTask('Write docs')))
  const newer = w.readAs()
  expect(newer?.reading).toBe('new-task')

  release()
  expect(await correction).toBe(false)
  await w.flush()

  expect(w.readAs()).toEqual(newer)
})

test('OK clears the reading and changes nothing (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))
  const shown = w.charter()

  expect(await answerReadAs(w.$, 'accept', 3)).toBe(false)

  expect(w.charter()).toEqual(shown)
  expect(w.readAs()).toBeNull()
})

test('a correction after the charter moved on clears the reading, leaves the charter, and logs it (FR-CH-10)', async () => {
  const w = world()
  await withTask(w)
  await readingOf(w, 'also update the tests', said(amendment('Build parser and its tests')))
  w.bump(charter => ({ ...charter, rev: charter.rev + 1 }))
  const moved = w.charter()

  expect(await answerReadAs(w.$, 'new-task', 3)).toBe(false)

  expect(w.charter()).toEqual(moved)
  expect(w.readAs()).toBeNull()
  expect(w.logs).toContain('stayontarget: read-as correction skipped: charter changed')
})

test('a person edit made before a reading survives Not a change, as the charter before it stored it (FR-CH-10, FR-CH-8)', async () => {
  const w = world()
  await withTask(w)
  await editGoal(w.$, 'Only the parser')
  const edited = w.charter()
  await readingOf(w, 'also update the tests', said(amendment('Model goal', ['src/model.ts'])))

  await answerReadAs(w.$, 'no-change', 3)

  expect(w.charter()).toEqual(edited)
  expect(w.charter()?.goal).toBe('Only the parser')
})
