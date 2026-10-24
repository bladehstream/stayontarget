import type { Charter, DriftEvent, Verdict } from '../types'

import { belongsHere } from './status'

// FR-UI-10: the verdict strip shows the last STRIP_MAX events of the charter, one cell each.
export const STRIP_MAX = 30

const CELL_WIDTH = 8
const CELL_GAP = 2
const CELL_HEIGHT = 12

const COLOURS: Record<Verdict, string> = {
  drift: '#d1453b',
  adjacent: '#d9a400',
  'in-scope': '#3a9d5d',
  unchecked: '#888888',
}

const GLYPHS: Record<Verdict, string> = {
  drift: '█',
  adjacent: '▓',
  'in-scope': '░',
  unchecked: '·',
}

// The cells of the strip: the last `max` events that belong to the charter, oldest first (FR-UI-10).
export function stripCells(events: DriftEvent[], charter: Charter | null, max = STRIP_MAX): Verdict[] {
  if (charter === null) return []
  const cells: Verdict[] = []
  for (let i = events.length - 1; i >= 0 && cells.length < max; i--) {
    const event = events[i]
    if (event !== undefined && belongsHere(charter, event)) cells.push(event.verdict)
  }
  return cells.reverse()
}

// The counts a strip summarises, as the words an alt text or a title reads.
export function stripSummary(cells: Verdict[]): string {
  if (cells.length === 0) return 'no events'
  const count = (verdict: Verdict) => cells.filter(cell => cell === verdict).length
  return `${cells.length} events: ${count('drift')} drift, ${count('adjacent')} adjacent, ${count('in-scope')} in scope, ${count('unchecked')} unchecked`
}

// The strip as an SVG document: one rect per cell, CELL_GAP pixels apart, coloured by verdict (FR-UI-10).
export function stripSvg(cells: Verdict[]): string {
  const width = Math.max(0, cells.length * (CELL_WIDTH + CELL_GAP) - CELL_GAP)
  const rects = cells
    .map((cell, i) => `<rect x="${i * (CELL_WIDTH + CELL_GAP)}" y="0" width="${CELL_WIDTH}" height="${CELL_HEIGHT}" fill="${COLOURS[cell]}"/>`)
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CELL_HEIGHT}" viewBox="0 0 ${width} ${CELL_HEIGHT}"><title>${stripSummary(cells)}</title>${rects}</svg>`
}

// The one-line strip for a surface without SVG: one glyph per cell (FR-UI-10).
export function stripText(cells: Verdict[]): string {
  return cells.map(cell => GLYPHS[cell]).join('')
}
