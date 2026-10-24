import { atom, read } from 'claude-code'
import type { Elements, RenderElement, RenderInputOf, RenderSurface } from 'claude-code'

import type { Charter, DriftEvent, ReadAs, UiState } from '../types'

import type { ActionDollar, ModeDollar } from './actions'
import { addItem, allowEvent, dismissEvent, newTask, removeItem, setMode, setView, submitGoal, toggleEvent } from './actions'
import type { ScopeList } from './charter'
import type { Config } from './config'
import { cwdOf, excerptOf, oneLine } from './events'
import { READ_AS_LABELS, readAsCorrection, readAsLine } from './marks'
import { EMPTY_STATS, EMPTY_UI } from './state'
import { belongsHere } from './status'
import { stripCells, stripSummary, stripSvg, stripText } from './strip'
import { printable } from './text'

// The engine's scan needs each atom in the file that reads or writes it, so the atoms are declared here. Ref and initial
// value match src/state.ts; the wiring test checks that they do for the modules it lists.
const charterAtom = atom({ plugin: 'stayontarget', key: 'charter' } as const, null as Charter | null)
const eventsAtom = atom({ plugin: 'stayontarget', key: 'events' } as const, [] as DriftEvent[])
const statsAtom = atom({ plugin: 'stayontarget', key: 'stats' } as const, EMPTY_STATS)
const uiAtom = atom({ plugin: 'stayontarget', key: 'ui' } as const, EMPTY_UI as UiState)
const readAsAtom = atom({ plugin: 'stayontarget', key: 'readAs' } as const, null as ReadAs | null)
export const __atoms = { charterAtom, eventsAtom, statsAtom, uiAtom, readAsAtom }

export type PaneInput = RenderInputOf<'Pane', RenderSurface>
// The pane writes the mode through the handler and the view through its own handler (FR-UI-10).
type PaneDollar = ActionDollar & ModeDollar

const DEFAULT_ROWS = 24
// The expanded event's excerpt draws at most this many rows (FR-UI-10).
const CODE_ROWS = 8
// The longest link the pane draws: the engine refuses a link longer than this (FR-UI-10).
const LINK_MAX = 2048
// The fewest rows an event takes: its text and its buttons or status (FR-UI-2).
const EVENT_ROWS = 2
const MODES = [
  { value: 'warn', label: 'warn' },
  { value: 'strict', label: 'strict' },
]
const FILE_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

const isOutOfScope = (event: DriftEvent): boolean => event.verdict === 'adjacent' || event.verdict === 'drift'

// Cuts a line to the pane's width, ending a cut line with an ellipsis (FR-UI-2).
function fit(text: string, width: number): string {
  if (width < 1) return ''
  return text.length > width ? `${text.slice(0, width - 1)}…` : text
}

// The counts of the current charter, as the status line counts them (FR-UI-2).
function countsOf(charter: Charter | null, events: DriftEvent[]): { drift: number; adjacent: number; unchecked: number } {
  const counts = { drift: 0, adjacent: 0, unchecked: 0 }
  if (charter === null) return counts
  for (const event of events) {
    if (event.verdict === 'unchecked') {
      if (belongsHere(charter, event)) counts.unchecked += 1
    } else if (event.charterId === charter.id && event.status === 'open') {
      if (event.verdict === 'drift') counts.drift += 1
      if (event.verdict === 'adjacent') counts.adjacent += 1
    }
  }
  return counts
}

// FR-UI-10: the file a row's target names, when the tool edits a file, whatever its verdict. A NotebookEdit target is
// `file#cell`: the part before the last `#` is the path only when it ends in `.ipynb`, so a `#` in the file name stays; any
// other target is used whole.
function fileOf(event: DriftEvent): string | null {
  if (!FILE_TOOLS.includes(event.tool) || event.target === event.tool) return null
  if (event.tool === 'NotebookEdit') {
    const cut = event.target.lastIndexOf('#')
    if (cut > 0 && /\.ipynb$/i.test(event.target.slice(0, cut))) return event.target.slice(0, cut)
  }
  return event.target || null
}

// FR-UI-10: a `file:` URL for a path. A relative path is taken from the directory its call ran in (`cwd`), and is not linked
// when that is unknown; an absolute path is linked as it is. A Windows drive path is `file:///C:/…`; each segment is
// percent-encoded, and the drive letter is left as it is.
export function fileUrl(cwd: string | null, target: string): string | null {
  const path = target.replace(/\\/g, '/')
  const absolute = /^([A-Za-z]:)?\//.test(path)
  if (!absolute && cwd === null) return null
  const base = (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const joined = absolute ? path : `${base}/${path}`
  const rooted = /^[A-Za-z]:/.test(joined) ? `/${joined}` : joined
  const encoded = rooted.split('/').map(segment => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
  return `file://${encoded.join('/')}`
}

// FR-UI-10: the details of an expanded row, within `budget` rows: the excerpt as Code, one row per line, and for a file a
// link. The excerpt keeps at least one row, so an expanded row is never drawn without its excerpt.
function detailsOf(
  event: DriftEvent,
  budget: number,
  width: number,
  elements: Pick<Elements['desktop'], 'Box' | 'Code' | 'Link' | 'Text'>,
): { rows: number; node: RenderElement } {
  const { Box, Code, Link, Text } = elements
  const file = fileOf(event)
  // A link over LINK_MAX characters is left out, not cut: a cut address is a wrong one (FR-UI-10).
  const built = file === null ? null : fileUrl(cwdOf(event), file)
  const href = built === null || built.length > LINK_MAX ? null : built
  const linkRows = href === null ? 0 : 1
  const excerpt = excerptOf(event)
  const lines = excerpt === '' ? [] : excerpt.split('\n')
  const excerptRows = Math.max(1, Math.min(CODE_ROWS, lines.length, budget - linkRows))
  return {
    rows: excerptRows + linkRows,
    node: (
      <Box flexDirection="column">
        {lines.length === 0 ? (
          <Text dimColor>(no excerpt)</Text>
        ) : (
          <Code
            source={printable(lines.slice(0, excerptRows).join('\n'))}
            path={file === null || printable(file) !== file ? undefined : file}
            format="source"
            wrap="truncate-end"
          />
        )}
        {href === null ? null : <Link href={href} label={fit(oneLine(printable(file ?? '')), width)} />}
      </Box>
    ),
  }
}

// FR-UI-10: the charter as Markdown, in full: the goal, then the two scope lists, one item per bullet, each whole and on one
// line of text (the view scrolls, so nothing is cut here); a list with no items is "(none)" on its heading.
function charterText(charter: Charter): string {
  const section = (title: string, items: string[]): string[] => {
    if (items.length === 0) return [`**${title}** (none)`]
    return [`**${title}**`, ...items.map(item => `- ${oneLine(printable(item))}`)]
  }
  const goal = charter.goal === null ? '(no goal yet)' : oneLine(printable(charter.goal))
  return [goal, ...section('In scope', charter.inScope), ...section('Out of scope', charter.outOfScope)].join('\n')
}

// Renders the pane (FR-UI-1..4, FR-UI-10). Reads only; every write is a handler the buttons, the inputs and the select raise.
export async function renderPane($: PaneDollar, e: PaneInput, mode: Config['mode']): Promise<RenderElement> {
  const width = e.props.bodyColumns
  // The pane's own height is its body rows; the surface's height is only the fallback when the pane names none.
  const base: number = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? DEFAULT_ROWS
  const [charter, events, stats, ui, readAs] = await Promise.all([
    read($, charterAtom),
    read($, eventsAtom),
    read($, statsAtom),
    read($, uiAtom),
    read($, readAsAtom),
  ])
  // Each of these is drawn only on the surfaces whose table names it: Input and Select are not on mobile, Svg not on terminal.
  const elements = $.ui.resolve(e)
  const { Box, Button, Code, Input, Link, Markdown, Select, Svg, Text } = elements as Elements['desktop']

  const counts = countsOf(charter, events)
  // On mobile nothing writes: an open out-of-scope row shows its status as text, with no buttons, there is no New task, and
  // the pane has only its events view.
  const isMobile = e.surface === 'mobile'
  const writable = !isMobile
  const charterView = writable && ui.view === 'charter'
  const cells = stripCells(events, charter)
  // The verdict strip: an SVG where the surface has one, else a line of glyphs.
  const stripNode =
    cells.length === 0 ? null : e.surface === 'terminal' ? (
      <Text>{fit(stripText(cells), width)}</Text>
    ) : (
      <Svg alt={stripSummary(cells)} source={stripSvg(cells)} />
    )

  // The events view keeps the goal, the charter line, the mode and New task, and gives the events the rest. Under that, it
  // drops the strip, then the counts, then the charter summary, until an event fits; if none fits, it draws the newest
  // out-of-scope event alone (FR-UI-2).
  // FR-CH-10: the "Read as" line stands under the goal in this view. It is the last part dropped, after the summary, and never
  // takes a row an event needs.
  // The clock is read only while a reading stands: a pane with none draws without it.
  const readLine = charterView || !readAs ? null : readAsLine(readAs, await $.clock.now(), width, !writable)
  const fixed = 2 + (writable ? 2 : 0)
  const keep = { strip: cells.length > 0, counts: true, summary: charter !== null, readAs: readLine !== null }
  const rowsUsed = () =>
    fixed + (keep.strip ? 1 : 0) + (keep.counts ? 1 : 0) + (keep.summary ? 1 : 0) + (keep.readAs ? 1 : 0)
  for (const part of ['strip', 'counts', 'summary', 'readAs'] as const) {
    if (base - rowsUsed() >= EVENT_ROWS) break
    keep[part] = false
  }
  const room = base - rowsUsed()
  const belonging = charter === null ? [] : events.filter(event => belongsHere(charter, event))
  const forced = belonging.findLast(isOutOfScope) ?? belonging.at(-1)

  const eventRow = (event: DriftEvent, details: { node: RenderElement } | null): RenderElement => {
    const isOpenOutOfScope = event.status === 'open' && isOutOfScope(event)
    const text = fit(oneLine(printable(`${event.verdict} ${event.tool} ${event.target} — ${event.reason}`)), width)
    const drift = event.verdict === 'drift'
    return (
      <Box flexDirection="column">
        {writable ? (
          <Button key={`ev-${event.id}`} plain onPress={() => toggleEvent($, event.id)}>
            <Text bold={drift} hover={{ scope: `sot-${event.id}`, bold: true }}>
              {text}
            </Text>
          </Button>
        ) : (
          <Text bold={drift} hover={{ scope: `sot-${event.id}`, bold: true }}>
            {text}
          </Text>
        )}
        {event.status !== 'open' || (isMobile && isOpenOutOfScope) ? <Text dimColor>{event.status}</Text> : null}
        {isOpenOutOfScope && !isMobile ? (
          <Box>
            <Button key={`allow-${event.id}`} label="Allow for this task" onPress={() => allowEvent($, event.id)} />
            <Button key={`dismiss-${event.id}`} label="Dismiss" onPress={() => dismissEvent($, event.id)} />
          </Box>
        ) : null}
        {details === null ? null : details.node}
      </Box>
    )
  }

  // The expanded event is reserved first, with its details, so the rows it needs are not taken by the others. The rest fill
  // the room newest first, each one that fits; an event that does not fit is skipped (FR-UI-2, FR-UI-10).
  const newestFirst = charterView ? [] : [...belonging].reverse()
  const cost = (event: DriftEvent): number => (event.status !== 'open' || isOutOfScope(event) ? 2 : 1)
  const expandedEvent = writable ? newestFirst.find(event => ui.expandedEventId === event.id) : undefined
  const rows = new Map<string, RenderElement>()
  let used = 0
  if (expandedEvent !== undefined) {
    const details = detailsOf(expandedEvent, room - cost(expandedEvent), width, { Box, Code, Link, Text })
    used += cost(expandedEvent) + details.rows
    rows.set(expandedEvent.id, eventRow(expandedEvent, details))
  }
  for (const event of newestFirst) {
    if (rows.has(event.id) || used + cost(event) > room) continue
    used += cost(event)
    rows.set(event.id, eventRow(event, null))
  }
  const shown: RenderElement[] = newestFirst.flatMap(event => {
    const row = rows.get(event.id)
    return row === undefined ? [] : [row]
  })
  // An event always draws, though the room is too small for it: the newest out-of-scope one, alone, when nothing else fits.
  const tooSmall = room < EVENT_ROWS && forced !== undefined
  // An expanded event is always drawn, so the alone layout shows it rather than the forced one.
  const eventsOut: RenderElement[] = tooSmall && expandedEvent === undefined
    ? [eventRow(forced, null)]
    : shown.length === 0 && forced !== undefined
      ? [eventRow(forced, null)]
      : shown.length === 0
        ? [<Text dimColor>No changes judged yet.</Text>]
        : shown

  // The goal: an Input where the surface has one, else text (mobile).
  const goal = oneLine(printable(charter?.goal ?? ''))
  const goalRow =
    e.surface === 'mobile' ? (
      <Text>{fit(`Goal: ${charter === null ? '(no charter yet)' : goal}`, width)}</Text>
    ) : (
      <Box>
        <Text>Goal: </Text>
        <Input
          key="goal"
          value={goal}
          placeholder="What should the agent be doing?"
          onSubmit={value => submitGoal($, value)}
        />
      </Box>
    )

  const charterLine =
    charter === null
      ? 'charter none'
      : `charter ${charter.id.slice(0, 8)}·r${charter.rev} · ${charter.distilled ? 'distilled' : 'not distilled'}`
  // Where the surface has a Select, the mode is that Select; elsewhere it is text.
  const modeText = e.surface === 'mobile' ? ` · mode ${mode}` : ''
  const tokens = `tokens ${stats.inputTokens}/${stats.outputTokens}`
  const countLine = `${counts.drift} drift · ${counts.adjacent} adjacent · ${counts.unchecked} unchecked · ${stats.judged} judged · ${stats.cacheHits} cached`
  const modeRow = writable ? (
    <Select
      key="mode"
      label="mode "
      options={MODES}
      value={mode}
      onSelect={value => {
        if (value === 'warn' || value === 'strict') void setMode($, value)
      }}
    />
  ) : null
  const newTaskButton = <Button key="new-task" label="New task" onPress={() => newTask($)} />

  // The charter summary of the events view: its counts of scope, and the way to the charter editor.
  const summary =
    charter === null ? null : (
      <Box>
        <Text>{fit(`In scope: ${charter.inScope.length} · Out of scope: ${charter.outOfScope.length}`, width)}</Text>
        {writable ? <Button key="view-charter" label="Edit charter" onPress={() => setView($, 'charter')} /> : null}
      </Box>
    )

  if (charterView) {
    // The charter editor: the whole charter, its remove Buttons and add Inputs, and Back. No event list.
    const editing = charter !== null
    return (
      <Box flexDirection="column">
        {goalRow}
        <Text dimColor>{fit(`${charterLine} · ${tokens}`, width)}</Text>
        <Markdown key="charter" text={charter === null ? '(no charter yet)' : charterText(charter)} />
        {charter !== null && charter.inScope.length > 0 ? (
          <Box>
            {charter.inScope.map((_, i) => (
              <Button key={`rm-in-${i}`} label={`remove ${i + 1}`} onPress={() => removeItem($, 'inScope', i)} />
            ))}
          </Box>
        ) : null}
        {charter !== null && charter.outOfScope.length > 0 ? (
          <Box>
            {charter.outOfScope.map((_, i) => (
              <Button key={`rm-out-${i}`} label={`remove ${i + 1}`} onPress={() => removeItem($, 'outOfScope', i)} />
            ))}
          </Box>
        ) : null}
        {editing ? <Input key="add-in" label="Add in scope" placeholder="An item in scope" onSubmit={value => addItem($, 'inScope', value)} /> : null}
        {editing ? <Input key="add-out" label="Add out of scope" placeholder="An item out of scope" onSubmit={value => addItem($, 'outOfScope', value)} /> : null}
        {modeRow}
        <Text>{fit(countLine, width)}</Text>
        {stripNode}
        <Box>
          <Button key="view-events" label="Back" onPress={() => setView($, 'events')} />
          {newTaskButton}
        </Box>
      </Box>
    )
  }

  // The forced layout is the event alone: nothing else fits beside it.
  if (tooSmall) {
    return <Box flexDirection="column">{eventsOut}</Box>
  }

  const readRow =
    keep.readAs && readLine !== null ? (
      <Box>
        <Text>{readLine.text}</Text>
        {readLine.buttons.map(button => (
          <Button key={`pane-${button}`} label={READ_AS_LABELS[button]} onPress={() => readAsCorrection($, button)} />
        ))}
      </Box>
    ) : null

  return (
    <Box flexDirection="column">
      {goalRow}
      {readRow}
      <Text dimColor>{fit(`${charterLine}${modeText} · ${tokens}`, width)}</Text>
      {keep.summary ? summary : null}
      {modeRow}
      {keep.counts ? <Text>{fit(countLine, width)}</Text> : null}
      {keep.strip ? stripNode : null}
      {writable ? <Box>{newTaskButton}</Box> : null}
      {eventsOut}
    </Box>
  )
}
