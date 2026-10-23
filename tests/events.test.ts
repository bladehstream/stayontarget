import { expect, test } from 'claude-code/testing'
import { read } from 'claude-code'

import type { DriftEvent } from '../types'
import { eventsForTurn, footerText, newEventId, recordEvent, setEventAction } from '../src/events'
import { EVENTS_CAP, eventsAtom } from '../src/state'
import { world } from './fake'

function event(id: string, overrides: Partial<DriftEvent> = {}): DriftEvent {
  return {
    id,
    toolUseId: `t-${id}`,
    charterId: 'c1',
    charterRev: 1,
    mainTurnId: 'turn-1',
    agentId: null,
    tool: 'Edit',
    target: `src/${id}.ts`,
    verdict: 'drift',
    reason: 'touches an unrelated file',
    source: 'judge',
    action: 'note',
    status: 'open',
    at: 0,
    ...overrides,
  }
}

// The events the fake store holds for the plugin's events atom.
async function stored(w: ReturnType<typeof world>): Promise<DriftEvent[]> {
  return read(w.$, eventsAtom)
}

test('each event id is a fresh UUID (FR-ST-2)', () => {
  const first = newEventId()
  const second = newEventId()

  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  expect(second).not.toBe(first)
})

test('recorded events are appended oldest first', async () => {
  const w = world()

  await recordEvent(w.$, event('e1'))
  await recordEvent(w.$, event('e2'))

  expect((await stored(w)).map(ev => ev.id)).toEqual(['e1', 'e2'])
})

test('the list keeps the newest EVENTS_CAP events and drops the oldest', async () => {
  const w = world()

  for (let i = 0; i <= EVENTS_CAP; i++) await recordEvent(w.$, event(`e${i}`))

  const kept = await stored(w)
  expect(kept.length).toBe(EVENTS_CAP)
  expect(kept[0]?.id).toBe('e1')
  expect(kept[kept.length - 1]?.id).toBe(`e${EVENTS_CAP}`)
})

test('an in-scope verdict from a cache or allowance hit is not listed (FR-VD-3)', async () => {
  const w = world()

  await recordEvent(w.$, event('cached', { verdict: 'in-scope', source: 'cache', action: 'none' }))
  await recordEvent(w.$, event('allowed', { verdict: 'in-scope', source: 'allowance', action: 'none' }))
  await recordEvent(w.$, event('judged', { verdict: 'in-scope', source: 'judge', action: 'none' }))

  expect((await stored(w)).map(ev => ev.id)).toEqual(['judged'])
})

test('unchecked, adjacent and drift verdicts are always listed', async () => {
  const w = world()

  await recordEvent(w.$, event('u', { verdict: 'unchecked', source: 'none', action: 'unchecked' }))
  await recordEvent(w.$, event('a', { verdict: 'adjacent', action: 'none' }))
  await recordEvent(w.$, event('d', { verdict: 'drift', action: 'note' }))

  expect((await stored(w)).map(ev => ev.id)).toEqual(['u', 'a', 'd'])
})

test('setEventAction changes the action of the event for that tool call only', async () => {
  const w = world()
  await recordEvent(w.$, event('e1', { toolUseId: 'tool-a', action: 'note' }))
  await recordEvent(w.$, event('e2', { toolUseId: 'tool-b', action: 'note' }))

  await setEventAction(w.$, 'tool-a', 'none')

  const events = await stored(w)
  expect(events.map(ev => [ev.id, ev.action])).toEqual([
    ['e1', 'none'],
    ['e2', 'note'],
  ])
})

test('setEventAction for a call with no event leaves the list as it is', async () => {
  const w = world()
  await recordEvent(w.$, event('e1', { toolUseId: 'tool-a', action: 'note' }))

  await setEventAction(w.$, 'missing', 'none')

  expect((await stored(w))[0]?.action).toBe('note')
})

test('eventsForTurn keeps the adjacent and drift events of one main turn, oldest first (FR-RS-5)', () => {
  const events = [
    event('d1', { mainTurnId: 'turn-1', verdict: 'drift' }),
    event('a0', { mainTurnId: 'turn-2', verdict: 'adjacent' }),
    event('ok', { mainTurnId: 'turn-1', verdict: 'in-scope', action: 'none' }),
    event('a1', { mainTurnId: 'turn-1', verdict: 'adjacent' }),
    event('u1', { mainTurnId: 'turn-1', verdict: 'unchecked', action: 'unchecked' }),
  ]

  expect(eventsForTurn(events, 'turn-1').map(ev => ev.id)).toEqual(['d1', 'a1'])
})

test('footerText is null when there are no events to show', () => {
  expect(footerText([])).toBeNull()
  expect(footerText([event('ok', { verdict: 'in-scope', action: 'none' })])).toBeNull()
})

test('footerText lists each event as a bullet under the heading (FR-RS-5)', () => {
  const events = [
    event('d1', { tool: 'Write', target: 'docs/a.md', verdict: 'drift', reason: 'unrelated doc' }),
    event('a1', { tool: 'Bash', target: 'npm test', verdict: 'adjacent', reason: 'a test run' }),
  ]

  expect(footerText(events)).toBe(
    [
      'stayontarget: out-of-scope actions this turn',
      '• drift: Write docs/a.md (unrelated doc)',
      '• adjacent: Bash npm test (a test run)',
    ].join('\n'),
  )
})

test('footerText shows ten bullets, then the count of the rest', () => {
  const events = Array.from({ length: 12 }, (_, i) => event(`d${i}`, { target: `src/${i}.ts` }))

  const lines = (footerText(events) ?? '').split('\n')

  expect(lines.length).toBe(1 + 10 + 1)
  expect(lines[10]).toBe('• drift: Edit src/9.ts (touches an unrelated file)')
  expect(lines[11]).toBe('…and 2 more')
})
