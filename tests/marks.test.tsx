import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Allowance, Charter, DriftEvent } from '../types'
import { footerHead, footerRows } from '../src/events'
import { EMPTY_STATS } from '../src/state'

// The marks are mounted through the plugin on each surface, beneath an engine row the test answers as a tree. The state
// beneath the plugin is a versioned store, as pane.test.tsx has it, so a handler's write reads back here.

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
// The band is raised on the terminal and the desktop only.
const BAND_SURFACES = ['terminal', 'desktop'] as const

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
    mainTurnId: 'turn-1',
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
  return { charter: CHARTER, events, allowances, stats: EMPTY_STATS }
}

// The engine's own rows, answered beneath the plugin as plain trees: what a mark is drawn under.
function engine(on: On) {
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>engine row</Text>
      </Box>
    )
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>engine band</Text>
      </Box>
    )
  })
  on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text>engine message</Text>
      </Box>
    )
  })
  // The turn's own answer, as the engine has it, unless the plugin's footer replaces it.
  on('turn.complete', (_, e) => ({ text: e.answer }))
}

// The text a turn ends with, as the plugin's turn.complete hook draws it: its footer if the turn has one. The hook also
// remembers the footer, so the message that carries it is drawn with its buttons.
async function drawnFooter($: Engine, turnId = 'turn-1'): Promise<string> {
  const done = await $.turn.complete({ turnId, answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' })
  return done.text ?? ''
}

function toolRow(surface: (typeof SURFACES)[number], id: string, columns = 80) {
  return {
    plugin: 'stayontarget',
    surface,
    component: 'ToolUse' as const,
    requestId: `tool-${id}`,
    props: {
      tool_use_id: `tool-${id}`,
      tool: 'Edit',
      input: {},
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
    viewport: { columns, rows: 24 },
  }
}

function band(surface: (typeof BAND_SURFACES)[number], options: { hasSurvey?: boolean; agentId?: string; columns?: number } = {}) {
  return {
    plugin: 'stayontarget',
    surface,
    component: 'AbovePrompt' as const,
    props: {
      hasSurvey: options.hasSurvey ?? false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: options.columns ?? 80,
      scroll: { offset: 0, bodyRows: 10 },
      view: options.agentId === undefined ? {} : { agentId: options.agentId },
    },
    viewport: { columns: 80, rows: 24 },
  }
}

function message(surface: (typeof SURFACES)[number], text: string) {
  return {
    plugin: 'stayontarget',
    surface,
    component: 'AssistantMessage' as const,
    requestId: 'message-1',
    props: { text, isFirstOfReply: true },
    viewport: { columns: 80, rows: 24 },
  }
}

test('a tool row with no event is the engine row, unchanged (FR-UI-6)', async ($, on) => {
  stateBeneath(on, seeded([]))
  engine(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(toolRow(surface, 'e1'))

    expect((await ui.find({ type: 'Text', text: /^engine row$/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /stayontarget/ })) === undefined).toBe(true)
    await ui.unmount()
  }
})

test('a drift row shows its verdict and its reason cut to the width (FR-UI-6)', async ($, on) => {
  stateBeneath(on, seeded([{ ...event('e1'), reason: 'x'.repeat(60) }]))
  engine(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(toolRow(surface, 'e1'))
    // The line is 80 cells: the verdict, then the reason cut to what the line keeps, less the two buttons where they draw.
    const room = surface === 'mobile' ? 80 - 'stayontarget: drift'.length : 80 - 'stayontarget: drift'.length - 34

    expect((await ui.find({ type: 'Text', text: /^stayontarget: drift$/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: new RegExp(`^ — x{${room - 4}}…$`) })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Button', key: 'allow-e1' })) !== undefined).toBe(surface !== 'mobile')
    expect((await ui.find({ type: 'Button', key: 'dismiss-e1' })) !== undefined).toBe(surface !== 'mobile')
    await ui.unmount()
  }
})

test('Allow for this task creates the allowance and the badge then reads allowed (FR-UI-6)', async ($, on) => {
  const state = stateBeneath(on, seeded([event('e1')]))
  engine(on)
  const ui = await $.ui.mount(toolRow('desktop', 'e1'))

  await ui.press({ key: 'allow-e1' })
  await ui.redraw()

  expect(state('allowances')).toMatchObject([{ charterId: 'c1', tool: 'Edit', target: 'src/e1.ts' }])
  expect(state('events')[0].status).toBe('allowed')
  expect((await ui.find({ type: 'Text', text: /^allowed$/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'allow-e1' })) === undefined).toBe(true)
  await ui.unmount()
})

test('an in-scope row is dim with no buttons, and a dismissed row shows its status (FR-UI-6)', async ($, on) => {
  stateBeneath(on, seeded([event('e1', 'in-scope'), event('e2', 'adjacent', 'dismissed')]))
  engine(on)

  const inScope = await $.ui.mount(toolRow('desktop', 'e1'))
  expect((await inScope.find({ type: 'Text', text: /^stayontarget: in-scope$/ })) !== undefined).toBe(true)
  expect((await inScope.find({ type: 'Button', key: 'allow-e1' })) === undefined).toBe(true)
  await inScope.unmount()

  const dismissed = await $.ui.mount(toolRow('desktop', 'e2'))
  expect((await dismissed.find({ type: 'Text', text: /^stayontarget: adjacent$/ })) !== undefined).toBe(true)
  expect((await dismissed.find({ type: 'Text', text: /^dismissed$/ })) !== undefined).toBe(true)
  expect((await dismissed.find({ type: 'Button', key: 'dismiss-e2' })) === undefined).toBe(true)
  await dismissed.unmount()
})

test('the band is hidden with no open drift or adjacent event (FR-UI-7)', async ($, on) => {
  stateBeneath(on, seeded([event('e1', 'drift', 'dismissed'), event('e2', 'in-scope')]))
  engine(on)

  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect((await ui.find({ type: 'Text', text: /^engine band$/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Button', key: 'band-review' })) === undefined).toBe(true)
    await ui.unmount()
  }
})

test('the band is hidden while a survey holds it, and on an agent transcript (FR-UI-7)', async ($, on) => {
  stateBeneath(on, seeded([event('e1')]))
  engine(on)

  const survey = await $.ui.mount(band('desktop', { hasSurvey: true }))
  expect((await survey.find({ type: 'Button', key: 'band-review' })) === undefined).toBe(true)
  await survey.unmount()

  const agent = await $.ui.mount(band('desktop', { agentId: 'a1' }))
  expect((await agent.find({ type: 'Button', key: 'band-review' })) === undefined).toBe(true)
  await agent.unmount()
})

test('the band shows the goal head and the counts, with Review and New task (FR-UI-7)', async ($, on) => {
  stateBeneath(on, seeded([event('e1'), event('e2', 'adjacent')]))
  engine(on)

  for (const surface of BAND_SURFACES) {
    const ui = await $.ui.mount(band(surface))
    expect((await ui.find({ type: 'Text', text: /^stayontarget: fix the parser · 1 drift · 1 adjacent$/ })) !== undefined).toBe(
      true,
    )
    expect((await ui.find({ type: 'Button', key: 'band-review' })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Button', key: 'band-new' })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

test('New task on the band clears the charter (FR-UI-7)', async ($, on) => {
  const state = stateBeneath(on, seeded([event('e1')]))
  engine(on)
  const ui = await $.ui.mount(band('desktop'))

  await ui.press({ key: 'band-new' })
  await ui.redraw()

  expect(state('charter')).toBeNull()
  await ui.unmount()
})

test('the band fits its body at 80, 50, 30 and 15 columns, text and button labels together (FR-UI-7)', async ($, on) => {
  const long = { ...seeded([event('e1'), event('e2', 'adjacent')]), charter: { ...CHARTER, goal: 'g'.repeat(40) } }
  stateBeneath(on, long)
  engine(on)

  for (const columns of [80, 50, 30, 15]) {
    const ui = await $.ui.mount(band('desktop', { columns }))
    const line = await ui.find({ type: 'Text', text: /(1 drift · 1 adjacent|1d · 1a)$/ })
    // The same width rule as the badge: the labels plus the engine's chrome, once for the group of buttons.
    const labels = (await ui.findAll({ type: 'Button' })).map(button => String(button.props.label))
    const buttons = labels.length === 0 ? 0 : labels.reduce((n, label) => n + label.length, 0) + 8
    const used = (line?.text.length ?? 0) + buttons

    expect(line !== undefined).toBe(true)
    expect(used).toBeLessThanOrEqual(columns)
    await ui.unmount()
  }
})

test('at 15 columns the band keeps the short counts and what is left of the goal (FR-UI-7)', async ($, on) => {
  const long = { ...seeded([event('e1'), event('e2', 'adjacent')]), charter: { ...CHARTER, goal: 'g'.repeat(40) } }
  stateBeneath(on, long)
  engine(on)

  // 15 columns less the short counts (7) and their separator (3) leave 5 cells for the goal: four letters and an ellipsis.
  const ui = await $.ui.mount(band('desktop', { columns: 15 }))
  expect((await ui.find({ type: 'Text', text: /^g{4}… · 1d · 1a$/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'band-review' })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'band-new' })) === undefined).toBe(true)
  await ui.unmount()
})

test('a goal with a newline is one band row (FR-UI-7)', async ($, on) => {
  stateBeneath(on, { ...seeded([event('e1')]), charter: { ...CHARTER, goal: 'fix parser\nupdate tests' } })
  engine(on)

  // At 120 columns the whole goal fits, so the check is that its newline is one space, on one row.
  const ui = await $.ui.mount(band('desktop', { columns: 120 }))
  expect((await ui.find({ type: 'Text', text: /^stayontarget: fix parser update tests · 1 drift · 0 adjacent$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a message that is not the footer is unchanged (FR-UI-8)', async ($, on) => {
  stateBeneath(on, seeded([event('e1')]))
  engine(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(message(surface, 'Edited the parser.'))
    expect((await ui.find({ type: 'Text', text: /^engine message$/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Markdown' })) === undefined).toBe(true)
    await ui.unmount()
  }
})

test('the footer has buttons for its open events only (FR-UI-8)', async ($, on) => {
  const events = [event('e1'), event('e2', 'adjacent', 'dismissed'), event('e3', 'in-scope')]
  stateBeneath(on, seeded(events))
  engine(on)

  const text = await drawnFooter($)
  const ui = await $.ui.mount(message('desktop', text))

  expect((await ui.find({ type: 'Text', text: /^stayontarget: out-of-scope actions this turn/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fallow-e1' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fdismiss-e1' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fallow-e2' })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fallow-e3' })) === undefined).toBe(true)
  await ui.unmount()
})

test('the footer has no buttons on mobile (FR-UI-8)', async ($, on) => {
  const events = [event('e1')]
  stateBeneath(on, seeded(events))
  engine(on)

  const ui = await $.ui.mount(message('mobile', await drawnFooter($)))
  expect((await ui.find({ type: 'Text', text: /^• drift: Edit src\/e1\.ts/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fallow-e1' })) === undefined).toBe(true)
  await ui.unmount()
})

test('Allow on the footer creates the allowance and marks the event allowed (FR-UI-8)', async ($, on) => {
  const events = [event('e1')]
  const state = stateBeneath(on, seeded(events))
  engine(on)
  const ui = await $.ui.mount(message('desktop', await drawnFooter($)))

  await ui.press({ key: 'fallow-e1' })
  await ui.redraw()

  expect(state('allowances')).toMatchObject([{ charterId: 'c1', tool: 'Edit', target: 'src/e1.ts' }])
  expect(state('events')[0].status).toBe('allowed')
  await ui.unmount()
})

test('two turns with identical event lines each show only their own footer buttons (FR-UI-8)', async ($, on) => {
  // The same tool, target and reason in both turns: only the turn differs.
  const first = { ...event('e1'), mainTurnId: 'turnAAAA-1' }
  const second = { ...event('e2'), target: 'src/e1.ts', mainTurnId: 'turnBBBB-2' }
  stateBeneath(on, seeded([first, second]))
  engine(on)
  const firstText = await drawnFooter($, 'turnAAAA-1')
  const secondText = await drawnFooter($, 'turnBBBB-2')

  const later = await $.ui.mount(message('desktop', secondText))
  expect((await later.find({ type: 'Button', key: 'fallow-e2' })) !== undefined).toBe(true)
  expect((await later.find({ type: 'Button', key: 'fallow-e1' })) === undefined).toBe(true)
  await later.unmount()

  const earlier = await $.ui.mount(message('desktop', firstText))
  expect((await earlier.find({ type: 'Button', key: 'fallow-e1' })) !== undefined).toBe(true)
  expect((await earlier.find({ type: 'Button', key: 'fallow-e2' })) === undefined).toBe(true)
  await earlier.unmount()
})

test('a footer the plugin did not draw, as after a reload, draws as the engine drew it (FR-UI-8)', async ($, on) => {
  const events = [event('e1')]
  stateBeneath(on, seeded(events))
  engine(on)
  // The same text the turn would end with, never drawn by turn.complete: the map holds no entry for it.
  const text = footerRows(events, 'turn-1')?.text ?? ''

  const ui = await $.ui.mount(message('desktop', text))
  expect((await ui.find({ type: 'Text', text: /^engine message$/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Markdown' })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fallow-e1' })) === undefined).toBe(true)
  await ui.unmount()
})

test('each footer bullet shares its row with its own buttons, and a closed event shows its status (FR-UI-8)', async ($, on) => {
  const dismissed = event('e1', 'drift', 'dismissed')
  const open = event('e2')
  stateBeneath(on, seeded([dismissed, open]))
  engine(on)

  const ui = await $.ui.mount(message('desktop', await drawnFooter($)))

  // The first bullet is closed: its status shows, and it has no buttons.
  expect((await ui.find({ type: 'Text', text: /^dismissed$/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fallow-e1' })) === undefined).toBe(true)
  // The second bullet is open: its text and its buttons are drawn, in that order, on its row.
  expect((await ui.find({ type: 'Text', text: /^• drift: Edit src\/e2\.ts/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fallow-e2' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fdismiss-e2' })) !== undefined).toBe(true)
  await ui.unmount()
})

test('footer bullets are never cut: the whole line is present at 80 and at 40 columns (FR-UI-8)', async ($, on) => {
  const long = { ...event('e1'), reason: 'a reason that is much longer than forty cells of text' }
  stateBeneath(on, seeded([long]))
  engine(on)
  const text = await drawnFooter($)

  for (const columns of [80, 40]) {
    const ui = await $.ui.mount({ ...message('desktop', text), viewport: { columns, rows: 24 } })
    expect((await ui.find({ type: 'Text', text: /^• drift: Edit src\/e1\.ts \(a reason that is much longer than forty cells of text\)$/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Button', key: 'fallow-e1' })) !== undefined).toBe(true)
    await ui.unmount()
  }
})

// The hover scope is engine-owned and not in the drawing the kit reports: this checks the drawn style, bold for a drift.
test('the badge verdict of a drift is drawn bold (FR-UI-6)', async ($, on) => {
  stateBeneath(on, seeded([event('e1')]))
  engine(on)

  const badge = await $.ui.mount(toolRow('desktop', 'e1'))
  const verdict = await badge.find({ type: 'Text', text: /^stayontarget: drift$/ })
  expect(verdict?.props.bold).toBe(true)
  await badge.unmount()
})

test('a reason with newlines is one bullet, and its buttons pair with its own event (FR-UI-8)', async ($, on) => {
  const multi = { ...event('e1'), reason: 'first line\nsecond line' }
  stateBeneath(on, seeded([multi, event('e2')]))
  engine(on)

  const ui = await $.ui.mount(message('desktop', await drawnFooter($)))

  expect((await ui.find({ type: 'Text', text: /^• drift: Edit src\/e1\.ts \(first line second line\)$/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^• drift: Edit src\/e2\.ts/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fallow-e1' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'fallow-e2' })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a badge reason with newlines stays one line (FR-UI-6)', async ($, on) => {
  stateBeneath(on, seeded([{ ...event('e1'), reason: 'first\nsecond' }]))
  engine(on)

  const ui = await $.ui.mount(toolRow('desktop', 'e1'))
  expect((await ui.find({ type: 'Text', text: /^ — first second$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a badge reason with a control character draws it as an escape (FR-UI-6)', async ($, on) => {
  stateBeneath(on, seeded([{ ...event('e1'), reason: 'bell\u0007' }]))
  engine(on)

  const ui = await $.ui.mount(toolRow('desktop', 'e1'))
  expect((await ui.find({ type: 'Text', text: /^ — bell\\x07$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('a footer bullet with a control character draws it as an escape (FR-UI-8)', async ($, on) => {
  stateBeneath(on, seeded([{ ...event('e1'), reason: 'bell\u0007' }]))
  engine(on)

  const ui = await $.ui.mount(message('desktop', await drawnFooter($)))
  expect((await ui.find({ type: 'Text', text: /^• drift: Edit src\/e1\.ts \(bell\\x07\)$/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('the footer head names its turn (FR-UI-8)', () => {
  const text = footerRows([event('e1')], 'turn-1')?.text ?? ''
  expect(text.startsWith(footerHead('turn-1'))).toBe(true)
  expect(footerHead('turnAAAAAAAA-9')).toBe('stayontarget: out-of-scope actions this turn (turnAAAA)')
})

test('at 40 columns the badge buttons move to a line of their own and the reason keeps the width (FR-UI-6)', async ($, on) => {
  stateBeneath(on, seeded([{ ...event('e1'), reason: 'x'.repeat(60) }]))
  engine(on)

  const ui = await $.ui.mount(toolRow('desktop', 'e1', 40))

  // 40 cells less the label (19) leave 21: the reason keeps 17 letters after " — " and its ellipsis.
  expect((await ui.find({ type: 'Text', text: /^ — x{17}…$/ })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'allow-e1' })) !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'dismiss-e1' })) !== undefined).toBe(true)
  await ui.unmount()
})
