import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Allowance, DriftEvent } from '../types'

import { editGoal, startNewTask } from './charter'
import { clearVerdictCache } from './judge'
import { messageOf } from './model'
import { currentStatus } from './status'

// The engine's scan needs each atom in the file that reads or writes it, so the atoms are declared here. Ref and initial
// value match src/state.ts; the wiring test checks that they do for the modules it lists.
const allowancesAtom = atom({ plugin: 'stayontarget', key: 'allowances' } as const, [] as Allowance[])
const eventsAtom = atom({ plugin: 'stayontarget', key: 'events' } as const, [] as DriftEvent[])
export const __atoms = { allowancesAtom, eventsAtom }

// The engine nouns the handlers use: the state (through read and update), the status line and the debug log. A pane's
// handler gets no clock, so nothing here reads the time.
export type ActionDollar = Pick<EngineInterface, 'state' | 'ui'>

function logFailure($: Pick<EngineInterface, 'ui'>, what: string, err: unknown): void {
  $.ui.log(`stayontarget: ${what}: ${messageOf(err)}`, { to: 'debug' })
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
