import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code'

import type { Charter, Stats } from '../types'
import type { CharterDollar } from '../src/charter'
import { EMPTY_STATS, charterAtom, statsAtom } from '../src/state'

type Ref = { plugin: string; key: string; id?: string }
type Entry = { value: unknown; version: number }

// A fake `$` with the nouns the charter lifecycle and the judge use. The state is a versioned in-memory store that answers
// `get` and `set(…, { ifVersion })` as the engine does, so the real `read` and `update` run against it. Model calls are
// held until the test answers them, and the clock moves only when the test moves it. The test body's `$` has no `clock`,
// so the module is driven through this fake.
export function world() {
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
  const dispatchWaiters: (() => void)[] = []
  const logs: string[] = []
  let refusals = 0
  // Runs once, inside the next `set`, before its version check: a write that lands between update's read and write.
  let racing: (() => void) | null = null

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
        const held = new Promise<ModelCompleteResult>(resolve => {
          holds.push(resolve)
        })
        for (const wake of dispatchWaiters.splice(0)) wake()
        return held
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

  // Resolves once a model call is held unanswered. Waits on the call itself, so it also covers work that is not a
  // microtask (the SHA-256 of a fingerprint).
  async function dispatched(): Promise<void> {
    while (holds.length === 0) await new Promise<void>(wake => dispatchWaiters.push(wake))
  }

  // Answers the oldest held model call, once it has been dispatched.
  async function answer(reply: ModelCompleteResult): Promise<void> {
    await dispatched()
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
    dispatched,
    answer,
    race: (change: () => void) => {
      racing = change
    },
    bump: (change: (charter: Charter) => Charter) => {
      const current = store.get(charterKey)?.value as Charter | null | undefined
      if (current === null || current === undefined) throw new Error('no charter to bump')
      write(charterKey, change(current))
    },
    // Plants a value in the store at `ref`, as an earlier turn would have left it.
    seed: (ref: Ref, value: unknown) => {
      write(keyOf(ref), value)
    },
    refusals: () => refusals,
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
    stats: () => (store.get(statsKey)?.value as Stats | undefined) ?? EMPTY_STATS,
  }
}

export type World = ReturnType<typeof world>
