import { expect, test } from 'claude-code/testing'

import type { Charter, DriftEvent, Verdict } from '../types'
import { stripCells, stripSummary, stripSvg, stripText } from '../src/strip'

const CHARTER: Charter = {
  id: 'c1',
  rev: 1,
  request: 'fix the parser',
  goal: 'fix the parser',
  inScope: [],
  outOfScope: [],
  distilled: true,
  editedFields: [],
  pendingText: [],
  createdAt: 0,
}

function event(id: number, verdict: Verdict, charterId: string | null = 'c1'): DriftEvent {
  return {
    id: `e${id}`,
    toolUseId: `tool-${id}`,
    charterId,
    charterRev: 1,
    mainTurnId: null,
    agentId: null,
    tool: 'Edit',
    target: `src/${id}.ts`,
    verdict,
    reason: '',
    excerpt: '',
    cwd: null,
    source: 'judge',
    action: 'none',
    status: 'open',
    at: id,
  }
}

test('the cells are the last events of the charter, oldest first, capped at the max (FR-UI-10)', () => {
  const events = [event(1, 'drift'), event(2, 'in-scope', 'other'), event(3, 'adjacent'), event(4, 'unchecked')]
  expect(stripCells(events, CHARTER)).toEqual(['drift', 'adjacent', 'unchecked'])
  expect(stripCells(events, CHARTER, 2)).toEqual(['adjacent', 'unchecked'])
  expect(stripCells(events, null)).toEqual([])
})

test('the default cap is 30 cells (FR-UI-10)', () => {
  const events = Array.from({ length: 40 }, (_, i) => event(i, i % 2 === 0 ? 'drift' : 'in-scope'))
  const cells = stripCells(events, CHARTER)
  expect(cells).toHaveLength(30)
  expect(cells[29]).toBe('in-scope')
})

test('an unchecked event with no charter id counts when it is newer than the charter (FR-UI-10)', () => {
  const unchecked = { ...event(5, 'unchecked', null), at: 5 }
  expect(stripCells([unchecked], { ...CHARTER, createdAt: 1 })).toEqual(['unchecked'])
})

test('the SVG has one 8 by 12 rect per cell, 2 pixels apart, coloured by verdict (FR-UI-10)', () => {
  const svg = stripSvg(['drift', 'adjacent', 'in-scope', 'unchecked'])

  expect(svg.startsWith('<svg')).toBe(true)
  expect(svg).toContain('width="38" height="12"')
  expect(svg.match(/<rect /g)).toHaveLength(4)
  expect(svg).toContain('<rect x="0" y="0" width="8" height="12" fill="#d1453b"/>')
  expect(svg).toContain('<rect x="10" y="0" width="8" height="12" fill="#d9a400"/>')
  expect(svg).toContain('<rect x="20" y="0" width="8" height="12" fill="#3a9d5d"/>')
  expect(svg).toContain('<rect x="30" y="0" width="8" height="12" fill="#888888"/>')
  expect(svg).toContain('<title>4 events: 1 drift, 1 adjacent, 1 in scope, 1 unchecked</title>')
})

test('the text strip is one glyph per cell (FR-UI-10)', () => {
  expect(stripText(['drift', 'adjacent', 'in-scope', 'unchecked'])).toBe('█▓░·')
  expect(stripText([])).toBe('')
})

test('the summary names the counts, and says so when there are none', () => {
  expect(stripSummary([])).toBe('no events')
  expect(stripSummary(['drift', 'drift'])).toBe('2 events: 2 drift, 0 adjacent, 0 in scope, 0 unchecked')
})
