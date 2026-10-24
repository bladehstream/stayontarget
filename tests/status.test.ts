import { expect, test } from 'claude-code/testing'

import type { Charter, DriftEvent, Stats } from '../types'
import { EMPTY_STATS } from '../src/state'
import { belongsHere, statusText } from '../src/status'

const charter: Charter = {
  id: 'c1',
  rev: 2,
  request: 'fix the parser',
  goal: 'fix the parser',
  inScope: [],
  outOfScope: [],
  distilled: true,
  editedFields: [],
  pendingText: [],
  createdAt: 0,
}

function event(verdict: DriftEvent['verdict'], overrides: Partial<DriftEvent> = {}): DriftEvent {
  return {
    id: `e-${verdict}-${Math.random()}`,
    toolUseId: 't',
    charterId: 'c1',
    charterRev: 2,
    mainTurnId: 'turn-1',
    agentId: null,
    tool: 'Edit',
    target: 'src/a.ts',
    verdict,
    reason: 'r',
    excerpt: '',
    cwd: null,
    source: 'judge',
    action: 'note',
    status: 'open',
    at: 0,
    ...overrides,
  }
}

const stats = (overrides: Partial<Stats> = {}): Stats => ({ ...EMPTY_STATS, ...overrides })

test('membership: the charter id, or a charter-less event dated at or after the charter (FR-RS-6, FR-UI-2)', () => {
  const noCharter = { ...event('unchecked'), charterId: null }
  expect(belongsHere(charter, event('drift'))).toBe(true)
  expect(belongsHere(charter, { ...event('drift'), charterId: 'c0' })).toBe(false)
  expect(belongsHere(charter, { ...noCharter, at: 0 })).toBe(true)
  expect(belongsHere(charter, { ...noCharter, at: -1 })).toBe(false)
  expect(belongsHere({ ...charter, createdAt: 10 }, { ...noCharter, at: 9 })).toBe(false)
})

test('with no charter the line says so (FR-RS-6)', () => {
  expect(statusText(null, [], stats())).toBe('stayontarget: no charter yet')
})

test('a charter with no open findings is on target (FR-RS-6)', () => {
  expect(statusText(charter, [], stats())).toBe('stayontarget: on target')
})

test('open drift and adjacent counts are shown, zero parts omitted (FR-RS-6)', () => {
  expect(statusText(charter, [event('drift'), event('drift')], stats())).toBe('stayontarget: 2 drift')
  expect(statusText(charter, [event('adjacent')], stats())).toBe('stayontarget: 1 adjacent')
  expect(statusText(charter, [event('drift'), event('adjacent'), event('adjacent')], stats())).toBe(
    'stayontarget: 1 drift · 2 adjacent',
  )
})

test('only open findings count; dismissed or allowed ones do not (FR-RS-6)', () => {
  const events = [event('drift', { status: 'allowed' }), event('adjacent', { status: 'dismissed' })]

  expect(statusText(charter, events, stats())).toBe('stayontarget: on target')
})

test('findings of another charter do not count (FR-RS-6)', () => {
  expect(statusText(charter, [event('drift', { charterId: 'old' })], stats())).toBe('stayontarget: on target')
})

test('unchecked verdicts add to the findings line when there are findings (FR-RS-6)', () => {
  const events = [event('drift'), event('unchecked', { action: 'unchecked' }), event('unchecked', { action: 'unchecked' })]

  expect(statusText(charter, events, stats())).toBe('stayontarget: 1 drift · 2 unchecked')
})

test('unchecked verdicts alone make the line degraded (FR-RS-6)', () => {
  const events = [event('unchecked', { action: 'unchecked' })]

  expect(statusText(charter, events, stats())).toBe('stayontarget: degraded (1 unchecked)')
})

test('a charter with a task that is not distilled says so, after any counts (FR-CH-7, FR-RS-6)', () => {
  const undistilled = { ...charter, distilled: false, rev: 1 }

  expect(statusText(undistilled, [], stats())).toBe('stayontarget: on target · charter not distilled')
  expect(statusText(undistilled, [event('drift')], stats())).toBe('stayontarget: 1 drift · charter not distilled')
  expect(statusText(undistilled, [event('unchecked', { action: 'unchecked' })], stats())).toBe(
    'stayontarget: degraded (1 unchecked) · charter not distilled',
  )
})

test('a charter with no task yet is not called undistilled (FR-RS-6)', () => {
  expect(statusText({ ...charter, distilled: false, request: '', rev: 0 }, [], stats())).toBe('stayontarget: on target')
})

test('an unchecked decision with no charter counts when it is newer than the charter (FR-RS-6)', () => {
  const noCharter = event('unchecked', { charterId: null, action: 'unchecked', at: 5 })
  const older = event('unchecked', { charterId: null, action: 'unchecked', at: 9 })

  expect(statusText(charter, [noCharter], stats())).toBe('stayontarget: degraded (1 unchecked)')
  expect(statusText({ ...charter, createdAt: 10 }, [older], stats())).toBe('stayontarget: on target')
})

test('a failed save is appended to any line (FR-RS-6)', () => {
  const failed = stats({ persistFailed: true })

  expect(statusText(charter, [], failed)).toBe('stayontarget: on target · not saved')
  expect(statusText(charter, [event('drift')], failed)).toBe('stayontarget: 1 drift · not saved')
  expect(statusText(null, [], failed)).toBe('stayontarget: no charter yet · not saved')
})
