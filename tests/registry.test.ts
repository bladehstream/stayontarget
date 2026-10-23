import { expect, test } from 'claude-code/testing'

import type { Decision } from '../src/judge'
import {
  awaitVerdict,
  forgetVerdict,
  hasVerdict,
  peekSettled,
  startVerdict,
  sweep,
} from '../src/registry'

const decided: Decision = { verdict: 'in-scope', reason: 'ok', source: 'judge', charterId: 'c1', charterRev: 1, charterHead: 'fix the parser' }
const INTERNAL: Decision = { verdict: 'unchecked', reason: 'internal error', source: 'none', charterId: null, charterRev: 0, charterHead: null }
const NEVER = () => new Promise<void>(() => {})
const UNSETTLED = () => new Promise<Decision>(() => {})

// The registry is module state shared by the tests of this file: each test starts from an empty registry.
function reset(): void {
  sweep(Number.MAX_SAFE_INTEGER)
}

test('a missing verdict is missing at once, with no wait (FR-VD-7)', async () => {
  reset()
  const waits: number[] = []

  expect(
    await awaitVerdict('nobody', 8000, ms => {
      waits.push(ms)
      return NEVER()
    }),
  ).toBe('missing')
  expect(waits).toEqual([])
})

test('a verdict that settles within the wait is returned (FR-VD-7)', async () => {
  reset()
  startVerdict('t1', Promise.resolve(decided), 0)

  expect(await awaitVerdict('t1', 7000, NEVER)).toEqual(decided)
})

test('the wait is aborted once the verdict settles first, so its timer does not outlive the call (FR-VD-7)', async () => {
  reset()
  startVerdict('t1b', Promise.resolve(decided), 0)
  let handed: AbortSignal | undefined
  const waits: number[] = []

  expect(
    await awaitVerdict('t1b', 7000, (ms, signal) => {
      waits.push(ms)
      handed = signal
      return NEVER()
    }),
  ).toEqual(decided)
  expect(waits).toEqual([7000])
  expect(handed?.aborted).toBe(true)
})

test('the wait is aborted when it ends pending too (FR-VD-7)', async () => {
  reset()
  startVerdict('t1c', UNSETTLED(), 0)
  let handed: AbortSignal | undefined

  expect(
    await awaitVerdict('t1c', 7000, (_ms, signal) => {
      handed = signal
      return Promise.resolve()
    }),
  ).toBe('pending')
  expect(handed?.aborted).toBe(true)
})

test('a verdict still running when the wait ends is pending, and the wait is the one asked for (FR-VD-7)', async () => {
  reset()
  startVerdict('t2', NEVER().then(() => decided), 0)
  const waits: number[] = []

  expect(
    await awaitVerdict('t2', 7000, ms => {
      waits.push(ms)
      return Promise.resolve()
    }),
  ).toBe('pending')
  expect(waits).toEqual([7000])
  expect(hasVerdict('t2')).toBe(true)
})

test('a rejected verdict settles as unchecked with internal error, and does not escape (FR-VD-5, FR-VD-7)', async () => {
  reset()
  const failing = Promise.reject(new Error('boom'))
  startVerdict('t3', failing, 0)

  expect(await awaitVerdict('t3', 7000, NEVER)).toEqual(INTERNAL)
  expect(peekSettled('t3')).toEqual(INTERNAL)
})

test('a settled verdict is returned at once, without a wait (FR-VD-7)', async () => {
  reset()
  let settle: (decision: Decision) => void = () => {}
  const running = new Promise<Decision>(resolve => {
    settle = resolve
  })
  startVerdict('t4', running, 0)
  expect(peekSettled('t4')).toBeUndefined()

  settle(decided)
  await running
  const waits: number[] = []

  expect(
    await awaitVerdict('t4', 7000, ms => {
      waits.push(ms)
      return NEVER()
    }),
  ).toEqual(decided)
  expect(peekSettled('t4')).toEqual(decided)
  expect(waits).toEqual([])
})

test('forgetting a verdict removes its entry (FR-VD-7)', async () => {
  reset()
  startVerdict('t5', Promise.resolve(decided), 0)

  forgetVerdict('t5')

  expect(hasVerdict('t5')).toBe(false)
  expect(await awaitVerdict('t5', 7000, NEVER)).toBe('missing')
})

test('sweep removes only the entries older than 60 s, settled or not (FR-VD-7)', async () => {
  reset()
  startVerdict('old', UNSETTLED(), 0)
  startVerdict('settled', Promise.resolve(decided), 0)
  startVerdict('young', UNSETTLED(), 30000)

  expect(sweep(60000)).toBe(0)
  expect(sweep(60001)).toBe(2)
  expect(hasVerdict('old')).toBe(false)
  expect(hasVerdict('settled')).toBe(false)
  expect(hasVerdict('young')).toBe(true)
})

test('starting a verdict sweeps the entries older than 60 s (FR-VD-7)', async () => {
  reset()
  startVerdict('before', UNSETTLED(), 0)

  startVerdict('after', UNSETTLED(), 70000)

  expect(hasVerdict('before')).toBe(false)
  expect(hasVerdict('after')).toBe(true)
})
