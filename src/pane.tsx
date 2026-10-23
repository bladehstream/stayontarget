import { atom, read } from 'claude-code'
import type { Elements, RenderElement, RenderInputOf, RenderSurface } from 'claude-code'

import type { Charter, DriftEvent } from '../types'

import type { ActionDollar } from './actions'
import { allowEvent, dismissEvent, newTask, submitGoal } from './actions'
import type { Config } from './config'
import { EMPTY_STATS } from './state'
import { belongsHere } from './status'

// The engine's scan needs each atom in the file that reads or writes it, so the atoms are declared here. Ref and initial
// value match src/state.ts; the wiring test checks that they do for the modules it lists.
const charterAtom = atom({ plugin: 'stayontarget', key: 'charter' } as const, null as Charter | null)
const eventsAtom = atom({ plugin: 'stayontarget', key: 'events' } as const, [] as DriftEvent[])
const statsAtom = atom({ plugin: 'stayontarget', key: 'stats' } as const, EMPTY_STATS)
export const __atoms = { charterAtom, eventsAtom, statsAtom }

export type PaneInput = RenderInputOf<'Pane', RenderSurface>

// The lines above the event list: the goal, the charter line, the counts and New task.
const HEAD_ROWS = 4
const DEFAULT_ROWS = 24

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

// Renders the pane (FR-UI-1..4). Reads only; every write is a handler the buttons and the goal field raise.
export async function renderPane($: ActionDollar, e: PaneInput, mode: Config['mode']): Promise<RenderElement> {
  const width = e.props.bodyColumns
  // The pane's own height is its body rows; the surface's height is only the fallback when the pane names none.
  const bodyRows: number | undefined = e.props.scroll?.bodyRows
  const [charter, events, stats] = await Promise.all([read($, charterAtom), read($, eventsAtom), read($, statsAtom)])
  const elements = $.ui.resolve(e)
  const { Box, Button, Text } = elements

  const counts = countsOf(charter, events)
  // On mobile nothing writes: an open out-of-scope row shows its status as text, with no buttons, and there is no New task.
  const isMobile = e.surface === 'mobile'
  const room = Math.max(1, (bodyRows ?? e.viewport?.rows ?? DEFAULT_ROWS) - (isMobile ? HEAD_ROWS - 1 : HEAD_ROWS))
  const shown: RenderElement[] = []
  let used = 0
  let hasCurrent = false
  // Newest first, and cut at the room the pane leaves: the list is bounded by the events cap, not by its length.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event === undefined || charter === null || !belongsHere(charter, event)) continue
    hasCurrent = true
    // An out-of-scope row takes a second line for its status or its two buttons.
    const cost = event.status !== 'open' || isOutOfScope(event) ? 2 : 1
    if (used + cost > room) continue
    used += cost
    const isOpenOutOfScope = event.status === 'open' && isOutOfScope(event)
    shown.push(
      <Box flexDirection="column">
        <Text bold={event.verdict === 'drift'}>{fit(`${event.verdict} ${event.tool} ${event.target} — ${event.reason}`, width)}</Text>
        {event.status !== 'open' || (isMobile && isOpenOutOfScope) ? <Text dimColor>{event.status}</Text> : null}
        {isOpenOutOfScope && !isMobile ? (
          <Box>
            <Button key={`allow-${event.id}`} label="Allow for this task" onPress={() => allowEvent($, event.id)} />
            <Button key={`dismiss-${event.id}`} label="Dismiss" onPress={() => dismissEvent($, event.id)} />
          </Box>
        ) : null}
      </Box>,
    )
  }

  // The mobile table has no Input, and a resolved table completes the names it lacks: the surface decides, not the table.
  const { Input } = elements as Elements['desktop']
  const goal = charter?.goal ?? ''
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
  const tokens = `tokens ${stats.inputTokens}/${stats.outputTokens}`
  const countLine = `${counts.drift} drift · ${counts.adjacent} adjacent · ${counts.unchecked} unchecked · ${stats.judged} judged · ${stats.cacheHits} cached`

  return (
    <Box flexDirection="column">
      {goalRow}
      <Text dimColor>{fit(`${charterLine} · mode ${mode} · ${tokens}`, width)}</Text>
      <Text>{fit(countLine, width)}</Text>
      {isMobile ? null : <Button key="new-task" label="New task" onPress={() => newTask($)} />}
      {hasCurrent ? shown : <Text dimColor>No changes judged yet.</Text>}
    </Box>
  )
}
