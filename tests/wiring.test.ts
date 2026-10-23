import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { ModelCompleteResult, On } from 'claude-code'

import { __atoms as charterAtoms } from '../src/charter'
import { __atoms as judgeAtoms } from '../src/judge'
import { __atoms as eventAtoms } from '../src/events'
import { __atoms as statusAtoms } from '../src/status'
import * as shared from '../src/state'

// The hooks of the plugin under test, driven through the kit. The engine answers beneath them; the test's bottom hooks
// stand in for the model, the tools and the UI. The plugin's state is not on the test's `$`, so the assertions read what
// the plugin shows: the verdict notes, the status line, the turn footer, and the charter's pending text as the charter
// call sends it to the model.

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SESSION = { cwd: 'C:\\repo', surface: 'desktop' as const, isInteractive: true }
const TURN = { text: 'fix the parser', turnId: 'turn-1' }
const EDIT = { file_path: 'C:\\repo\\src\\parser.ts', old_string: 'a', new_string: 'b' }
const NOTES = { file_path: 'C:\\repo\\docs\\notes.md', old_string: 'a', new_string: 'b' }
const COMMAND_TEXT =
  '<command-message>fixit</command-message>\n<command-name>/fixit</command-name>\n<command-args>hello world</command-args>'
const NOTE =
  'stayontarget: this Edit on docs/notes.md looks outside the current request ("fix the parser"): touches an unrelated file. If it is needed, say so to the user; otherwise stop making out-of-scope changes. Disclose any out-of-scope change in your summary.'

type Reply = ModelCompleteResult
type Hold = (reply: Reply) => void

const GOALS = ['fix the parser', 'write the docs']

const said = (value: unknown): Reply => ({ isAnswered: true, text: JSON.stringify(value), usage: USAGE })
const judged = (verdict: string, reason = 'touches an unrelated file'): Reply => said({ verdict, reason })

// The model beneath the plugin. A charter call is answered at once with a new task, and its request is kept for the test to
// read; each judge call is held until the test answers it, so the test decides when a verdict settles.
function model(on: On) {
  const held: Hold[] = []
  const charterAsks: string[] = []
  let calls = 0
  on('model.complete', async (_, request) => {
    calls += 1
    const body = request.promptBlocks?.[1]?.text ?? ''
    if (body.startsWith('CURRENT CHARTER')) {
      charterAsks.push(body)
      // Each charter call answers with the next goal, so a test can see a charter change under a verdict still out.
      const goal = GOALS[charterAsks.length - 1] ?? GOALS[0]
      return { value: said({ kind: 'new-task', goal, inScope: ['src/parser.ts'], outOfScope: [] }) }
    }
    return { value: await new Promise<Reply>(resolve => held.push(resolve)) }
  })
  return { held, charterAsks, calls: () => calls }
}

// Lets the plugin run until `count` judge calls are held. Bounded, so a missing judge call fails the test rather than hanging.
async function untilJudged(clock: MockClock, held: Hold[], count = 1): Promise<void> {
  for (let turn = 0; held.length < count; turn++) {
    if (turn === 100) throw new Error('no judge call was made')
    await clock.settle()
  }
}

async function answer(clock: MockClock, held: Hold[], reply: Reply): Promise<void> {
  await untilJudged(clock, held)
  held.shift()?.(reply)
  await clock.settle()
}

// What the engine answers beneath the plugin for the events these tests drive. Returns the status lines shown, oldest first.
function beneath(on: On): string[] {
  const statuses: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('ui.log', (_, e, next) => next(e))
  on('ui.status', (_, e, next) => {
    statuses.push(e.text ?? '')
    return next(e)
  })
  return statuses
}

// Each module declares its own atoms (the engine's scan needs them in the calling file); each must name the same ref and
// initial value as src/state.ts, or the module would read and write a different slot.
test('the atoms each module declares match src/state.ts in ref and initial value', () => {
  const local = [charterAtoms, judgeAtoms, eventAtoms, statusAtoms]
  for (const atoms of local) {
    for (const [name, atom] of Object.entries(atoms)) {
      const want = shared[name as keyof typeof shared] as { ref: unknown; initial: unknown }
      expect(atom.ref).toEqual(want.ref)
      expect(atom.initial).toEqual(want.initial)
    }
  }
})

async function start($: Engine): Promise<void> {
  await $.session.start(SESSION)
  await $.turn.start(TURN)
}

test('a read-only call is not judged: no model call, no status change (FR-VD-2)', async ($, on) => {
  mock.clock(on)
  const { calls } = model(on)
  const statuses = beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await start($)

  const check = await $.tool.check({
    tool: 'Read',
    input: { file_path: EDIT.file_path },
    isReadOnly: true,
    tool_use_id: 'read-1',
  })

  expect(check.decision).toBe('allow')
  expect(calls()).toBe(0)
  // Only the main turn's start shows a status; the read-only check changes nothing.
  expect(statuses).toEqual(['stayontarget: on target'])
})

test('a call the beneath verdict denies is not judged and waits for nothing (FR-VD-1, FR-VD-7)', async ($, on) => {
  mock.clock(on)
  const { calls, held } = model(on)
  const statuses = beneath(on)
  on('tool.check', () => ({ decision: 'deny', reason: 'no' }))
  on('tool.call', () => ({ result: 'edited' }))
  await start($)

  const result = await $.tool.call({ tool: 'Edit', ...NOTES })

  expect(result.context).toBeUndefined()
  expect(held.length).toBe(0)
  expect(calls()).toBe(0)
  expect(statuses).toEqual(['stayontarget: on target'])
})

test('a call with no verdict entry returns its result at once (FR-VD-7)', async ($, on) => {
  mock.clock(on)
  model(on)
  beneath(on)
  on('tool.check', () => ({ decision: 'deny', reason: 'no' }))
  on('tool.call', () => ({ result: 'edited', context: ['kept'] }))
  await start($)

  // The clock never moves: a call that waited for a verdict would never return.
  const result = await $.tool.call({ tool: 'Edit', ...NOTES })

  expect(result.context).toBeUndefined()
})

test('warn: a drift on a finished call gets a model note and shows in the status line (FR-RS-1)', async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  const statuses = beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'edited', context: ['existing context'] }))
  await start($)

  const call = $.tool.call({ tool: 'Edit', ...NOTES })
  await answer(clock, held, judged('drift'))
  const result = await call

  expect(result.context).toEqual(['existing context', NOTE])
  expect(statuses.at(-1)).toBe('stayontarget: 1 drift')
})

test('warn: a drift on a failed call gets no note (FR-RS-1)', async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  const statuses = beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'failed', isError: true }))
  await start($)

  const call = $.tool.call({ tool: 'Edit', ...NOTES })
  await answer(clock, held, judged('drift'))
  const result = await call

  expect(result.context).toBeUndefined()
  expect(statuses.at(-1)).toBe('stayontarget: 1 drift')
})

test('warn: an adjacent verdict is recorded with no note (FR-RS-2)', async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  const statuses = beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'edited' }))
  await start($)

  const call = $.tool.call({ tool: 'Edit', ...NOTES })
  await answer(clock, held, judged('adjacent', 'adds a test'))
  const result = await call

  expect(result.context).toBeUndefined()
  expect(statuses.at(-1)).toBe('stayontarget: 1 adjacent')
})

test('warn: a verdict that settles after the call returned is recorded with no note (FR-VD-8)', async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  const statuses = beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'edited' }))
  await start($)

  const call = $.tool.call({ tool: 'Edit', ...NOTES })
  await untilJudged(clock, held)
  // The judge is still out at 7 s: the call returns without a note, and the verdict settles later.
  await clock.advance(7000)
  const result = await call
  expect(result.context).toBeUndefined()
  expect(statuses).toEqual(['stayontarget: on target'])

  held.shift()?.(judged('drift'))
  await clock.settle()

  expect(statuses.at(-1)).toBe('stayontarget: 1 drift')
})

test('strict: a drift asks with the reason and shows in the status line (FR-RS-3)', { options: { mode: 'strict' } }, async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  const statuses = beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await start($)

  const check = $.tool.check({ tool: 'Edit', input: NOTES, tool_use_id: 'edit-strict-1' })
  await answer(clock, held, judged('drift'))
  const result = await check

  expect(result.decision).toBe('ask')
  expect(result.reason).toBe('stayontarget: outside the request ("fix the parser"): touches an unrelated file')
  expect(statuses.at(-1)).toBe('stayontarget: 1 drift')
})

test('strict: an in-scope verdict keeps the beneath verdict (FR-RS-4)', { options: { mode: 'strict' } }, async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  const statuses = beneath(on)
  on('tool.check', () => ({ decision: 'allow', reason: 'rule' }))
  await start($)

  const check = $.tool.check({ tool: 'Edit', input: EDIT, tool_use_id: 'edit-strict-2' })
  await answer(clock, held, judged('in-scope', 'names the parser'))
  const result = await check

  expect(result.decision).toBe('allow')
  expect(result.reason).toBe('rule')
  expect(statuses.at(-1)).toBe('stayontarget: on target')
})

test('strict: a failed judge keeps the beneath verdict and shows the call as unchecked (FR-RS-4, FR-VD-5)', { options: { mode: 'strict' } }, async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  const statuses = beneath(on)
  on('tool.check', () => ({ decision: 'allow', reason: 'rule' }))
  await start($)

  const check = $.tool.check({ tool: 'Edit', input: EDIT, tool_use_id: 'edit-strict-3' })
  await answer(clock, held, { isAnswered: false, reason: 'api-error', status: 500, error: 'overloaded', usage: USAGE })
  const result = await check

  expect(result.decision).toBe('allow')
  expect(result.reason).toBe('rule')
  expect(statuses.at(-1)).toBe('stayontarget: degraded (1 unchecked)')
})

test('a subagent call is judged against the active main turn, and its drift shows in that turn\'s footer (FR-CH-9)', async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'edited' }))
  await start($)

  const call = $.tool.call({ tool: 'Edit', ...NOTES, agentId: 'agent-1' })
  await answer(clock, held, judged('drift'))
  await call
  const done = await $.turn.complete({ turnId: 'turn-1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' })

  expect(done.text).toBe('stayontarget: out-of-scope actions this turn\n• drift: Edit docs/notes.md (touches an unrelated file)')
})

test('a slash command and the skill body it fires reach the charter as pending text (FR-CH-3)', async ($, on) => {
  const clock = mock.clock(on)
  const { held, charterAsks } = model(on)
  beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await $.session.start(SESSION)

  await $.prompt.submit({ text: '/fixit hello world', command: { name: 'fixit', args: 'hello world' }, origin: { kind: 'composer' }, wait: false })
  await $.skill.prompt({ skill: 'fixit', text: 'SKILL BODY', frontmatter: {}, source: 'userSettings' })
  await $.turn.start({ text: COMMAND_TEXT, turnId: 'turn-1' })
  const check = $.tool.check({ tool: 'Edit', input: EDIT, tool_use_id: 'slash-1' })
  await answer(clock, held, judged('in-scope', 'names the parser'))
  await check

  expect(charterAsks.at(-1)).toContain(`${COMMAND_TEXT}\nSKILL BODY`)
})

test('a skill prompt with no command mark is ignored (FR-CH-3)', async ($, on) => {
  const clock = mock.clock(on)
  const { held, charterAsks } = model(on)
  beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await $.session.start(SESSION)

  await $.skill.prompt({ skill: 'fixit', text: 'SKILL BODY', frontmatter: {}, source: 'userSettings' })
  await $.turn.start(TURN)
  const check = $.tool.check({ tool: 'Edit', input: EDIT, tool_use_id: 'skill-1' })
  await answer(clock, held, judged('in-scope', 'names the parser'))
  await check

  expect(charterAsks.at(-1)).toContain(`1. ${TURN.text}`)
  expect(charterAsks.at(-1)).not.toContain('SKILL BODY')
})

test('a delivered prompt is captured as the session stored it, after a hook beneath rewrote it (FR-CH-6)', async ($, on) => {
  const clock = mock.clock(on)
  const { held, charterAsks } = model(on)
  beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  // Stands beneath the plugin: the row the session stores is the rewritten one.
  on('session.append', (_, e, next) =>
    next({ ...e, message: { ...e.message, content: [{ type: 'text', text: 'rewritten by a hook' }] } }),
  )
  await start($)

  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'also update the tests' }] },
    door: 'delivery',
    origin: { kind: 'composer' },
    uuid: 'delivery-2',
  })
  const check = $.tool.check({ tool: 'Edit', input: EDIT, tool_use_id: 'delivery-check-2' })
  await answer(clock, held, judged('in-scope', 'names the parser'))
  await check

  expect(charterAsks.at(-1)).toContain('rewritten by a hook')
  expect(charterAsks.at(-1)).not.toContain('also update the tests')
})

test('a prompt delivered into a running turn reaches the charter as pending text (FR-CH-6)', async ($, on) => {
  const clock = mock.clock(on)
  const { held, charterAsks } = model(on)
  beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await start($)

  await $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'also update the tests' }] },
    door: 'delivery',
    origin: { kind: 'composer' },
    uuid: 'delivery-1',
  })
  const check = $.tool.check({ tool: 'Edit', input: EDIT, tool_use_id: 'delivery-check-1' })
  await answer(clock, held, judged('in-scope', 'names the parser'))
  await check

  expect(charterAsks.at(-1)).toContain('also update the tests')
})

test('a turn footer lists its out-of-scope events and never repeats the answer (FR-RS-5)', async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'edited' }))
  await start($)

  const call = $.tool.call({ tool: 'Edit', ...NOTES })
  await answer(clock, held, judged('drift'))
  await call
  const done = await $.turn.complete({
    turnId: 'turn-1',
    answer: 'Done: edited the notes.',
    durationMs: 10,
    isAborted: false,
    reason: 'answer',
  })

  expect(done.text).toBe('stayontarget: out-of-scope actions this turn\n• drift: Edit docs/notes.md (touches an unrelated file)')
})

test('a note quotes the charter its verdict was judged against, not a newer one (FR-VD-3)', async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  beneath(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'edited' }))
  await start($)

  const call = $.tool.call({ tool: 'Edit', ...NOTES })
  await untilJudged(clock, held)
  // A new request resolves into a new charter while the first verdict is still out.
  await $.turn.start({ text: 'write the docs', turnId: 'turn-2' })
  const newer = $.tool.check({ tool: 'Edit', input: EDIT, tool_use_id: 'newer-1' })
  await untilJudged(clock, held, 2)
  held.shift()?.(judged('drift'))
  await clock.settle()
  const result = await call

  expect(result.context?.at(-1)).toContain('("fix the parser")')
  await answer(clock, held, judged('in-scope', 'names the docs'))
  await newer
})

test('a relative target is taken from the directory the call runs in, not the one the session started in (FR-AX-4)', async ($, on) => {
  const clock = mock.clock(on)
  const { held } = model(on)
  beneath(on)
  on('session.cwd', () => ({ value: 'D:\\other' }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => ({ result: 'edited' }))
  await start($)

  const call = $.tool.call({ tool: 'Edit', file_path: 'D:\\other\\docs\\notes.md', old_string: 'a', new_string: 'b' })
  await answer(clock, held, judged('drift'))
  const result = await call

  expect(result.context?.at(-1)).toContain('on docs/notes.md')
})

test('the status line shows the charter as soon as a main turn starts, with no tool call (FR-RS-6)', async ($, on) => {
  mock.clock(on)
  model(on)
  const statuses = beneath(on)
  await $.session.start(SESSION)
  await $.turn.start(TURN)

  expect(statuses.at(-1)).toBe('stayontarget: on target')
})

test('a turn with nothing out of scope, and a subagent turn, keep their answer (FR-RS-5)', async ($, on) => {
  mock.clock(on)
  model(on)
  beneath(on)
  await start($)

  const plain = await $.turn.complete({ turnId: 'turn-1', answer: 'Done.', durationMs: 1, isAborted: false, reason: 'answer' })
  const sub = await $.turn.complete({
    turnId: 'turn-1',
    agentId: 'agent-1',
    answer: 'Sub.',
    durationMs: 1,
    isAborted: false,
    reason: 'answer',
  })

  expect(plain.text).toBe('Done.')
  expect(sub.text).toBe('Sub.')
})
