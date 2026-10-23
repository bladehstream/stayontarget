import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Allowance, Charter, DriftEvent, Stats } from '../types'

import { __atoms as persistAtoms, fitSnapshot, isSnapshot, MAX_SESSIONS, resetSessionState, restore, saveNow, schedulePersist, sessionEndDeadline, SNAPSHOT_MAX_BYTES } from '../src/persist'
import type { PersistDollar, Snapshot } from '../src/persist'
import * as shared from '../src/state'
import { EMPTY_STATS, EVENTS_CAP, charterAtom, eventsAtom, statsAtom } from '../src/state'

// ---- fixtures ----------------------------------------------------------------------------------------------------------

const CHARTER: Charter = {
  id: 'c1',
  rev: 1,
  request: 'fix the parser',
  goal: null,
  inScope: ['src/parser.ts'],
  outOfScope: [],
  distilled: true,
  editedFields: [],
  pendingText: [],
  createdAt: 100,
}

function drift(id: string, at = 200): DriftEvent {
  return {
    id,
    toolUseId: `tool-${id}`,
    charterId: 'c1',
    charterRev: 1,
    mainTurnId: 'turn-1',
    agentId: null,
    tool: 'Edit',
    target: 'docs/notes.md',
    verdict: 'drift',
    reason: 'touches an unrelated file',
    source: 'judge',
    action: 'note',
    status: 'open',
    at,
  }
}

const STATS: Stats = { ...EMPTY_STATS, judged: 3, inputTokens: 90 }

function snapshot(sessionId: string, over: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 1,
    sessionId,
    savedAt: 300,
    charter: CHARTER,
    events: [drift('e1')],
    allowances: [],
    stats: STATS,
    ...over,
  }
}

const bytesOf = (s: unknown) => new TextEncoder().encode(JSON.stringify(s)).length
const SESSION = { cwd: 'C:\\repo', surface: 'desktop' as const, isInteractive: true }

// ---- a fake `$` with a store, for the unit tests -----------------------------------------------------------------------

type Ref = { plugin: string; key: string; id?: string }
type Entry = { value: unknown; version: number }

// A versioned state as the engine keeps it, a store that copies what it is given, a clock that moves only when the test
// moves it, and the timers and waits on it. `failing` makes a store write reject; `hanging` makes it never answer.
function world() {
  let clock = 0
  // Every wait the clock holds: a timer's fire and a sleep's wake, each run once it is due.
  const waits: { due: number; run: () => void }[] = []
  const state = new Map<string, Entry>()
  const store = new Map<string, unknown>()
  const logs: string[] = []
  const statuses: string[] = []
  const sets: string[] = []
  const deletes: string[] = []
  // The store's operations in order: `set:<key>` and `delete:<key>`.
  const ops: string[] = []
  let failing = false
  // A gate per key: the next write of that key waits until its release runs. `failOnce` keys reject their next write.
  const gates = new Map<string, Promise<void>>()
  const failOnce = new Set<string>()
  const keyOf = (ref: Ref) => [ref.plugin, ref.key, ref.id ?? ''].join('/')
  const copy = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

  const $ = {
    state: {
      get: async (ref: Ref) => {
        const entry = state.get(keyOf(ref))
        return { value: entry?.value, version: entry?.version ?? 0 }
      },
      set: async (ref: Ref, value: unknown, options?: { ifVersion?: number }) => {
        const key = keyOf(ref)
        const version = state.get(key)?.version ?? 0
        if (options?.ifVersion !== undefined && options.ifVersion !== version) return { isSet: false, version }
        state.set(key, { value, version: version + 1 })
        return { isSet: true, version: version + 1 }
      },
    },
    store: {
      get: async (key: string) => copy(store.get(key)),
      set: async (key: string, value: unknown) => {
        if (failing) throw new Error('disk full')
        if (failOnce.delete(key)) throw new Error('index write refused')
        const gate = gates.get(key)
        if (gate !== undefined) {
          gates.delete(key)
          await gate
        }
        sets.push(key)
        ops.push(`set:${key}`)
        store.set(key, copy(value))
      },
      delete: async (key: string) => {
        deletes.push(key)
        ops.push(`delete:${key}`)
        store.delete(key)
      },
      keys: async () => [...store.keys()],
    },
    clock: {
      now: async () => clock,
      sleep: (ms: number, options?: { signal?: AbortSignal }) =>
        new Promise<void>((resolve, reject) => {
          const entry = { due: clock + ms, run: resolve }
          waits.push(entry)
          options?.signal?.addEventListener(
            'abort',
            () => {
              const index = waits.indexOf(entry)
              if (index !== -1) waits.splice(index, 1)
              reject(new Error('sleep aborted'))
            },
            { once: true },
          )
        }),
      after: (ms: number, fire: () => void) => {
        const entry = { due: clock + ms, run: fire }
        waits.push(entry)
        return {
          cancel: () => {
            const index = waits.indexOf(entry)
            if (index !== -1) waits.splice(index, 1)
          },
        }
      },
    },
    session: { id: async () => 'session-1' },
    ui: {
      log: (text: string) => {
        logs.push(text)
      },
      status: (text: string) => {
        statuses.push(text)
      },
    },
  } as unknown as PersistDollar

  // Lets every chained continuation run.
  const flush = async () => {
    for (let turn = 0; turn < 100; turn++) await Promise.resolve()
  }

  return {
    $,
    logs,
    statuses,
    sets,
    deletes,
    flush,
    fail: (on: boolean) => {
      failing = on
    },
    // Holds the next write of `key` until the returned release runs; the write then lands (a late write, or a hang).
    hold: (key: string): (() => void) => {
      let release: () => void = () => undefined
      gates.set(key, new Promise<void>(resolve => (release = resolve)))
      return () => release()
    },
    // Refuses the next write of `key` only.
    refuseOnce: (key: string) => {
      failOnce.add(key)
    },
    ops,
    plant: (key: string, value: unknown) => {
      store.set(key, copy(value))
    },
    stored: (key: string) => copy(store.get(key)),
    storedKeys: () => [...store.keys()],
    value: (ref: Ref) => state.get(keyOf(ref))?.value,
    seed: (ref: Ref, value: unknown) => {
      state.set(keyOf(ref), { value, version: (state.get(keyOf(ref))?.version ?? 0) + 1 })
    },
    // Moves the clock to `ms`, running each wait that comes due on the way, in order.
    setNow: (ms: number) => {
      clock = ms
      for (;;) {
        const due = waits.filter(wait => wait.due <= clock).sort((a, b) => a.due - b.due)[0]
        if (due === undefined) break
        waits.splice(waits.indexOf(due), 1)
        due.run()
      }
    },
  }
}

// ---- pure: fitting and validating -----------------------------------------------------------------------------------------

test('a snapshot that fits is returned as it is (FR-ST-3)', () => {
  const s = snapshot('s1')
  expect(fitSnapshot(s)).toBe(s)
})

test('fitSnapshot drops the oldest events first and keeps the most events that fit (FR-ST-3)', () => {
  const events = Array.from({ length: EVENTS_CAP }, (_, i) => ({ ...drift(`e${i}`), reason: 'r'.repeat(1500) }))
  const s = snapshot('s1', { events })

  const fitted = fitSnapshot(s)

  expect(bytesOf(fitted)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
  const kept = fitted.events.length
  expect(kept).toBeGreaterThan(0)
  expect(kept).toBeLessThan(EVENTS_CAP)
  // The newest events are the ones kept, in order.
  expect(fitted.events).toEqual(events.slice(EVENTS_CAP - kept))
  // One more event, the next oldest, would not fit.
  expect(bytesOf({ ...s, events: events.slice(EVENTS_CAP - kept - 1) })).toBeGreaterThan(SNAPSHOT_MAX_BYTES)
})

test('fitSnapshot cuts the request to its head and tail when no events are left to drop (FR-ST-3)', () => {
  const request = `${'A'.repeat(2000)}${'B'.repeat(300000)}${'C'.repeat(2000)}`
  const s = snapshot('s1', { events: [drift('e1')], charter: { ...CHARTER, request } })

  const fitted = fitSnapshot(s)

  expect(bytesOf(fitted)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
  expect(fitted.events).toEqual([])
  expect(fitted.charter?.request.startsWith('A'.repeat(2000))).toBe(true)
  expect(fitted.charter?.request.endsWith('C'.repeat(2000))).toBe(true)
  expect(fitted.charter?.request.length).toBeLessThan(4100)
})

test('fitSnapshot drops the oldest allowances last, and keeps the newest that fit (FR-ST-3)', () => {
  const allowances: Allowance[] = Array.from({ length: 1000 }, (_, i) => ({
    charterId: 'c1',
    tool: 'Edit',
    target: `${i}-${'x'.repeat(400)}`,
    at: i,
  }))
  const s = snapshot('s1', { events: [], allowances })

  const fitted = fitSnapshot(s)

  expect(bytesOf(fitted)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
  expect(fitted.allowances.at(-1)).toEqual(allowances.at(-1))
  expect(fitted.allowances).toEqual(allowances.slice(1000 - fitted.allowances.length))
})

test('isSnapshot accepts a well-formed snapshot and a snapshot with no charter (FR-ST-3)', () => {
  expect(isSnapshot(snapshot('s1'))).toBe(true)
  expect(isSnapshot(snapshot('s1', { charter: null }))).toBe(true)
})

test('isSnapshot rejects a malformed snapshot in each of its fields (FR-ST-3)', () => {
  const bad: unknown[] = [
    null,
    'session',
    [],
    { ...snapshot('s1'), v: 2 },
    { ...snapshot('s1'), sessionId: 1 },
    { ...snapshot('s1'), savedAt: 'now' },
    { ...snapshot('s1'), savedAt: Number.NaN },
    { ...snapshot('s1'), charter: 'c1' },
    { ...snapshot('s1'), charter: { ...CHARTER, inScope: 'src' } },
    { ...snapshot('s1'), charter: { ...CHARTER, editedFields: ['request'] } },
    { ...snapshot('s1'), charter: { ...CHARTER, goal: 7 } },
    { ...snapshot('s1'), events: 'none' },
    { ...snapshot('s1'), events: [{ ...drift('e1'), verdict: 'bogus' }] },
    { ...snapshot('s1'), events: [{ ...drift('e1'), status: 'closed' }] },
    { ...snapshot('s1'), events: [{ ...drift('e1'), at: '200' }] },
    { ...snapshot('s1'), events: Array.from({ length: EVENTS_CAP + 1 }, (_, i) => drift(`e${i}`)) },
    { ...snapshot('s1'), allowances: [{ charterId: 1, tool: 'Edit', target: 'a', at: 1 }] },
    { ...snapshot('s1'), stats: { ...STATS, persistFailed: 'no' } },
    { ...snapshot('s1'), stats: { ...STATS, judged: undefined } },
  ]
  for (const candidate of bad) expect(isSnapshot(candidate)).toBe(false)
})

// ---- unit: the store, the index and the schedule, through the fake `$` -------------------------------------------------

test('the atoms this module declares match src/state.ts in ref and initial value', () => {
  const local = persistAtoms as Record<string, { ref: unknown; initial: unknown }>
  for (const [name, atom] of Object.entries(local)) {
    const want = shared[name as keyof typeof shared] as { ref: unknown; initial: unknown }
    expect(atom.ref).toEqual(want.ref)
    expect(atom.initial).toEqual(want.initial)
  }
})

test('save then restore brings the four atoms back under the same session (FR-ST-3, FR-ST-4)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  w.seed(eventsAtom.ref, [drift('e1')])
  w.seed(statsAtom.ref, STATS)

  expect(await saveNow(w.$, 's1')).toBe(true)
  const saved = w.stored('session:s1')
  expect(saved).toMatchObject({ v: 1, sessionId: 's1', charter: CHARTER })

  // A fresh session (no state ever written) takes the snapshot back.
  const fresh = world()
  fresh.plant('session:s1', saved)
  expect(await restore(fresh.$, 's1')).toBe(true)
  expect(fresh.value(charterAtom.ref)).toEqual(CHARTER)
  expect(fresh.value(eventsAtom.ref)).toEqual([drift('e1')])
  expect(fresh.value(statsAtom.ref)).toEqual(STATS)
})

test('a session whose state was cleared does not restore its old snapshot, even when the cleared state is initial (FR-ST-4)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  expect(await saveNow(w.$, 's')).toBe(true)

  // /stayontarget new: the charter is cleared and the write is kept, so the state is initial but written.
  await resetSessionState(w.$)
  expect(await restore(w.$, 's')).toBe(false)
  expect(w.value(charterAtom.ref)).toBe(null)
})

test('restore returns false for a missing, invalid or foreign snapshot and writes nothing (FR-ST-4)', async () => {
  const w = world()
  w.plant('session:bad', { v: 2 })
  w.plant('session:other', snapshot('someone-else'))

  expect(await restore(w.$, 'missing')).toBe(false)
  expect(await restore(w.$, 'bad')).toBe(false)
  expect(await restore(w.$, 'other')).toBe(false)
  expect(w.value(charterAtom.ref)).toBe(undefined)
})

test('the index keeps at most MAX_SESSIONS sessions and deletes the oldest keys (FR-ST-3)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  for (let i = 0; i <= MAX_SESSIONS; i++) {
    w.setNow(i * 10)
    await saveNow(w.$, `s${i}`)
  }

  const sessionKeys = w.storedKeys().filter(key => key.startsWith('session:'))
  expect(sessionKeys.length).toBe(MAX_SESSIONS)
  expect(w.deletes).toEqual(['session:s0'])
  expect(w.stored('session:s0')).toBe(undefined)
  const index = w.stored('index') as { sessionId: string; savedAt: number }[]
  expect(index.length).toBe(MAX_SESSIONS)
  expect(index[0]).toEqual({ sessionId: 's1', savedAt: 10 })
  expect(index.at(-1)).toEqual({ sessionId: 's20', savedAt: 200 })
})

test('two saves at once both stay in the index: the index is rewritten one save at a time (NFR-5)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)

  const both = await Promise.all([saveNow(w.$, 'a'), saveNow(w.$, 'b')])

  expect(both).toEqual([true, true])
  const index = w.stored('index') as { sessionId: string }[]
  expect(index.map(entry => entry.sessionId).sort()).toEqual(['a', 'b'])
})

test('a missing index is rebuilt from the keys, and the rebuilt sessions are evicted oldest first (FR-ST-3)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  for (let i = 0; i < MAX_SESSIONS; i++) w.plant(`session:old-${i}`, snapshot(`old-${i}`))
  w.plant('index', 'garbage')

  expect(await saveNow(w.$, 'new')).toBe(true)

  expect(w.deletes).toEqual(['session:old-0'])
  const index = w.stored('index') as { sessionId: string }[]
  expect(index.map(entry => entry.sessionId)).toEqual([...Array.from({ length: MAX_SESSIONS - 1 }, (_, i) => `old-${i + 1}`), 'new'])
})

test('a store that refuses a write sets persistFailed, logs it and returns false; the next save clears it (FR-ST-3, FR-RS-6)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)

  w.fail(true)
  expect(await saveNow(w.$, 's1')).toBe(false)
  expect(w.value(statsAtom.ref)).toMatchObject({ persistFailed: true })
  expect(w.logs.some(line => line.includes('snapshot not saved: disk full'))).toBe(true)
  expect(w.statuses.at(-1)).toBe('stayontarget: on target · not saved')

  w.fail(false)
  expect(await saveNow(w.$, 's1')).toBe(true)
  expect(w.value(statsAtom.ref)).toMatchObject({ persistFailed: false })
  expect(w.statuses.at(-1)).toBe('stayontarget: on target')
})

test('a store call that never answers fails the save at the deadline, and does not hang (NFR-1)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  const release = w.hold('session:s1')

  const saved = saveNow(w.$, 's1')
  // The save starts once the saves before it are done, a few turns on: its deadline is set then.
  await w.flush()
  w.setNow(1000)

  expect(await saved).toBe(false)
  expect(w.value(statsAtom.ref)).toMatchObject({ persistFailed: true })
  release()
  await w.flush()
})

test('a write that lands after its caller gave up is not overwritten by a newer save (FR-ST-3, NFR-5)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  const release = w.hold('session:a')

  const first = saveNow(w.$, 'a')
  await w.flush()
  w.setNow(1000)
  expect(await first).toBe(false)

  // The newer state is saved while the first write is still held; its write waits behind the first.
  w.seed(charterAtom.ref, { ...CHARTER, request: 'the newer request' })
  const second = saveNow(w.$, 'a')
  await w.flush()
  release()
  expect(await second).toBe(true)

  expect((w.stored('session:a') as Snapshot).charter?.request).toBe('the newer request')
  expect(w.ops.filter(op => op === 'set:session:a').length).toBe(2)
})

test('a save that waits in the queue keeps the state it was asked about, not the state when its write runs (FR-ST-4)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  const release = w.hold('session:other')
  const first = saveNow(w.$, 'other')
  await w.flush()
  const second = saveNow(w.$, 'a')
  await w.flush()

  // The session moves on while `a` waits: a /clear resets the state, and different state comes in.
  await resetSessionState(w.$)
  w.seed(charterAtom.ref, { ...CHARTER, request: 'the new session' })
  release()

  await first
  expect(await second).toBe(true)
  expect((w.stored('session:a') as Snapshot).charter?.request).toBe('fix the parser')
})

test('a CJK request and sixteen CJK pending entries are fitted under the cap (FR-ST-3)', () => {
  const cjk = '中'
  const s = snapshot('s1', {
    events: [],
    allowances: [],
    charter: { ...CHARTER, request: cjk.repeat(6000), pendingText: Array.from({ length: 16 }, () => cjk.repeat(4000)) },
  })

  const fitted = fitSnapshot(s)

  expect(bytesOf(fitted)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
  expect(fitted.charter?.pendingText.length).toBeLessThan(16)
  expect(fitted.charter?.pendingText.at(-1)).toBe(cjk.repeat(4000))
})

test('a goal too big for the cap is cut to 200 characters (FR-ST-3)', () => {
  const s = snapshot('s1', {
    events: [],
    allowances: [],
    charter: { ...CHARTER, goal: '中'.repeat(100000), pendingText: [] },
  })

  const fitted = fitSnapshot(s)

  expect(bytesOf(fitted)).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
  expect(fitted.charter?.goal?.length).toBe(200)
})

test('a snapshot still over the cap is not written, and sets persistFailed (FR-ST-3)', async () => {
  const w = world()
  w.seed(charterAtom.ref, { ...CHARTER, id: 'x'.repeat(SNAPSHOT_MAX_BYTES) })

  expect(await saveNow(w.$, 'big')).toBe(false)

  expect(w.storedKeys().filter(key => key.startsWith('session:'))).toEqual([])
  expect(w.value(statsAtom.ref)).toMatchObject({ persistFailed: true })
  expect(w.logs.some(line => line.includes('over the store cap'))).toBe(true)
})

test('a save of a session whose state is now initial removes its snapshot, and resume restores nothing (FR-ST-3, FR-CH-8)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  expect(await saveNow(w.$, 's')).toBe(true)
  expect(w.stored('session:s')).toBeDefined()

  // The state empties, as `/stayontarget new` before any tool call leaves it: the save keeps nothing.
  await resetSessionState(w.$)
  expect(await saveNow(w.$, 's')).toBe(true)

  expect(w.stored('session:s')).toBe(undefined)
  const index = w.stored('index') as { sessionId: string }[]
  expect(index.some(entry => entry.sessionId === 's')).toBe(false)
  expect(await restore(w.$, 's')).toBe(false)
})

test('ten saves requested while one runs leave at most two writes after it (NFR-5)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  const release = w.hold('session:a')
  const saves = [saveNow(w.$, 'a')]
  await w.flush()
  for (let i = 0; i < 9; i++) saves.push(saveNow(w.$, 'a'))
  await w.flush()

  release()
  const results = await Promise.all(saves)

  expect(results.every(result => result === true)).toBe(true)
  expect(w.sets.filter(key => key === 'session:a').length).toBe(2)
})

test('a write that never settles is given up after 30 s, and the next save reaches the store (FR-ST-3, NFR-5)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  w.hold('session:a')
  const hung = saveNow(w.$, 'a')
  await w.flush()
  w.setNow(1000)
  expect(await hung).toBe(false)

  saveNow(w.$, 'b')
  await w.flush()
  w.setNow(30000)
  await w.flush()

  expect(w.sets).toContain('session:b')
})

test('the deleted sessions are gone before the new snapshot is written, so a full store has room for it (FR-ST-3)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  const big = { ...CHARTER, request: 'x'.repeat(SNAPSHOT_MAX_BYTES - 4096) }
  const index: { sessionId: string; savedAt: number }[] = []
  for (let i = 0; i < MAX_SESSIONS; i++) {
    w.plant(`session:s${i}`, { ...snapshot(`s${i}`), charter: big })
    index.push({ sessionId: `s${i}`, savedAt: i })
  }
  w.plant('index', index)
  w.setNow(1000)

  expect(await saveNow(w.$, 'new')).toBe(true)

  expect(w.ops.indexOf('delete:session:s0')).toBeGreaterThanOrEqual(0)
  expect(w.ops.indexOf('delete:session:s0')).toBeLessThan(w.ops.indexOf('set:session:new'))
  expect(w.storedKeys().filter(key => key.startsWith('session:')).length).toBe(MAX_SESSIONS)
})

test('a snapshot whose index write was refused is added to the index later, and at most MAX_SESSIONS stay (FR-ST-3)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  w.refuseOnce('index')
  expect(await saveNow(w.$, 'orphan')).toBe(false)
  expect(w.stored('session:orphan')).toBeDefined()

  for (let i = 0; i < MAX_SESSIONS; i++) {
    w.setNow(10 + i * 10)
    await saveNow(w.$, `b${i}`)
  }

  const sessionKeys = w.storedKeys().filter(key => key.startsWith('session:'))
  expect(sessionKeys.length).toBeLessThanOrEqual(MAX_SESSIONS)
  expect(w.stored('session:orphan')).toBe(undefined)
})

test('a save gives up at its deadline or when its dispatch is cut, and the write still lands in order (FR-ST-4, NFR-1)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  const release = w.hold('session:cut')
  const cut = new AbortController()

  const saved = saveNow(w.$, 'cut', 60000, cut.signal)
  await w.flush()
  cut.abort()
  expect(await saved).toBe(false)
  expect(w.value(statsAtom.ref)).toMatchObject({ persistFailed: true })

  release()
  await w.flush()
  expect(w.stored('session:cut')).toBeDefined()
})

test('restore leaves live state alone: a session start again after a reload does not roll back newer state (FR-ST-4)', async () => {
  const w = world()
  w.plant('session:s', snapshot('s', { charter: { ...CHARTER, request: 'the older request' }, events: [] }))
  const newer = { ...CHARTER, request: 'the newer request' }
  w.seed(charterAtom.ref, newer)
  w.seed(eventsAtom.ref, [drift('live')])

  expect(await restore(w.$, 's')).toBe(false)

  expect(w.value(charterAtom.ref)).toEqual(newer)
  expect(w.value(eventsAtom.ref)).toEqual([drift('live')])
})

test('a save while the state is initial writes nothing: what a /clear leaves behind is not kept (FR-ST-4)', async () => {
  const w = world()

  expect(await saveNow(w.$, 'empty')).toBe(true)

  expect(w.storedKeys()).toEqual([])
})

test('the session.end save gets the hook\'s remaining budget less a margin, or a second when none is metered (FR-ST-4)', () => {
  expect(sessionEndDeadline(undefined)).toBe(1000)
  expect(sessionEndDeadline(Number.POSITIVE_INFINITY)).toBe(1000)
  expect(sessionEndDeadline(1500)).toBe(1300)
  expect(sessionEndDeadline(100)).toBe(0)
})

test('schedulePersist coalesces changes within 2 s into one save of the session (FR-ST-3)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)

  schedulePersist(w.$)
  w.setNow(500)
  schedulePersist(w.$)
  w.setNow(1500)
  schedulePersist(w.$)
  await w.flush()
  expect(w.sets.filter(key => key === 'session:session-1')).toEqual([])

  w.setNow(2000)
  await w.flush()
  expect(w.sets.filter(key => key === 'session:session-1')).toEqual(['session:session-1'])
})

test('resetSessionState puts the four atoms back to their initial values (FR-ST-4)', async () => {
  const w = world()
  w.seed(charterAtom.ref, CHARTER)
  w.seed(eventsAtom.ref, [drift('e1')])
  w.seed(statsAtom.ref, STATS)

  await resetSessionState(w.$)

  expect(w.value(charterAtom.ref)).toBe(null)
  expect(w.value(eventsAtom.ref)).toEqual([])
  expect(w.value(statsAtom.ref)).toEqual(EMPTY_STATS)
})

// ---- through the plugin's hooks, on the kit ----------------------------------------------------------------------------

// The store beneath the plugin, as a test sees it: what is stored under each key, and the writes it was asked for. A
// refused write is a throw from `store.set` (FR-ST-3).
function storeBeneath(on: On, seed: Record<string, unknown>) {
  const entries = new Map(Object.entries(seed))
  const writes: string[] = []
  const refusing = { on: false }
  // A call on `$` is answered with `{ value }`; a refused write with `{ deny }`, which rejects the call (FR-ST-3).
  on('store.get', (_, e) => ({ value: entries.get(e.key) }))
  on('store.keys', () => ({ value: [...entries.keys()] }))
  on('store.delete', (_, e) => {
    entries.delete(e.key)
    return { value: undefined }
  })
  on('store.set', (_, e) => {
    if (refusing.on) return { deny: 'disk full' }
    writes.push(e.key)
    entries.set(e.key, e.value)
    return { value: undefined }
  })
  return { entries, writes, refusing }
}

// The session the register tests run in: the engine answers its id beneath the plugin. A /clear moves it to a new id
// (FR-ST-4): no session.start follows, the process goes on under the new one.
const SESSION_ID = 'session-under-test'
const AFTER_CLEAR_ID = 'session-after-clear'
let currentId = SESSION_ID

// The engine's answers beneath the plugin's session hooks, and the status line the test can read.
// While set, the session.end answer beneath the plugin waits for it: the hook above is held mid-/clear.
let endHold: Promise<void> | null = null
// While set, a session.id answer beneath the plugin waits for it, with the id it had when it was asked.
let idHold: Promise<void> | null = null

function sessionBeneath(on: On): string[] {
  const statuses: string[] = []
  currentId = SESSION_ID
  endHold = null
  idHold = null
  on('session.id', async () => {
    const asked = currentId
    if (idHold !== null) await idHold
    return { value: asked }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', async (_, e) => {
    if (endHold !== null) await endHold
    if (e.reason === 'clear') currentId = AFTER_CLEAR_ID
    return { sessionId: e.sessionId }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_, e) => {
    statuses.push(e.text ?? '')
    return { value: undefined }
  })
  return statuses
}

const seededSnapshot = (sessionId: string) => snapshot(sessionId, { events: [drift('e1')] })

test('session.start restores the session\'s snapshot and shows its status (FR-ST-4)', async ($, on) => {
  const clock = mock.clock(on)
  const id = SESSION_ID
  storeBeneath(on, { [`session:${id}`]: seededSnapshot(id) })
  const statuses = sessionBeneath(on)

  await $.session.start(SESSION)
  // The restore's own state writes schedule one save; it is run here so no timer outlives the test.
  await clock.advance(2000)

  expect(statuses.at(-1)).toBe('stayontarget: 1 drift')
})

test('a /clear saves the session, then starts its state again (FR-ST-4)', async ($, on) => {
  const clock = mock.clock(on)
  const id = SESSION_ID
  const store = storeBeneath(on, { [`session:${id}`]: seededSnapshot(id) })
  const statuses = sessionBeneath(on)
  await $.session.start(SESSION)

  await $.session.end({ reason: 'clear', sessionId: id, resume: { id } })
  await clock.advance(2000)

  // The ending session's snapshot is kept under its id; the new session's initial state is not saved (FR-ST-4).
  expect(store.entries.get(`session:${id}`)).toMatchObject({ sessionId: id, charter: CHARTER })
  expect(store.entries.has(`session:${AFTER_CLEAR_ID}`)).toBe(false)
  expect(statuses.at(-1)).toBe('stayontarget: no charter yet')
})

test('a session end that is not a /clear saves and keeps the state (FR-ST-4)', async ($, on) => {
  const clock = mock.clock(on)
  const id = SESSION_ID
  const store = storeBeneath(on, { [`session:${id}`]: seededSnapshot(id) })
  const statuses = sessionBeneath(on)
  await $.session.start(SESSION)

  await $.session.end({ reason: 'prompt_input_exit', sessionId: id, resume: { id } })
  await clock.advance(2000)

  expect(store.writes).toContain(`session:${id}`)
  expect(statuses.at(-1)).toBe('stayontarget: 1 drift')
})

test('a save the store refuses shows not saved on the status line, and the next save clears it (FR-ST-3, FR-RS-6)', async ($, on) => {
  const clock = mock.clock(on)
  const id = SESSION_ID
  const store = storeBeneath(on, { [`session:${id}`]: seededSnapshot(id) })
  const statuses = sessionBeneath(on)
  await $.session.start(SESSION)

  store.refusing.on = true
  await $.session.end({ reason: 'prompt_input_exit', sessionId: id, resume: { id } })
  expect(statuses.at(-1)).toBe('stayontarget: 1 drift · not saved')

  store.refusing.on = false
  await $.session.end({ reason: 'prompt_input_exit', sessionId: id, resume: { id } })
  expect(statuses.at(-1)).toBe('stayontarget: 1 drift')
  await clock.advance(2000)
})

test('the state writes of one restore make one save, two seconds after the last of them (FR-ST-3)', async ($, on) => {
  const clock = mock.clock(on)
  const id = SESSION_ID
  const store = storeBeneath(on, { [`session:${id}`]: seededSnapshot(id) })
  sessionBeneath(on)

  await $.session.start(SESSION)
  expect(store.writes.filter(key => key === `session:${id}`)).toEqual([])

  await clock.advance(1999)
  expect(store.writes.filter(key => key === `session:${id}`)).toEqual([])

  await clock.advance(1)
  expect(store.writes.filter(key => key === `session:${id}`)).toEqual([`session:${id}`])
})

test('a timer that falls due during a /clear saves nothing under the old id; a change after it saves under the new id (FR-ST-4)', async ($, on) => {
  const clock = mock.clock(on)
  const id = SESSION_ID
  const store = storeBeneath(on, { [`session:${id}`]: seededSnapshot(id), [`session:${AFTER_CLEAR_ID}`]: seededSnapshot(AFTER_CLEAR_ID) })
  sessionBeneath(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start(SESSION)
  // The restore's save is scheduled at 0 and falls due at 2,000 ms: it is still waiting at 1,999 ms.
  await clock.advance(1999)

  let release = (): void => undefined
  endHold = new Promise<void>(resolve => {
    release = resolve
  })
  const ended = $.session.end({ reason: 'clear', sessionId: id, resume: { id } })
  // The timer falls due while the hook above is held, after the reset.
  await clock.advance(1)

  expect(store.entries.get(`session:${id}`)).toMatchObject({ sessionId: id, charter: CHARTER })

  release()
  await ended
  endHold = null
  // After the hook returns, a state change schedules again, and its save goes under the new id.
  store.writes.length = 0
  await $.turn.start({ text: 'fix the parser', turnId: 'turn-2' })
  await clock.advance(2000)

  expect(store.writes).toContain(`session:${AFTER_CLEAR_ID}`)
})

test('a scheduled save whose session id is answered after a /clear saves and deletes nothing under the ending id (FR-ST-4)', async ($, on) => {
  const clock = mock.clock(on)
  const id = SESSION_ID
  const store = storeBeneath(on, { [`session:${id}`]: seededSnapshot(id) })
  sessionBeneath(on)
  await $.session.start(SESSION)

  // The restore's save falls due at 2,000 ms; its session id is asked then, and the answer is held.
  let release = (): void => undefined
  idHold = new Promise<void>(resolve => {
    release = resolve
  })
  await clock.advance(2000)

  await $.session.end({ reason: 'clear', sessionId: id, resume: { id } })
  release()
  await clock.advance(1)

  expect(store.entries.get(`session:${id}`)).toMatchObject({ sessionId: id, charter: CHARTER })
})

test('a /clear whose save is refused still resets, and shows not saved before the reset (FR-ST-4, FR-RS-6)', async ($, on) => {
  const clock = mock.clock(on)
  const id = SESSION_ID
  const store = storeBeneath(on, { [`session:${id}`]: seededSnapshot(id) })
  const statuses = sessionBeneath(on)
  await $.session.start(SESSION)
  await clock.advance(2000)

  store.refusing.on = true
  await $.session.end({ reason: 'clear', sessionId: id, resume: { id } })

  // The reset runs after the save whatever the save did; the failure was on the status line before the reset.
  expect(statuses).toContain('stayontarget: 1 drift · not saved')
  expect(statuses.at(-1)).toBe('stayontarget: no charter yet')
  store.refusing.on = false
  await clock.advance(2000)
})
