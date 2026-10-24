import { expect, test } from 'claude-code/testing'

import { boundedCwd } from '../hooks/register'
import { EMPTY_STATS, EVENTS_CAP, allowancesAtom, charterAtom, eventsAtom, statsAtom } from '../src/state'

test('session.start passes through the plugin', async ($, on) => {
  // The engine stands beneath the plugin: its answer reaches the plugin as given.
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  const result = await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(result).toEqual({ cwd: '/' })
})

test('each state atom names its key and starts at the brief\'s initial value', () => {
  expect(charterAtom.ref).toEqual({ plugin: 'stayontarget', key: 'charter' })
  expect(charterAtom.initial).toBe(null)
  expect(eventsAtom.ref).toEqual({ plugin: 'stayontarget', key: 'events' })
  expect(eventsAtom.initial).toEqual([])
  expect(allowancesAtom.ref).toEqual({ plugin: 'stayontarget', key: 'allowances' })
  expect(allowancesAtom.initial).toEqual([])
  expect(statsAtom.ref).toEqual({ plugin: 'stayontarget', key: 'stats' })
  expect(statsAtom.initial).toEqual(EMPTY_STATS)
})

test('the initial stats are all zero with no failure', () => {
  expect(EMPTY_STATS).toEqual({
    judged: 0,
    cacheHits: 0,
    allowanceHits: 0,
    unchecked: 0,
    inputTokens: 0,
    outputTokens: 0,
    charterUpdates: 0,
    charterFailures: 0,
    persistFailed: false,
  })
})

test('a call directory that holds a credential, or is too long, is not kept (FR-AX-3, FR-UI-10)', () => {
  // The secret never reaches state: a directory that redaction would change is stored as null, so no link is made from it.
  expect(boundedCwd('/work/token=supersecret/project')).toBeNull()
  expect(boundedCwd('/work/project')).toBe('/work/project')
  expect(boundedCwd('x'.repeat(1025))).toBeNull()
  expect(boundedCwd('x'.repeat(1024))).toBe('x'.repeat(1024))
  expect(boundedCwd(null)).toBeNull()
})

test('the events cap is 200', () => {
  expect(EVENTS_CAP).toBe(200)
})
