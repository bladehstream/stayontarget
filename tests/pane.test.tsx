import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Allowance, Charter, DriftEvent } from '../types'
import { EMPTY_STATS } from '../src/state'

// The pane is mounted through the plugin on each surface. The engine's state stands beneath the plugin: a versioned store
// answers get and set(ifVersion) as the engine does, seeded by the test, so a handler's write can be read back here.

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const PANE = {
  plugin: 'stayontarget',
  component: 'Pane',
  requestId: 'stayontarget',
  props: {
    title: 'Stay on target',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const CHARTER: Charter = {
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
}

function event(id: string, verdict: DriftEvent['verdict'] = 'drift', status: DriftEvent['status'] = 'open'): DriftEvent {
  return {
    id,
    toolUseId: `tool-${id}`,
    charterId: 'c1',
    charterRev: 2,
    mainTurnId: null,
    agentId: null,
    tool: 'Edit',
    target: `src/${id}.ts`,
    verdict,
    reason: 'outside the request',
    source: 'judge',
    action: 'note',
    status,
    at: 1,
  }
}

function stateBeneath(on: On, seed: Record<string, unknown>) {
  const store = new Map<string, { value: unknown; version: number }>()
  for (const [key, value] of Object.entries(seed)) store.set(key, { value, version: 1 })

  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('state.get', (_, e) => ({ value: store.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const version = store.get(e.key)?.version ?? 0
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    store.set(e.key, { value: e.value, version: version + 1 })
    return { value: { isSet: true, version: version + 1 } }
  })

  return (key: string): any => store.get(key)?.value
}

function seeded(events: DriftEvent[], allowances: Allowance[] = []) {
  return { charter: CHARTER, events, allowances, stats: { ...EMPTY_STATS, judged: 4, cacheHits: 2, inputTokens: 90, outputTokens: 30 } }
}

test('mobile is read-only: no goal input, no buttons; the other surfaces have them (FR-UI-2, FR-UI-4)', async ($, on) => {
  stateBeneath(on, seeded([event('e1')]))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface, viewport: { columns: 80, rows: 24 } })
    const writable = surface !== 'mobile'

    expect((await ui.find({ type: 'Input', key: 'goal' })) !== undefined).toBe(writable)
    expect((await ui.find({ type: 'Button', key: 'allow-e1' })) !== undefined).toBe(writable)
    expect((await ui.find({ type: 'Button', key: 'dismiss-e1' })) !== undefined).toBe(writable)
    expect((await ui.find({ type: 'Button', key: 'new-task' })) !== undefined).toBe(writable)
    if (!writable) {
      expect((await ui.find({ type: 'Text', text: /Goal: fix the parser/ })) !== undefined).toBe(true)
      expect((await ui.find({ type: 'Text', text: /^open$/ })) !== undefined).toBe(true)
    }
    await ui.unmount()
  }
})

test('an unchecked event with no charter id is listed and counted (FR-UI-2)', async ($, on) => {
  // No target, so no charter id: it belongs to the charter because it was made after the charter was created.
  const unchecked: DriftEvent = { ...event('u1', 'unchecked'), charterId: null, at: 5, reason: 'no target' }
  stateBeneath(on, seeded([unchecked]))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })

  expect((await ui.find({ type: 'Text', text: /unchecked Edit src\/u1\.ts — no target/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /1 unchecked/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /No changes judged yet\./ })) === undefined).toBe(true)
  await ui.unmount()
})

test('the event list shows the current charter and its buttons, by key (FR-UI-2, FR-UI-3)', async ($, on) => {
  stateBeneath(on, seeded([event('e1'), event('e2', 'in-scope')]))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })

  expect(await ui.find({ type: 'Button', key: 'allow-e1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'dismiss-e1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'allow-e2' })).toBeUndefined()
  await ui.unmount()
})

test('Allow for this task creates an allowance and marks the event allowed (FR-UI-3)', async ($, on) => {
  const state = stateBeneath(on, seeded([event('e1')]))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })

  await ui.press({ key: 'allow-e1' })
  await ui.redraw()

  expect(state('allowances')).toMatchObject([{ charterId: 'c1', tool: 'Edit', target: 'src/e1.ts' }])
  expect(state('events')[0].status).toBe('allowed')
  expect((await ui.find({ type: 'Text', text: /^allowed$/ })) !== undefined).toBe(true)
  expect(await ui.find({ type: 'Button', key: 'allow-e1' })).toBeUndefined()
  await ui.unmount()
})

test('the same tool and target is never allowed twice (FR-UI-3)', async ($, on) => {
  const existing: Allowance = { charterId: 'c1', tool: 'Edit', target: 'src/e1.ts', at: 1 }
  const state = stateBeneath(on, seeded([event('e1')], [existing]))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })

  await ui.press({ key: 'allow-e1' })
  await ui.redraw()

  expect(state('allowances')).toHaveLength(1)
  expect(state('events')[0].status).toBe('allowed')
  await ui.unmount()
})

test('Dismiss marks the event dismissed and allows nothing (FR-UI-3)', async ($, on) => {
  const state = stateBeneath(on, seeded([event('e1')]))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })

  await ui.press({ key: 'dismiss-e1' })
  await ui.redraw()

  expect(state('events')[0].status).toBe('dismissed')
  expect(state('allowances')).toEqual([])
  expect((await ui.find({ type: 'Text', text: /^dismissed$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('submitting the goal edits it and marks the field edited (FR-CH-8)', async ($, on) => {
  const state = stateBeneath(on, seeded([]))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })

  await ui.input({ key: 'goal', text: 'ship the parser', kind: 'submit' })
  await ui.redraw()

  expect(state('charter').goal).toBe('ship the parser')
  expect(state('charter').editedFields).toEqual(['goal'])
  await ui.unmount()
})

test('New task clears the charter (FR-CH-8)', async ($, on) => {
  const state = stateBeneath(on, seeded([event('e1')]))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })

  await ui.press({ key: 'new-task' })
  await ui.redraw()

  expect(state('charter')).toBeNull()
  await ui.unmount()
})

test('the list is cut to the viewport rows, newest first (FR-UI-2)', async ($, on) => {
  const events = Array.from({ length: 30 }, (_, i) => event(`e${i}`))
  stateBeneath(on, seeded(events))

  // The pane has ten body rows, the surface forty. Ten leave six for the list, and an open drift row takes two of them:
  // three rows, six buttons, and New task. The surface's height does not size the list.
  const props = { ...PANE.props, scroll: { offset: 0, bodyRows: 10 } }
  const ui = await $.ui.mount({ ...PANE, props, surface: 'desktop', viewport: { columns: 80, rows: 40 } })

  expect(await ui.findAll({ type: 'Button' })).toHaveLength(7)
  expect(await ui.find({ type: 'Button', key: 'allow-e29' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'allow-e27' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'allow-e26' })).toBeUndefined()
  await ui.unmount()
})

test('no events for this charter reads as nothing judged yet (FR-UI-2)', async ($, on) => {
  stateBeneath(on, seeded([]))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 24 } })

  expect((await ui.find({ type: 'Text', text: /No changes judged yet\./ })) !== undefined).toBe(true)
  await ui.unmount()
})
