import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Allowance, Charter, DriftEvent, ReadAs } from '../types'
import { EMPTY_STATS } from '../src/state'
import { fileUrl } from '../src/pane'

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
    excerpt: '',
    cwd: null,
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
  return {
    charter: CHARTER,
    events,
    allowances,
    stats: { ...EMPTY_STATS, judged: 4, cacheHits: 2, inputTokens: 90, outputTokens: 30 },
    ui: { expandedEventId: null, view: 'events' },
  }
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

  // The pane has twenty body rows, the surface forty. The head takes seven (goal, charter line, the charter summary, mode,
  // counts, strip, New task). The events keep the other thirteen: six open drift rows of two lines each, so the six newest
  // show with their buttons. Twenty buttons in all: six event rows with their allow and dismiss, plus "Edit charter" and
  // New task.
  const props = { ...PANE.props, scroll: { offset: 0, bodyRows: 20 } }
  const ui = await $.ui.mount({ ...PANE, props, surface: 'desktop', viewport: { columns: 80, rows: 40 } })

  expect(await ui.findAll({ type: 'Button' })).toHaveLength(20)
  expect(await ui.find({ type: 'Button', key: 'allow-e29' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'allow-e24' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'allow-e23' })).toBeUndefined()
  await ui.unmount()
})

// FR-CH-10: a reading of an amendment, drawn under the goal in the events view and counted in its rows.
const READ_AS: ReadAs = {
  reading: 'amendment',
  head: 'also update the tests',
  before: { ...CHARTER, pendingText: [] },
  consumed: ['also update the tests'],
  afterId: 'c1',
  afterRev: 2,
  at: 0,
}
const LINE = 'Read as amendment: "also update the tests"'

test('the read-as line stands under the goal, with its buttons on the writable surfaces (FR-CH-10)', async ($, on) => {
  mock.clock(on)
  stateBeneath(on, { ...seeded([event('e1')]), readAs: READ_AS })

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 40 } })
  expect(await desktop.find({ type: 'Text', text: LINE })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'pane-ra-new' })).toBeDefined()
  expect(await desktop.find({ type: 'Button', key: 'pane-ra-ok' })).toBeDefined()
  await desktop.unmount()

  const mobile = await $.ui.mount({ ...PANE, surface: 'mobile', viewport: { columns: 80, rows: 24 } })
  expect(await mobile.find({ type: 'Text', text: LINE })).toBeDefined()
  expect(await mobile.find({ type: 'Button', key: 'pane-ra-new' })).toBeUndefined()
  await mobile.unmount()
})

test('the read-as line displaces the summary before any event, and goes before the newest event does (FR-CH-10, FR-UI-2)', async ($, on) => {
  mock.clock(on)
  stateBeneath(on, { ...seeded([event('e1')]), readAs: READ_AS })

  // Seven body rows: the summary goes, the line and the event stay.
  const seven = { ...PANE.props, scroll: { offset: 0, bodyRows: 7 } }
  const roomy = await $.ui.mount({ ...PANE, props: seven, surface: 'desktop', viewport: { columns: 80, rows: 40 } })
  expect(await roomy.find({ type: 'Text', text: /^In scope: / })).toBeUndefined()
  expect(await roomy.find({ type: 'Text', text: LINE })).toBeDefined()
  expect(await roomy.find({ type: 'Text', text: /drift Edit src\/e1\.ts/ })).toBeDefined()
  await roomy.unmount()

  // Six body rows: the line goes, and the event still shows.
  const six = { ...PANE.props, scroll: { offset: 0, bodyRows: 6 } }
  const tight = await $.ui.mount({ ...PANE, props: six, surface: 'desktop', viewport: { columns: 80, rows: 40 } })
  expect(await tight.find({ type: 'Text', text: LINE })).toBeUndefined()
  expect(await tight.find({ type: 'Text', text: /drift Edit src\/e1\.ts/ })).toBeDefined()
  await tight.unmount()
})

test('no events for this charter reads as nothing judged yet (FR-UI-2)', async ($, on) => {
  stateBeneath(on, seeded([]))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 24 } })

  expect((await ui.find({ type: 'Text', text: /No changes judged yet\./ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a pane row whose reason has newlines is drawn on one line (FR-UI-6)', async ($, on) => {
  stateBeneath(on, seeded([{ ...event('e1'), reason: 'first\nsecond' }]))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })

  expect((await ui.find({ type: 'Text', text: /^drift Edit src\/e1\.ts — first second$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

// The hover scope itself is engine-owned and not in the drawing the kit reports, so this checks the drawn style: a drift
// row is bold, as the badge's verdict is. The shared `sot-<id>` scope is in the source (src/pane.tsx, src/marks.tsx).
test('a drift pane row is drawn bold, as the badge verdict is (FR-UI-6)', async ($, on) => {
  stateBeneath(on, seeded([event('e1')]))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })
  const row = await ui.find({ type: 'Text', text: /^drift Edit src\/e1\.ts/ })

  expect(row?.props.bold).toBe(true)
  await ui.unmount()
})

test('the charter is drawn as Markdown with its two scope lists (FR-UI-10)', async ($, on) => {
  stateBeneath(on, seeded([]))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })
  await ui.press({ key: 'view-charter' })
  await ui.redraw()
  const block = await ui.find({ type: 'Markdown' })

  expect(block?.props.text).toContain('**In scope**\n- src/parser.ts\n**Out of scope** (none)')
  await ui.unmount()
})

test('add and remove by key update the charter; each edit marks its list (FR-UI-10, FR-CH-8)', async ($, on) => {
  const state = stateBeneath(on, seeded([]))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 30 } })
  await ui.press({ key: 'view-charter' })
  await ui.redraw()

  await ui.input({ key: 'add-in', text: 'src/new.ts', kind: 'submit' })
  await ui.redraw()
  expect(state('charter')).toMatchObject({ inScope: ['src/parser.ts', 'src/new.ts'], editedFields: ['inScope'] })

  await ui.press({ key: 'rm-in-0' })
  await ui.redraw()
  expect(state('charter').inScope).toEqual(['src/new.ts'])

  await ui.input({ key: 'add-out', text: 'docs/', kind: 'submit' })
  await ui.redraw()
  expect(state('charter')).toMatchObject({ outOfScope: ['docs/'], editedFields: ['inScope', 'outOfScope'] })
  await ui.unmount()
})

test('mobile has no Select, Input or Button of the mode and lists; the mode is text there (FR-UI-4, FR-UI-10)', async ($, on) => {
  stateBeneath(on, seeded([event('e1')]))

  const mobile = await $.ui.mount({ ...PANE, surface: 'mobile', viewport: { columns: 80, rows: 24 } })
  expect(await mobile.find({ type: 'Select' })).toBeUndefined()
  expect(await mobile.find({ type: 'Input' })).toBeUndefined()
  expect(await mobile.find({ type: 'Text', text: /mode warn/ })).toBeDefined()
  expect(await mobile.find({ type: 'Svg' })).toBeDefined()
  await mobile.unmount()

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })
  expect(await desktop.find({ type: 'Select', key: 'mode' })).toBeDefined()
  expect(await desktop.find({ type: 'Input', key: 'add-in' })).toBeUndefined()
  await desktop.press({ key: 'view-charter' })
  await desktop.redraw()
  expect(await desktop.find({ type: 'Input', key: 'add-in' })).toBeDefined()
  await desktop.unmount()
})

test('the mode Select calls config.set with stayontarget.mode (FR-UI-10)', async ($, on) => {
  const writes: unknown[] = []
  stateBeneath(on, seeded([]))
  on('config.set', (_, e) => {
    writes.push(e)
    return { value: e.value }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })
  await ui.select({ key: 'mode', value: 'strict' })
  await ui.redraw()

  expect(writes).toEqual([expect.objectContaining({ key: 'stayontarget.mode', value: 'strict' })])
  await ui.unmount()
})

test('a terminal shows the strip as text, and the other surfaces as an SVG (FR-UI-10)', async ($, on) => {
  stateBeneath(on, seeded([event('e1'), event('e2', 'in-scope')]))

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 24 } })
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  expect(await terminal.find({ type: 'Text', text: /^[█▓░·]+$/ })).toBeDefined()
  await terminal.unmount()

  const vscode = await $.ui.mount({ ...PANE, surface: 'vscode', viewport: { columns: 80, rows: 24 } })
  expect(await vscode.find({ type: 'Svg' })).toBeDefined()
  await vscode.unmount()
})

test('pressing an event row expands it: its excerpt as Code and a file link; pressing again or another row moves it (FR-UI-10)', async ($, on) => {
  const relative = { ...event('e1'), excerpt: 'const a = 1', cwd: 'C:\\work' }
  const absolute = { ...event('e2'), target: 'D:\\other\\a b.ts', excerpt: 'const b = 2', cwd: null }
  stateBeneath(on, seeded([relative, absolute]))

  // The desktop draws a link only to an https address (the engine draws a file link as plain text), so the link is
  // checked on the terminal, where any scheme is drawn as a link.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 30 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { source: 'const a = 1', path: 'src/e1.ts' } })
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'file:///C:/work/src/e1.ts' } })

  await ui.press({ key: 'ev-e2' })
  await ui.redraw()
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { source: 'const b = 2', path: 'D:\\other\\a b.ts' } })
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'file:///D:/other/a%20b.ts' } })

  await ui.press({ key: 'ev-e2' })
  await ui.redraw()
  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.unmount()
})

test('fileUrl percent-encodes segments and keeps a Windows drive letter (FR-UI-10)', () => {
  expect(fileUrl('/home/me', 'src/a b#1.ts')).toBe('file:///home/me/src/a%20b%231.ts')
  expect(fileUrl('C:\\work\\', 'src\\x.ts')).toBe('file:///C:/work/src/x.ts')
  expect(fileUrl('C:\\work', 'D:\\y\\z.md')).toBe('file:///D:/y/z.md')
  expect(fileUrl('/home/me', '/etc/hosts')).toBe('file:///etc/hosts')
  expect(fileUrl(null, 'src/x.ts')).toBeNull()
  expect(fileUrl(null, 'D:\\y\\z.md')).toBe('file:///D:/y/z.md')
})

test('a relative link is taken from the directory the call ran in, not the session directory (FR-UI-10)', async ($, on) => {
  on('session.cwd', () => ({ value: 'C:\\second' }))
  stateBeneath(on, seeded([{ ...event('e1'), excerpt: 'x = 1', cwd: 'C:\\first' }]))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 24 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()

  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'file:///C:/first/src/e1.ts' } })
  await ui.unmount()
})

test('a file name with # is linked whole; only a notebook cell is cut from its target (FR-UI-10)', async ($, on) => {
  stateBeneath(on, seeded([{ ...event('e1'), target: 'src/a#1.ts', excerpt: 'x = 1', cwd: 'C:\\work' }]))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 24 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()

  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'file:///C:/work/src/a%231.ts' } })
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { path: 'src/a#1.ts' } })
  await ui.unmount()
})

test('a notebook target cuts its cell only after a .ipynb path (FR-UI-10)', async ($, on) => {
  stateBeneath(
    on,
    seeded([
      { ...event('e1'), tool: 'NotebookEdit', target: 'reports/run#1.ipynb#cell-3', excerpt: 'x = 1', cwd: 'C:\\work' },
      { ...event('e2'), tool: 'NotebookEdit', target: 'reports/run#1.ipynb', excerpt: 'x = 2', cwd: 'C:\\work' },
    ]),
  )

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 30 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { path: 'reports/run#1.ipynb' } })
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'file:///C:/work/reports/run%231.ipynb' } })

  await ui.press({ key: 'ev-e2' })
  await ui.redraw()
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { path: 'reports/run#1.ipynb' } })
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'file:///C:/work/reports/run%231.ipynb' } })
  await ui.unmount()
})

test('an unchecked file event keeps its link and its path (FR-UI-10)', async ($, on) => {
  stateBeneath(on, seeded([{ ...event('e1', 'unchecked'), excerpt: 'x = 1', cwd: 'C:\\work' }]))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 24 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()

  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'file:///C:/work/src/e1.ts' } })
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { path: 'src/e1.ts' } })
  await ui.unmount()
})

// FR-UI-2: whatever the body's rows, the newest open out-of-scope event and its buttons are drawn.
for (const rows of [24, 12, 8, 5]) {
  test(`at body rows ${rows} the newest drift event and its buttons are drawn (FR-UI-2)`, async ($, on) => {
    stateBeneath(on, seeded([event('e0'), event('e1'), event('e2'), event('e3')]))
    const props = { ...PANE.props, scroll: { offset: 0, bodyRows: rows } }

    const ui = await $.ui.mount({ ...PANE, props, surface: 'desktop', viewport: { columns: 80, rows: 40 } })

    expect(await ui.find({ type: 'Button', key: 'ev-e3' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'allow-e3' })).toBeDefined()
    await ui.unmount()
  })
}

test('the excerpt is drawn one row per line, truncated at the edge, so a long line costs one row (FR-UI-10)', async ($, on) => {
  stateBeneath(on, seeded([event('e0'), { ...event('e1'), excerpt: 'y'.repeat(400), cwd: null }]))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()

  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { wrap: 'truncate-end' } })
  expect(await ui.find({ type: 'Button', key: 'ev-e0' })).toBeDefined()
  await ui.unmount()
})

test('a live event from 0.1.0 with no excerpt or cwd expands with no excerpt and no link, without throwing (FR-UI-10)', async ($, on) => {
  const { excerpt: _excerpt, cwd: _cwd, ...old } = event('e1')
  stateBeneath(on, seeded([old as DriftEvent]))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 24 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()

  expect(await ui.find({ type: 'Text', text: /^\(no excerpt\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await ui.unmount()
})

test('an expanded row keeps its Code and Link at 20 rows, and the other events still list (FR-UI-10, FR-UI-2)', async ($, on) => {
  const events = Array.from({ length: 6 }, (_, i) => ({ ...event(`e${i}`), excerpt: 'x = 1', cwd: 'C:\\work' }))
  stateBeneath(on, seeded(events))
  const props = { ...PANE.props, scroll: { offset: 0, bodyRows: 20 } }

  // The terminal draws the file link (the desktop draws only https links as links).
  const ui = await $.ui.mount({ ...PANE, props, surface: 'terminal', viewport: { columns: 80, rows: 40 } })
  await ui.press({ key: 'ev-e0' })
  await ui.redraw()

  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { source: 'x = 1' } })
  expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'file:///C:/work/src/e0.ts' } })
  expect(await ui.find({ type: 'Button', key: 'allow-e5' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'allow-e4' })).toBeDefined()
  await ui.unmount()
})

test('a refused mode change is logged, toasted, and the Select is drawn again with the mode in force (FR-UI-10)', async ($, on) => {
  const toasts: string[] = []
  const redraws: string[] = []
  stateBeneath(on, seeded([]))
  on('config.set', () => ({ deny: 'locked by policy' }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.invalidate', (_, e) => {
    redraws.push(e.event)
    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })
  await ui.select({ key: 'mode', value: 'strict' })
  await ui.redraw()

  expect(toasts).toEqual(['stayontarget: mode not changed: locked by policy'])
  expect(redraws).toEqual(['ui.render'])
  expect(await ui.find({ type: 'Select', key: 'mode' })).toMatchObject({ props: { value: 'warn' } })
  await ui.unmount()
})

test('a long file link is labelled with its target cut to the row, and its address stays whole (FR-UI-10)', async ($, on) => {
  const long = `src/${'a'.repeat(100)}.ts`
  stateBeneath(on, seeded([{ ...event('e1'), target: long, excerpt: 'x = 1', cwd: 'C:\\work' }]))

  const props = { ...PANE.props, bodyColumns: 40 }
  const ui = await $.ui.mount({ ...PANE, props, surface: 'terminal', viewport: { columns: 40, rows: 24 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()

  const label = String((await ui.find({ type: 'Link' }))?.props.label)
  expect(label.length).toBeLessThanOrEqual(40)
  expect(label.endsWith('…')).toBe(true)
  const link = await ui.find({ type: 'Link' })
  expect(link?.props.href).toBe(`file:///C:/work/${long}`)
  await ui.unmount()
})

test('a link over 2,048 characters is left out, and the pane still draws (FR-UI-10)', async ($, on) => {
  const long = `src/${'a'.repeat(3000)}.ts`
  stateBeneath(on, seeded([{ ...event('e1'), target: long, excerpt: 'x = 1', cwd: 'C:\\work' }]))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 24 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()

  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { source: 'x = 1' } })
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await ui.unmount()
})

test('a target with a control character draws its code without a path (FR-UI-10)', async ($, on) => {
  stateBeneath(on, seeded([{ ...event('e1'), target: 'src/a\u001b.ts', excerpt: 'x = 1', cwd: null }]))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport: { columns: 80, rows: 24 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()

  const code = await ui.find({ type: 'Code' })
  expect(code).toMatchObject({ props: { source: 'x = 1' } })
  expect(code?.props.path).toBeUndefined()
  await ui.unmount()
})

test('a control character in the excerpt draws as an escape; tabs and newlines are kept (FR-UI-2)', async ($, on) => {
  stateBeneath(on, seeded([{ ...event('e1'), excerpt: 'a\u001b[31mb\n\tc', cwd: null }]))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })
  await ui.press({ key: 'ev-e1' })
  await ui.redraw()

  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { source: 'a\\x1b[31mb\n\tc' } })
  await ui.unmount()
})

test('a goal and a scope item with a control character draw as escapes (FR-UI-10)', async ($, on) => {
  stateBeneath(on, { ...seeded([]), charter: { ...CHARTER, goal: 'fix\u0007', inScope: ['src/\u001b.ts'] } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 80, rows: 24 } })
  await ui.press({ key: 'view-charter' })
  await ui.redraw()

  expect((await ui.find({ type: 'Markdown' }))?.props.text).toContain('- src/\\x1b.ts')
  await ui.unmount()
})

// Eight items in each list, so the events view can only show part of the charter.
const LONG_CHARTER: Charter = {
  ...CHARTER,
  inScope: Array.from({ length: 8 }, (_, i) => `src/in-${i}.ts`),
  outOfScope: Array.from({ length: 8 }, (_, i) => `docs/out-${i}.md`),
  editedFields: [],
}

test('the charter view draws a 200-character scope item whole, at 40 columns (FR-UI-10)', async ($, on) => {
  const item = `src/${'a'.repeat(193)}.ts`
  stateBeneath(on, { ...seeded([]), charter: { ...CHARTER, inScope: [item] } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop', viewport: { columns: 40, rows: 24 } })
  await ui.press({ key: 'view-charter' })
  await ui.redraw()

  expect(item.length).toBe(200)
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toContain(`- ${item}`)
  await ui.unmount()
})

test('the events view keeps the events beside a long charter, and the charter view lists all of it (FR-UI-10)', async ($, on) => {
  const events = Array.from({ length: 4 }, (_, i) => event(`e${i}`))
  const state = stateBeneath(on, { ...seeded(events), charter: LONG_CHARTER })
  const props = { ...PANE.props, scroll: { offset: 0, bodyRows: 24 } }
  const ui = await $.ui.mount({ ...PANE, props, surface: 'desktop', viewport: { columns: 80, rows: 24 } })

  expect(await ui.find({ type: 'Button', key: 'allow-e3' })).toBeDefined()
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^In scope: 8 · Out of scope: 8$/ })).toBeDefined()

  await ui.press({ key: 'view-charter' })
  await ui.redraw()
  expect(state('ui')).toMatchObject({ view: 'charter' })
  const block = await ui.find({ type: 'Markdown' })
  expect(block?.props.text).toContain('- src/in-7.ts')
  expect(block?.props.text).toContain('- docs/out-7.md')
  expect(await ui.find({ type: 'Button', key: 'allow-e3' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'rm-in-7' })).toBeDefined()

  await ui.press({ key: 'view-events' })
  await ui.redraw()
  expect(state('ui')).toMatchObject({ view: 'events' })
  expect(await ui.find({ type: 'Button', key: 'allow-e3' })).toBeDefined()
  await ui.unmount()
})

test('mobile shows the events view only (FR-UI-4, FR-UI-10)', async ($, on) => {
  stateBeneath(on, { ...seeded([event('e1')]), charter: LONG_CHARTER, ui: { expandedEventId: null, view: 'charter' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile', viewport: { columns: 80, rows: 24 } })

  expect(await ui.find({ type: 'Button', key: 'view-charter' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /drift Edit src\/e1\.ts/ })).toBeDefined()
  await ui.unmount()
})
