import type { EngineInterface, Register, SessionAppendInput } from 'claude-code'

import type { DriftEvent } from '../types'

import type { Action } from '../src/action'
import { extractAction } from '../src/action'
import { newTask, refreshStatus } from '../src/actions'
import type { CharterDollar } from '../src/charter'
import { appendDelivered, onCommandSubmitted, onMainTurnStart, onSkillPrompt } from '../src/charter'
import type { Config } from '../src/config'
import { DEFAULT_CONFIG, parseConfig } from '../src/config'
import { footerFor, newEventId, recordEvent, setEventAction } from '../src/events'
import type { Decision } from '../src/judge'
import { clearVerdictCache, decide } from '../src/judge'
import { messageOf } from '../src/model'
import { maybeToast } from '../src/notify'
import { renderPane } from '../src/pane'
import { resetSessionState, restore, resumePersist, saveNow, schedulePersist, sessionEndDeadline, suspendPersist } from '../src/persist'
import { awaitVerdict, forgetVerdict, hasVerdict, startVerdict } from '../src/registry'
import { formatReport, parseCases, runEval } from '../src/evaluate'

// The verdict wait of tool.call: inside its 10 s budget with a second to spare (FR-VD-8, spike S2).
const VERDICT_WAIT_MS = 7000
// A delivered prompt is cut before it is joined: at most this many blocks, and this many characters in all.
const DELIVERY_BLOCKS = 32
const DELIVERY_CHARS = 8192
// The command's argument is read this far at most: the first word is all it uses.
const COMMAND_ARG_MAX = 64
// FR-EV-2: the labelled cases the eval runs, under the plugin's root.
const EVAL_FILE = 'evals/drift-cases.json'

type Logged = Pick<EngineInterface, 'ui'>
type Call = { toolUseId: string; action: Action; mainTurnId: string | null; agentId: string | null; at: number }
type Judging = Call & { work: Promise<Decision> }

let config: Config = DEFAULT_CONFIG
let cwd: string | null = null
let mainTurnId: string | null = null
// The calls being judged, by tool_use_id: what tool.call needs to note the verdict and wait for it. An entry goes when
// its call consumes it, or once the registry has swept its verdict.
const judging = new Map<string, Judging>()

function logFailure($: Logged, what: string, err: unknown): void {
  $.ui.log(`stayontarget: ${what}: ${messageOf(err)}`, { to: 'debug' })
}

// The text blocks of a delivered prompt, cut before they are joined so a long prompt costs no more than a short one.
function deliveredText(content: SessionAppendInput['message']['content']): string {
  const parts: string[] = []
  let size = 0
  for (const block of content.slice(0, DELIVERY_BLOCKS)) {
    const text = block.type === 'text' ? block.text : undefined
    if (typeof text !== 'string' || size >= DELIVERY_CHARS) continue
    const kept = text.slice(0, DELIVERY_CHARS - size)
    parts.push(kept)
    size += kept.length + 1
  }
  return parts.join('\n')
}

function actionOf(verdict: Decision['verdict']): DriftEvent['action'] {
  if (verdict === 'unchecked') return 'unchecked'
  if (verdict !== 'drift') return 'none'
  return config.mode === 'strict' ? 'ask' : 'note'
}

// Writes the verdict's event, shows its toast and refreshes the status line. Never throws, so the work it ends settles with
// the verdict.
async function record($: CharterDollar, call: Call, d: Decision): Promise<Decision> {
  const event: DriftEvent = {
    id: newEventId(),
    toolUseId: call.toolUseId,
    charterId: d.charterId,
    charterRev: d.charterRev,
    mainTurnId: call.mainTurnId,
    agentId: call.agentId,
    tool: call.action.tool,
    target: call.action.target,
    verdict: d.verdict,
    reason: d.reason,
    source: d.source,
    action: actionOf(d.verdict),
    status: 'open',
    at: call.at,
  }
  try {
    await recordEvent($, event)
  } catch (err) {
    logFailure($, 'event not recorded', err)
  }
  try {
    maybeToast($, config, event, await $.clock.now())
  } catch (err) {
    logFailure($, 'toast not shown', err)
  }
  await refreshStatus($)
  return d
}

// A warn-mode drift that did not reach the model: the event is shown as none, not as a note.
async function markNone($: CharterDollar, toolUseId: string): Promise<void> {
  try {
    await setEventAction($, toolUseId, 'none')
  } catch (err) {
    logFailure($, 'event not updated', err)
  }
}

// FR-EV-1, FR-EV-2: reads the labelled cases, runs them through the production judge and answers the report. A read or
// parse failure answers its reason instead.
async function evalText(
  $: Pick<EngineInterface, 'clock' | 'fs' | 'model' | 'plugin' | 'ui'>,
  cfg: Config,
  signal: AbortSignal,
): Promise<string> {
  try {
    const cases = parseCases(await $.fs.read(`${$.plugin.root}/${EVAL_FILE}`))
    return formatReport(await runEval($, cfg, cases, signal))
  } catch (err) {
    return `stayontarget eval: ${messageOf(err)}`
  }
}

function outOfScopeNote(call: Call, head: string, reason: string): string {
  return `stayontarget: this ${call.action.tool} on ${call.action.target} looks outside the current request ("${head}"): ${reason}. If it is needed, say so to the user; otherwise stop making out-of-scope changes. Disclose any out-of-scope change in your summary.`
}

export const register: Register = (on, options) => {
  config = parseConfig(options)

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    // FR-ST-4: the session's stored snapshot, if it has one, comes back before anything else is shown.
    try {
      await restore($, await $.session.id())
      await refreshStatus($)
    } catch (err) {
      logFailure($, 'snapshot not restored', err)
    }
    try {
      await $.command.register({
        name: 'stayontarget',
        description: 'Show the stayontarget pane; "new" starts a new task; "eval" runs the drift eval',
      })
    } catch (err) {
      logFailure($, 'command not registered', err)
    }
    return next(e)
  })

  // FR-UI-1: `/stayontarget` opens the pane, `/stayontarget new` starts a new task. Only the first word counts, and a long
  // argument is cut before it is read.
  on('command.run', { command: 'stayontarget' }, async ($, e, next) => {
    const word = e.args.slice(0, COMMAND_ARG_MAX).trim().toLowerCase()
    if (word === '') {
      try {
        const opened = await $.ui.open({ id: 'stayontarget', title: 'Stay on target' })
        const placed = opened.isPlaced ? '' : '; it will appear when there is room'
        return { text: `stayontarget pane opened${placed}.` }
      } catch (err) {
        logFailure($, 'pane not opened', err)
        return { text: 'stayontarget: the pane could not be opened.' }
      }
    }
    if (word === 'new') {
      await newTask($)
      return { text: 'stayontarget: the next prompt starts a new task.' }
    }
    if (word === 'eval') return { text: await evalText($, config, next.signal) }
    return { text: 'Usage: /stayontarget [new|eval]' }
  })

  on('ui.render', { component: 'Pane', requestId: 'stayontarget' }, ($, e) => renderPane($, e, config.mode))

  // FR-ST-3: every write of the plugin's own state schedules a snapshot. Declared: `'state.set': StateSetEvent` and
  // `StateWrite = StateAddress & { value, … }` with `StateAddress.plugin` (docs/api/claude-code-2.1.309.d.ts), so a matcher
  // on `plugin` sees every write, and one hook covers every call site. The write passes through unchanged. A refused write
  // schedules too: the write that refused it landed, and the save coalesces the two.
  on('state.set', { plugin: 'stayontarget' }, async ($, e, next) => {
    const r = await next(e)
    schedulePersist($)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      if (e.command !== undefined) onCommandSubmitted(await $.clock.now())
    } catch (err) {
      logFailure($, 'command mark not set', err)
    }
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    try {
      onSkillPrompt(e.text, await $.clock.now())
    } catch (err) {
      logFailure($, 'skill body not captured', err)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        mainTurnId = e.turnId
        await onMainTurnStart($, e.text, await $.clock.now())
        await refreshStatus($)
      } catch (err) {
        logFailure($, 'turn text not recorded', err)
      }
    }
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    // The row as the session stored it, after every hook beneath: a refused append stores nothing and records nothing.
    const r = await next(e)
    const message = r.deny === undefined ? r.message : undefined
    if (message !== undefined && e.door === 'delivery' && e.agentId === undefined && message.role === 'user' && message.isMeta !== true) {
      try {
        await appendDelivered($, deliveredText(message.content), await $.clock.now())
        await refreshStatus($)
      } catch (err) {
        logFailure($, 'delivered text not recorded', err)
      }
    }
    return r
  })

  on('tool.check', async ($, e, next) => {
    if (e.tool_use_id === undefined) return next(e)
    const v = await next(e)
    if (e.isReadOnly === true || v.decision === 'deny') return v

    const toolUseId = e.tool_use_id
    // The directory now, as the session reports it: a `/cd` or a worktree move changes what a path is relative to. The
    // directory the session started in is the fallback when the read fails.
    const here = await $.session.cwd().catch(err => {
      logFailure($, 'cwd not read', err)
      return cwd
    })
    const now = await $.clock.now()
    const call: Call = {
      toolUseId,
      action: extractAction(e.tool, e.input, here),
      mainTurnId,
      agentId: e.agentId ?? null,
      at: now,
    }
    const work = decide($, config, call.action, now).then(d => record($, call, d))
    startVerdict(toolUseId, work, now)
    for (const id of judging.keys()) if (!hasVerdict(id)) judging.delete(id)
    judging.set(toolUseId, { ...call, work })

    if (config.mode === 'warn') return v
    const d = await work
    if (d.verdict !== 'drift') return v
    return { decision: 'ask', reason: `stayontarget: outside the request ("${d.charterHead ?? ''}"): ${d.reason}` }
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const started = await $.clock.now()
    const r = await next(e)
    const toolUseId = e.tool_use_id
    const call = toolUseId === undefined ? undefined : judging.get(toolUseId)
    if (toolUseId === undefined || call === undefined || !hasVerdict(toolUseId)) return r
    judging.delete(toolUseId)

    const left = VERDICT_WAIT_MS - ((await $.clock.now()) - started)
    const verdict = await awaitVerdict(toolUseId, left, (ms, signal) => $.clock.sleep(ms, { signal }))
    forgetVerdict(toolUseId)
    if (verdict === 'missing') return r

    if (verdict === 'pending') {
      // The verdict settles after this result went out: its event is shown as none, since no note reached the model.
      void call.work.then(d => (config.mode === 'warn' && d.verdict === 'drift' ? markNone($, toolUseId) : undefined))
      return r
    }
    if (config.mode !== 'warn' || verdict.verdict !== 'drift') return r

    if (r.deny === undefined && r.isError !== true) {
      const note = outOfScopeNote(call, verdict.charterHead ?? '', verdict.reason)
      return { ...r, context: [...(r.context ?? []), note] }
    }
    await markNone($, toolUseId)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const r = await next(e)
    try {
      const footer = await footerFor($, e.turnId)
      if (footer !== null) return { ...r, text: footer }
    } catch (err) {
      logFailure($, 'turn footer not shown', err)
    }
    return r
  })

  // FR-ST-4: a /clear saves the session and then starts its state again; any other end saves it.
  // The save is bounded by the hook's remaining budget, less a margin for the reset: a save that outlasts it is a failure.
  // The reset runs after the save whatever the save did (saveNow never throws).
  // A /clear suspends persistence from before its save until its hook returns, so the reset's own state writes, and any timer
  // that falls due meanwhile, are not saved under the id being left (FR-ST-4). The resume is in a finally: it always runs.
  on('session.end', async ($, e, next) => {
    const clear = e.reason === 'clear'
    if (clear) suspendPersist()
    try {
      const deadline = sessionEndDeadline(next.budget?.remainingMs)
      await saveNow($, e.sessionId, deadline, next.signal)
      if (clear) {
        try {
          await resetSessionState($)
          clearVerdictCache()
          mainTurnId = null
          await refreshStatus($)
        } catch (err) {
          logFailure($, 'session not reset', err)
        }
      }
      return await next(e)
    } finally {
      if (clear) resumePersist()
    }
  })
}
