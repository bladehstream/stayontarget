import type { EngineInterface, ModelUsage } from 'claude-code'

// The engine nouns the model call uses: `$.model.complete` and the clock (for the queue wait and the elapsed time).
export type ModelDollar = Pick<EngineInterface, 'model' | 'clock'>

// Every outcome carries the tokens the call cost (NFR-3). A call that never reached the model (queue-timeout, rejected)
// costs zero; every other outcome carries the usage its reply reported, whether or not the reply had text.
export type ModelOutcome =
  | { ok: true; text: string; inputTokens: number; outputTokens: number }
  | {
      ok: false
      reason: 'queue-timeout' | 'timeout' | 'api-error' | 'empty-reply' | 'aborted' | 'rejected'
      detail: string
      inputTokens: number
      outputTokens: number
    }

const NO_TOKENS = { inputTokens: 0, outputTokens: 0 }

// Input tokens include the cached ones: the instructions block is cache-marked, so most of the input is reported as
// cache reads or writes rather than as input_tokens (NFR-3).
function tokensOf(usage: ModelUsage): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens:
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
  }
}

export type ModelRequest = { model: string; instructions: string; body: string; maxTokens: number; deadlineMs: number }

// FR-VD-6: at most this many model requests from the mod are in flight; the rest wait in arrival order.
export const CONCURRENCY = 3
// An abort is the timeout when the clock shows the budget used up, less this slack for clock granularity.
const TIMER_SLACK_MS = 5
// Bounds on parseJsonObject's work: it reads a fixed window and tries a fixed number of candidate braces.
const PARSE_WINDOW = 8000
const PARSE_CANDIDATES = 16

type Waiter = { taken: boolean; grant: () => void }

const waiters: Waiter[] = []
let inFlight = 0

export function getModelStats(): { inFlight: number; queued: number } {
  return { inFlight, queued: waiters.length }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Hands the slot straight to the oldest live waiter, or frees it. Waiters that timed out have already left the queue.
function release(): void {
  const next = waiters.shift()
  if (next === undefined) {
    inFlight -= 1
    return
  }
  next.taken = true
  next.grant()
}

// Takes a slot now, or waits for one at most `waitMs`. Resolves whether a slot was taken.
async function acquire($: ModelDollar, waitMs: number): Promise<boolean> {
  if (inFlight < CONCURRENCY) {
    inFlight += 1
    return true
  }
  if (waitMs < 1) return false

  const waiter: Waiter = { taken: false, grant: () => {} }
  const granted = new Promise<boolean>(resolve => {
    waiter.grant = () => resolve(true)
  })
  waiters.push(waiter)

  const expiry = new AbortController()
  const expired = $.clock.sleep(waitMs, { signal: expiry.signal }).then(
    () => false,
    () => false,
  )
  await Promise.race([granted, expired])
  expiry.abort()

  if (waiter.taken) return true
  const index = waiters.indexOf(waiter)
  if (index !== -1) waiters.splice(index, 1)
  return false
}

// Calls the model within `deadlineMs`, counted from the call (queue wait included). Never throws; always frees its slot.
export async function callModel($: ModelDollar, req: ModelRequest): Promise<ModelOutcome> {
  try {
    const started = await $.clock.now()
    if (!(await acquire($, req.deadlineMs))) {
      return { ok: false, reason: 'queue-timeout', detail: `no model slot within ${req.deadlineMs} ms`, ...NO_TOKENS }
    }
    try {
      const remaining = Math.floor(req.deadlineMs - ((await $.clock.now()) - started))
      if (remaining < 1) {
        return {
          ok: false,
          reason: 'queue-timeout',
          detail: `queue wait used the ${req.deadlineMs} ms budget`,
          ...NO_TOKENS,
        }
      }

      const callStarted = await $.clock.now()
      const reply = await $.model.complete({
        model: req.model,
        prompt: [{ text: req.instructions, cache: true }, { text: req.body }],
        maxTokens: req.maxTokens,
        effort: 'low',
        timeoutMs: remaining,
      })
      const callElapsed = (await $.clock.now()) - callStarted

      if (reply.isAnswered) {
        if (reply.text.trim() === '') {
          return { ok: false, reason: 'empty-reply', detail: 'reply had no text', ...tokensOf(reply.usage) }
        }
        return { ok: true, text: reply.text, ...tokensOf(reply.usage) }
      }
      if (reply.reason === 'aborted') {
        const timedOut = callElapsed >= remaining - TIMER_SLACK_MS
        return timedOut
          ? { ok: false, reason: 'timeout', detail: `no reply within ${remaining} ms`, ...tokensOf(reply.usage) }
          : { ok: false, reason: 'aborted', detail: 'model call aborted', ...tokensOf(reply.usage) }
      }
      if (reply.reason === 'api-error') {
        return {
          ok: false,
          reason: 'api-error',
          detail: `status ${reply.status ?? 'none'} ${reply.error}`,
          ...tokensOf(reply.usage),
        }
      }
      return { ok: false, reason: 'empty-reply', detail: 'reply had no text', ...tokensOf(reply.usage) }
    } finally {
      release()
    }
  } catch (err) {
    return { ok: false, reason: 'rejected', detail: messageOf(err), ...NO_TOKENS }
  }
}

// Index of the brace closing the object opened at `open`, or -1. Braces inside JSON strings do not count.
function closingBrace(text: string, open: number): number {
  let depth = 0
  let inString = false
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i += 1
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// The first `{...}` in the text that JSON.parse accepts, whatever prose or fences surround it; null when none does.
export function parseJsonObject(text: string): unknown | null {
  const window = text.slice(0, PARSE_WINDOW)
  let open = window.indexOf('{')
  for (let tried = 0; open !== -1 && tried < PARSE_CANDIDATES; tried++) {
    const close = closingBrace(window, open)
    if (close !== -1) {
      const parsed = tryParse(window.slice(open, close + 1))
      if (parsed !== undefined) return parsed
    }
    open = window.indexOf('{', open + 1)
  }
  return null
}
