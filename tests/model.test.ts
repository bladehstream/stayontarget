import { expect, test } from 'claude-code/testing'
import type { ModelCompleteRequest, ModelCompleteResult, ModelTextBlock } from 'claude-code'

import { callModel, getModelStats, parseJsonObject } from '../src/model'
import type { ModelDollar } from '../src/model'

const USAGE = { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const ABORTED: ModelCompleteResult = { isAnswered: false, reason: 'aborted', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
const REQ = { model: 'haiku', instructions: 'INSTRUCTIONS', body: 'BODY', maxTokens: 400, deadlineMs: 8000 }
const DONE: ModelCompleteResult = { isAnswered: true, text: 'done', usage: USAGE }

type Complete = (request: ModelCompleteRequest) => Promise<ModelCompleteResult>

// A fake `$` with the nouns this module uses. The clock moves only when the test moves it; by default model calls are
// held until the test answers them, and a call with a timeoutMs is cut (resolves aborted) when that much time passes.
// The test kit's own `$` has no clock or model, so the module is driven through this fake.
function world(options: { model?: Complete; refusing?: () => boolean } = {}) {
  let clock = 0
  const sleeps: { due: number; wake: () => void; signal?: AbortSignal }[] = []
  const holds: { request: ModelCompleteRequest; answer: (reply: ModelCompleteResult) => void }[] = []

  const dropSleep = (entry: (typeof sleeps)[number]) => {
    const index = sleeps.indexOf(entry)
    if (index !== -1) sleeps.splice(index, 1)
  }

  const holding: Complete = request => {
    if (options.refusing?.()) return Promise.reject(new Error('boom'))
    return new Promise<ModelCompleteResult>(resolve => {
      holds.push({ request, answer: resolve })
      if (request.timeoutMs !== undefined) sleeps.push({ due: clock + request.timeoutMs, wake: () => resolve(ABORTED) })
    })
  }

  const $ = {
    clock: {
      now: async () => clock,
      sleep: (ms: number, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          const signal = options?.signal
          const entry = { due: clock + ms, wake: resolve, signal }
          sleeps.push(entry)
          signal?.addEventListener(
            'abort',
            () => {
              dropSleep(entry)
              reject(new Error('sleep aborted'))
            },
            { once: true },
          )
        }),
    },
    model: { complete: options.model ?? holding },
  } as unknown as ModelDollar

  // Lets every chained continuation run: the module's promises settle within a few dozen microtask turns.
  const flush = async () => {
    for (let turn = 0; turn < 100; turn++) await Promise.resolve()
  }

  // Moves the clock on, waking each wait that comes due in order.
  async function advance(ms: number): Promise<void> {
    const target = clock + ms
    for (;;) {
      const next = sleeps.filter(s => s.due <= target).sort((a, b) => a.due - b.due)[0]
      if (next === undefined) break
      clock = next.due
      dropSleep(next)
      next.wake()
      await flush()
    }
    clock = target
    await flush()
  }

  return { $, holds, flush, advance }
}

const bodyOf = (request: ModelCompleteRequest): string =>
  (request.prompt as readonly ModelTextBlock[])[1]?.text ?? ''

test('at most three calls are in flight and the rest wait in arrival order (FR-VD-6)', async () => {
  const w = world()
  const calls = [1, 2, 3, 4, 5].map(n => callModel(w.$, { ...REQ, body: `call-${n}`, deadlineMs: 60000 }))
  await w.flush()
  expect(w.holds.map(h => bodyOf(h.request))).toEqual(['call-1', 'call-2', 'call-3'])
  expect(getModelStats()).toEqual({ inFlight: 3, queued: 2 })

  w.holds[0]?.answer(DONE)
  await w.flush()
  expect(w.holds.map(h => bodyOf(h.request))).toEqual(['call-1', 'call-2', 'call-3', 'call-4'])
  expect(getModelStats()).toEqual({ inFlight: 3, queued: 1 })

  w.holds[1]?.answer(DONE)
  w.holds[2]?.answer(DONE)
  await w.flush()
  expect(w.holds.map(h => bodyOf(h.request))).toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5'])

  for (const hold of w.holds.slice(3)) hold.answer(DONE)
  expect(await Promise.all(calls)).toHaveLength(5)
  expect(getModelStats()).toEqual({ inFlight: 0, queued: 0 })
})

test('a call that waits out its budget in the queue reports queue-timeout without calling the model', async () => {
  const w = world()
  const held = [1, 2, 3].map(n => callModel(w.$, { ...REQ, body: `held-${n}`, deadlineMs: 60000 }))
  await w.flush()
  const queued = callModel(w.$, { ...REQ, body: 'queued', deadlineMs: 100 })
  await w.flush()
  expect(getModelStats().queued).toBe(1)

  await w.advance(100)
  expect(await queued).toEqual({
    ok: false,
    reason: 'queue-timeout',
    detail: 'no model slot within 100 ms',
    inputTokens: 0,
    outputTokens: 0,
  })
  expect(w.holds.length).toBe(3)
  expect(getModelStats()).toEqual({ inFlight: 3, queued: 0 })

  for (const hold of w.holds) hold.answer(DONE)
  await Promise.all(held)
  expect(getModelStats()).toEqual({ inFlight: 0, queued: 0 })
})

test('a waiter that timed out does not take a slot from the next live waiter', async () => {
  const w = world()
  const held = [1, 2, 3].map(n => callModel(w.$, { ...REQ, body: `held-${n}`, deadlineMs: 60000 }))
  await w.flush()
  const expired = callModel(w.$, { ...REQ, body: 'expired', deadlineMs: 50 })
  const live = callModel(w.$, { ...REQ, body: 'live', deadlineMs: 60000 })
  await w.flush()

  await w.advance(50)
  expect(await expired).toMatchObject({ reason: 'queue-timeout' })
  expect(getModelStats()).toEqual({ inFlight: 3, queued: 1 })

  w.holds[0]?.answer(DONE)
  await w.flush()
  expect(w.holds.map(h => bodyOf(h.request))).toEqual(['held-1', 'held-2', 'held-3', 'live'])

  for (const hold of w.holds.slice(1)) hold.answer(DONE)
  await Promise.all([...held, live])
  expect(getModelStats()).toEqual({ inFlight: 0, queued: 0 })
})

test('the time spent queueing comes off the timeout the model call is given (FR-VD-6)', async () => {
  const w = world()
  const held = [1, 2, 3].map(n => callModel(w.$, { ...REQ, body: `held-${n}`, deadlineMs: 60000 }))
  await w.flush()
  const queued = callModel(w.$, { ...REQ, body: 'queued', deadlineMs: 100 })
  await w.flush()

  await w.advance(60)
  w.holds[0]?.answer(DONE)
  await w.flush()
  expect(w.holds[3]?.request.timeoutMs).toBe(40)

  w.holds[3]?.answer(DONE)
  expect(await queued).toEqual({ ok: true, text: 'done', inputTokens: 12, outputTokens: 34 })
  for (const hold of w.holds.slice(1, 3)) hold.answer(DONE)
  await Promise.all(held)
})

test('the call sends instructions and body as a cached and an uncached block, at low effort with the token cap', async () => {
  const seen: ModelCompleteRequest[] = []
  const w = world({
    model: async request => {
      seen.push(request)
      return DONE
    },
  })

  await callModel(w.$, REQ)

  expect(seen).toEqual([
    {
      model: 'haiku',
      prompt: [{ text: 'INSTRUCTIONS', cache: true }, { text: 'BODY' }],
      maxTokens: 400,
      effort: 'low',
      timeoutMs: 8000,
    },
  ])
})

// Runs one call with the model answering `reply` at once, or throwing, and returns the outcome.
function outcomeOf(reply: ModelCompleteResult | { throws: string }): Promise<unknown> {
  return callModel(
    world({
      model: async () => {
        if ('throws' in reply) throw new Error(reply.throws)
        return reply
      },
    }).$,
    REQ,
  )
}

test('an answer with text is ok, with its token counts', async () => {
  expect(await outcomeOf({ isAnswered: true, text: '{"kind":"chit-chat"}', usage: USAGE })).toEqual({
    ok: true,
    text: '{"kind":"chit-chat"}',
    inputTokens: 12,
    outputTokens: 34,
  })
})

test('input tokens include the cached input, read and written (NFR-3)', async () => {
  expect(
    await outcomeOf({
      isAnswered: true,
      text: '{"kind":"chit-chat"}',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    }),
  ).toMatchObject({ ok: true, inputTokens: 130, outputTokens: 5 })
})

test('an answer whose text is blank is empty-reply, not ok', async () => {
  expect(await outcomeOf({ isAnswered: true, text: '  ', usage: USAGE })).toMatchObject({
    ok: false,
    reason: 'empty-reply',
  })
})

test('a reply that carries no text is empty-reply, and its tokens still count', async () => {
  expect(await outcomeOf({ isAnswered: false, reason: 'empty-reply', usage: USAGE })).toMatchObject({
    ok: false,
    reason: 'empty-reply',
    inputTokens: 12,
    outputTokens: 34,
  })
})

test('an API error carries its status and error kind, and its tokens', async () => {
  expect(
    await outcomeOf({ isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: USAGE }),
  ).toEqual({ ok: false, reason: 'api-error', detail: 'status 429 rate_limit', inputTokens: 12, outputTokens: 34 })
})

test('an API error with no response says so in its detail', async () => {
  expect(
    await outcomeOf({ isAnswered: false, reason: 'api-error', status: null, error: 'unknown', usage: USAGE }),
  ).toEqual({ ok: false, reason: 'api-error', detail: 'status none unknown', inputTokens: 12, outputTokens: 34 })
})

test('an abort that is not the timeout is aborted', async () => {
  expect(await outcomeOf({ isAnswered: false, reason: 'aborted', usage: USAGE })).toMatchObject({
    ok: false,
    reason: 'aborted',
  })
})

test('an abort once the budget has run out is timeout (FR-VD-6)', async () => {
  const w = world()
  const outcome = callModel(w.$, { ...REQ, deadlineMs: 8000 })
  await w.flush()
  await w.advance(8000)

  expect(await outcome).toMatchObject({ ok: false, reason: 'timeout' })
})

test('a rejected model call is rejected with its message, and frees its slot', async () => {
  const outcome = await outcomeOf({ throws: 'refused the request' })

  expect(outcome).toMatchObject({ ok: false, reason: 'rejected', detail: 'refused the request' })
  expect(getModelStats()).toEqual({ inFlight: 0, queued: 0 })
})

test('after rejections, later calls still get the three slots', async () => {
  let refuse = true
  const w = world({ refusing: () => refuse })
  // Four rejections in a row: each one must free its slot, or the three-slot limit would be spent.
  for (let i = 0; i < 4; i++) await callModel(w.$, REQ)
  refuse = false

  const calls = [1, 2, 3].map(n => callModel(w.$, { ...REQ, body: `ok-${n}`, deadlineMs: 60000 }))
  await w.flush()
  expect(getModelStats()).toEqual({ inFlight: 3, queued: 0 })
  for (const hold of w.holds) hold.answer(DONE)
  expect(await Promise.all(calls)).toHaveLength(3)
})

test('parseJsonObject takes the object out of fences and prose', () => {
  expect(parseJsonObject('{"kind":"chit-chat"}')).toEqual({ kind: 'chit-chat' })
  expect(parseJsonObject('```json\n{"kind":"amendment","goal":"x"}\n```')).toEqual({ kind: 'amendment', goal: 'x' })
  expect(parseJsonObject('Sure, here it is: {"a":1} hope that helps')).toEqual({ a: 1 })
})

test('parseJsonObject ignores braces inside strings and takes the first object that parses', () => {
  expect(parseJsonObject('Sure: {"x": "}{"} thanks')).toEqual({ x: '}{' })
  expect(parseJsonObject('{ see below } then {"ok":true}')).toEqual({ ok: true })
})

test('parseJsonObject is null for invalid JSON, arrays and text without an object', () => {
  expect(parseJsonObject('no json here')).toBe(null)
  expect(parseJsonObject('{"a":1')).toBe(null)
  expect(parseJsonObject('{bad json}')).toBe(null)
  expect(parseJsonObject('[1,2,3]')).toBe(null)
  expect(parseJsonObject('')).toBe(null)
})
