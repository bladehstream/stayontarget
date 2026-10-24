import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Allowance, DriftEvent, UiState } from '../types'

import type { ScopeList } from './charter'
import { addScopeItem, editGoal, removeScopeItem, startNewTask } from './charter'
import { clearVerdictCache } from './judge'
import { messageOf } from './model'
import { currentStatus } from './status'

// The engine's scan needs each atom in the file that reads or writes it, so the atoms are declared here. Ref and initial
// value match src/state.ts; the wiring test checks that they do for the modules it lists.
const allowancesAtom = atom({ plugin: 'stayontarget', key: 'allowances' } as const, [] as Allowance[])
const eventsAtom = atom({ plugin: 'stayontarget', key: 'events' } as const, [] as DriftEvent[])
const uiAtom = atom({ plugin: 'stayontarget', key: 'ui' } as const, { expandedEventId: null, view: 'events' } as UiState)
export const __atoms = { allowancesAtom, eventsAtom, uiAtom }

// The engine nouns the handlers use: the state (through read and update), the status line and the debug log. A pane's
// handler gets no clock, so nothing here reads the time.
export type ActionDollar = Pick<EngineInterface, 'state' | 'ui'>
// The mode handler also writes the setting (FR-UI-10); nothing else calls `config.set`.
export type ModeDollar = Pick<EngineInterface, 'config' | 'ui'>

function logFailure($: Pick<EngineInterface, 'ui'>, what: string, err: unknown): void {
  $.ui.log(`stayontarget: ${what}: ${messageOf(err)}`, { to: 'debug' })
}

// FR-UI-10: opens the event's details, or closes them when they are already open. One row is open at a time.
export async function toggleEvent($: ActionDollar, eventId: string): Promise<void> {
  try {
    await update($, uiAtom, ui => ({ ...ui, expandedEventId: ui.expandedEventId === eventId ? null : eventId }))
  } catch (err) {
    logFailure($, 'event not expanded', err)
  }
}

// FR-UI-10: the pane's view: the events, or the full charter editor. Switching closes an expanded row.
export async function setView($: ActionDollar, view: UiState['view']): Promise<void> {
  try {
    await update($, uiAtom, ui => ({ ...ui, view, expandedEventId: null }))
  } catch (err) {
    logFailure($, 'view not changed', err)
  }
}

// FR-UI-10: the person's add to a scope list. The charter's own bounds and redaction apply (src/charter.ts).
export async function addItem($: ActionDollar, list: ScopeList, text: string): Promise<void> {
  try {
    await addScopeItem($, list, text)
  } catch (err) {
    logFailure($, 'item not added', err)
  }
}

// FR-UI-10: the person's removal of the item at `index` from a scope list.
export async function removeItem($: ActionDollar, list: ScopeList, index: number): Promise<void> {
  try {
    await removeScopeItem($, list, index)
  } catch (err) {
    logFailure($, 'item not removed', err)
  }
}

// FR-UI-10: the mode picked in the pane. The setting reloads the module, which is expected. A refusal, whether the setting
// answers with one or rejects, is logged, shown as a toast, and the pane is drawn again, so its Select shows the mode in
// force rather than the pick.
export async function setMode($: ModeDollar, value: 'warn' | 'strict'): Promise<void> {
  let reason: string | null = null
  try {
    const result = await $.config.set({ key: 'stayontarget.mode', value })
    if (result.deny !== undefined) reason = result.deny
  } catch (err) {
    reason = messageOf(err)
  }
  if (reason === null) return
  $.ui.log(`stayontarget: mode not changed: ${reason}`, { to: 'debug' })
  $.ui.toast(`stayontarget: mode not changed: ${reason}`)
  $.ui.invalidate('ui.render')
}

// Pins the status line to the stored charter, events and stats (FR-RS-6). Never throws: a failed refresh is logged, and
// the line stays as it was.
export async function refreshStatus($: ActionDollar): Promise<void> {
  try {
    $.ui.status(await currentStatus($))
  } catch (err) {
    logFailure($, 'status line not refreshed', err)
  }
}

// Moves one open event to `status`. An event that is not open, or not listed, is left as it is.
async function settle($: ActionDollar, eventId: string, status: 'allowed' | 'dismissed'): Promise<void> {
  await update($, eventsAtom, events =>
    events.map(event => (event.id === eventId && event.status === 'open' ? { ...event, status } : event)),
  )
}

// FR-UI-3: an allowance for this task, for the tool and target of an out-of-scope event; the same triple is never listed
// twice. The allowance is dated by the call it came from.
export async function allowEvent($: ActionDollar, eventId: string): Promise<void> {
  try {
    const event = (await read($, eventsAtom)).find(one => one.id === eventId)
    if (event !== undefined && event.status === 'open' && event.charterId !== null) {
      const { charterId, tool, target, at } = event
      await update($, allowancesAtom, list =>
        list.some(one => one.charterId === charterId && one.tool === tool && one.target === target)
          ? list
          : [...list, { charterId, tool, target, at }],
      )
      await settle($, eventId, 'allowed')
    }
  } catch (err) {
    logFailure($, 'allowance not recorded', err)
  }
  await refreshStatus($)
}

// FR-UI-3: the event is dismissed; nothing else changes.
export async function dismissEvent($: ActionDollar, eventId: string): Promise<void> {
  try {
    await settle($, eventId, 'dismissed')
  } catch (err) {
    logFailure($, 'event not dismissed', err)
  }
  await refreshStatus($)
}

// FR-CH-8: the person's goal is edited from the pane or the command line.
export async function submitGoal($: ActionDollar, text: string): Promise<void> {
  try {
    await editGoal($, text)
  } catch (err) {
    logFailure($, 'goal not edited', err)
  }
  await refreshStatus($)
}

// FR-CH-8: the next main turn creates a new charter; the verdict cache starts again with it.
export async function newTask($: ActionDollar): Promise<void> {
  try {
    await startNewTask($)
    clearVerdictCache()
  } catch (err) {
    logFailure($, 'new task not started', err)
  }
  await refreshStatus($)
}
