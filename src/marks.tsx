import { atom, read } from 'claude-code'
import type { RenderElement, RenderInputOf, RenderSurface } from 'claude-code'

import type { Charter, DriftEvent } from '../types'

import type { ActionDollar } from './actions'
import { allowEvent, dismissEvent, newTask } from './actions'
import type { Footer } from './events'
import { oneLine } from './events'
import { printable } from './text'
import { EVENTS_CAP } from './state'
import { belongsHere } from './status'

// The engine's scan needs each atom in the file that reads or writes it, so the atoms are declared here. Ref and initial
// value match src/state.ts; the wiring test checks that they do for the modules it lists.
const charterAtom = atom({ plugin: 'stayontarget', key: 'charter' } as const, null as Charter | null)
const eventsAtom = atom({ plugin: 'stayontarget', key: 'events' } as const, [] as DriftEvent[])
export const __atoms = { charterAtom, eventsAtom }

// The footers drawn this session, by their text: the rows each one prints, as built (FR-UI-8). Bounded to the last
// FOOTERS_KEPT. A footer the map does not hold, such as one from before a hot reload, draws as the engine drew it.
const FOOTERS_KEPT = 50
const footers = new Map<string, Pick<Footer, 'rows' | 'more'>>()

export function rememberFooter(text: string, footer: Pick<Footer, 'rows' | 'more'>): void {
  footers.delete(text)
  footers.set(text, footer)
  if (footers.size > FOOTERS_KEPT) {
    const [oldest] = footers.keys()
    if (oldest !== undefined) footers.delete(oldest)
  }
}

export function forgetFooters(): void {
  footers.clear()
}

type ToolUseInput = RenderInputOf<'ToolUse', RenderSurface>
type BandInput = RenderInputOf<'AbovePrompt', RenderSurface>
type MessageInput = RenderInputOf<'AssistantMessage', RenderSurface>
type Next<E> = (e: E) => Promise<RenderElement>

const DEFAULT_COLUMNS = 80
const ALLOW_LABEL = 'Allow for this task'
const DISMISS_LABEL = 'Dismiss'
const REVIEW_LABEL = 'Review'
const NEW_TASK_LABEL = 'New task'
// The room buttons take beside a line: their labels and the chrome the engine draws around them, once for the group.
const buttonRoom = (labels: string[]): number => (labels.length === 0 ? 0 : labels.reduce((n, label) => n + label.length, 0) + 8)
const DECISION_ROOM = buttonRoom([ALLOW_LABEL, DISMISS_LABEL])
const GOAL_HEAD = 40
// The separator the band draws after its goal head, and the prefix it draws before its counts.
const GOAL_SEPARATOR = ' · '
const PREFIX = 'stayontarget: '
// The band's buttons, by the step that drops them.
type BandButton = 'review' | 'new'
// The fewest cells a badge's reason keeps; below it the badge's buttons move to a line of their own.
const REASON_MIN = 20
// The separator the badge draws before its reason: " — ".
const REASON_SEPARATOR = 3

const isOutOfScope = (event: DriftEvent): boolean => event.verdict === 'adjacent' || event.verdict === 'drift'

// Cuts a line to `width` cells, ending a cut line with an ellipsis. A width under one cell is empty.
function fit(text: string, width: number): string {
  if (width < 1) return ''
  return text.length > width ? `${text.slice(0, width - 1)}…` : text
}

// FR-UI-6: the verdict of a tool call, drawn in one row beneath the engine's row. Reads only; the buttons are handlers.
export async function renderToolBadge($: ActionDollar, e: ToolUseInput, next: Next<ToolUseInput>): Promise<RenderElement> {
  const events = await read($, eventsAtom)
  const event = events.slice(-EVENTS_CAP).find(one => one.toolUseId === e.props.tool_use_id)
  if (event === undefined) return next(e)

  const row = await next(e)
  const { Box, Button, Text } = $.ui.resolve(e)
  const width = e.viewport?.columns ?? DEFAULT_COLUMNS
  const label = `stayontarget: ${event.verdict}`
  const isOpen = event.status === 'open'
  const buttons = isOpen && isOutOfScope(event) && e.surface !== 'mobile'
  const status = isOpen ? '' : event.status
  // The buttons share the line while the reason keeps REASON_MIN cells beside them; otherwise they take a line of their own.
  const beside = width - label.length - status.length - REASON_SEPARATOR - DECISION_ROOM
  const stacked = buttons && beside < REASON_MIN
  const reserved = buttons && !stacked ? DECISION_ROOM : 0
  const reason = fit(` — ${oneLine(printable(event.reason))}`, width - label.length - status.length - reserved)
  const decisions = buttons
    ? [
        <Button key={`allow-${event.id}`} label={ALLOW_LABEL} onPress={() => allowEvent($, event.id)} />,
        <Button key={`dismiss-${event.id}`} label={DISMISS_LABEL} onPress={() => dismissEvent($, event.id)} />,
      ]
    : null

  return (
    <Box flexDirection="column">
      {row}
      <Box>
        <Text
          bold={event.verdict === 'drift'}
          dimColor={event.verdict === 'in-scope' || event.verdict === 'unchecked'}
          hover={{ scope: `sot-${event.id}`, bold: true }}
        >
          {label}
        </Text>
        {reason === '' ? null : <Text>{reason}</Text>}
        {status === '' ? null : <Text dimColor>{status}</Text>}
        {stacked ? null : decisions}
      </Box>
      {stacked ? <Box>{decisions}</Box> : null}
    </Box>
  )
}

// FR-UI-7: the band above the prompt, one row: the goal's head and the counts of the charter's open out-of-scope events.
// Hidden while a survey holds the band, on an agent's transcript, and with nothing open to show.
export async function renderBand($: ActionDollar, e: BandInput, next: Next<BandInput>): Promise<RenderElement> {
  if (e.props.hasSurvey || e.props.view.agentId !== undefined) return next(e)
  const [charter, events] = await Promise.all([read($, charterAtom), read($, eventsAtom)])
  if (charter === null) return next(e)

  let drift = 0
  let adjacent = 0
  for (const event of events) {
    if (event.status !== 'open' || !belongsHere(charter, event)) continue
    if (event.verdict === 'drift') drift += 1
    if (event.verdict === 'adjacent') adjacent += 1
  }
  if (drift + adjacent === 0) return next(e)

  const { Box, Button, Text } = $.ui.resolve(e)
  const width = e.props.bodyColumns
  const isMobile = e.surface === 'mobile'
  const full = `${drift} drift · ${adjacent} adjacent`
  const short = `${drift}d · ${adjacent}a`
  // What the band gives up, in order, each step only while the row is still wider than the body (FR-UI-7): the prefix, the
  // counts' words, Review, then New task. The goal head goes first of all, shortened to nothing by what a step leaves over.
  const steps: { prefix: boolean; counts: string; buttons: BandButton[] }[] = [
    { prefix: true, counts: full, buttons: ['review', 'new'] },
    { prefix: false, counts: full, buttons: ['review', 'new'] },
    { prefix: false, counts: short, buttons: ['review', 'new'] },
    { prefix: false, counts: short, buttons: ['new'] },
    { prefix: false, counts: short, buttons: [] },
  ]
  const widthOf = (step: (typeof steps)[number]) => {
    const labels = (isMobile ? [] : step.buttons).map(button => (button === 'review' ? REVIEW_LABEL : NEW_TASK_LABEL))
    return (step.prefix ? PREFIX.length : 0) + step.counts.length + buttonRoom(labels)
  }
  const step = steps.find(one => widthOf(one) <= width) ?? steps[steps.length - 1]
  if (step === undefined) return next(e)
  const buttons = isMobile ? [] : step.buttons
  // The goal head takes what the step leaves over, at most GOAL_HEAD cells.
  const room = Math.min(GOAL_HEAD, width - widthOf(step) - GOAL_SEPARATOR.length)
  const goal = room > 0 ? `${fit(oneLine(printable(charter.goal ?? '')), room) || '(no goal)'}${GOAL_SEPARATOR}` : ''
  const line = `${step.prefix ? PREFIX : ''}${goal}${step.counts}`
  if (isMobile) return <Text>{line}</Text>

  return (
    <Box>
      <Text>{line}</Text>
      {buttons.includes('review') ? (
        <Button
          key="band-review"
          label={REVIEW_LABEL}
          onPress={async () => {
            await $.ui.open({ id: 'stayontarget', title: 'Stay on target' })
          }}
        />
      ) : null}
      {buttons.includes('new') ? <Button key="band-new" label={NEW_TASK_LABEL} onPress={() => newTask($)} /> : null}
    </Box>
  )
}

// FR-UI-8: a footer this session drew, as its head, then one row per event it prints in the footer's own order: the bullet,
// whole and wrapped, and while the event is open its Allow and Dismiss on the line under it. A closed event shows its status
// instead. The footer is looked up by its exact text; any other message, or a footer the map does not hold, is left as it is.
export async function renderFooter($: ActionDollar, e: MessageInput, next: Next<MessageInput>): Promise<RenderElement> {
  const text = e.props.text
  const footer = footers.get(text)
  if (footer === undefined) return next(e)
  const { Box, Button, Text } = $.ui.resolve(e)
  const isMobile = e.surface === 'mobile'
  const events = await read($, eventsAtom)

  // The rows are the ones the footer was built with, so each bullet sits with its own event. Nothing here is cut: a line wraps.
  const rows = footer.rows.map(({ bullet, eventId }) => {
    const event = events.find(one => one.id === eventId)
    const isOpen = event?.status === 'open'
    const buttons = isOpen && !isMobile
    return (
      <Box key={`frow-${eventId}`} flexDirection="column">
        <Text wrap="wrap">{printable(bullet)}</Text>
        {event === undefined || isOpen ? null : <Text dimColor>{event.status}</Text>}
        {buttons ? (
          <Box>
            <Button key={`fallow-${eventId}`} label={ALLOW_LABEL} onPress={() => allowEvent($, eventId)} />
            <Button key={`fdismiss-${eventId}`} label={DISMISS_LABEL} onPress={() => dismissEvent($, eventId)} />
          </Box>
        ) : null}
      </Box>
    )
  })

  return (
    <Box flexDirection="column">
      <Text wrap="wrap">{text.split('\n')[0] ?? ''}</Text>
      {rows}
      {footer.more === null ? null : <Text wrap="wrap">{footer.more}</Text>}
    </Box>
  )
}
