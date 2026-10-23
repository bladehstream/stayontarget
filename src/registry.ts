import type { Decision } from './judge'

// Verdict entries keyed by tool_use_id (FR-VD-7). An entry is forgotten when its call consumes it, or by sweep once it is
// older than MAX_AGE_MS. No `$` here: the entries are plain module state, shared by the hooks of one session.
const MAX_AGE_MS = 60 * 1000

// The wait takes its timer from the caller. The environment declares no timer: the engine's declarations list the web APIs
// without one, and tsconfig's lib (es2023) has none, so the caller's clock sleep stands in. The signal ends the wait early,
// as `acquire` in model.ts does, so a settled verdict does not leave its timer running.
export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>

type Entry = { settled: Decision | undefined; startedAt: number; work: Promise<Decision> }

const entries = new Map<string, Entry>()

const INTERNAL: Decision = { verdict: 'unchecked', reason: 'internal error', source: 'none', charterId: null, charterRev: 0, charterHead: null }

// Registers the verdict of a tool call. `work` is attached once here, so its rejection settles the entry as unchecked
// rather than escaping to whoever waits on it.
export function startVerdict(toolUseId: string, work: Promise<Decision>, now: number): void {
  sweep(now)
  const settle = (decision: Decision): Decision => {
    entry.settled = decision
    return decision
  }
  const entry: Entry = { settled: undefined, startedAt: now, work: work.then(settle, () => settle(INTERNAL)) }
  entries.set(toolUseId, entry)
}

export function hasVerdict(toolUseId: string): boolean {
  return entries.has(toolUseId)
}

// Returns at once when there is no entry (FR-VD-7: never wait on an orphan) or when the verdict has already settled. Else
// waits at most `maxWaitMs` for it; 'pending' when it has not settled by then.
export async function awaitVerdict(
  toolUseId: string,
  maxWaitMs: number,
  sleep: Sleep,
): Promise<Decision | 'pending' | 'missing'> {
  const entry = entries.get(toolUseId)
  if (entry === undefined) return 'missing'
  if (entry.settled !== undefined) return entry.settled
  if (maxWaitMs < 1) return 'pending'

  const expiry = new AbortController()
  try {
    const timer = Promise.resolve()
      .then(() => sleep(maxWaitMs, expiry.signal))
      .then(
        () => 'pending' as const,
        () => 'pending' as const,
      )
    return await Promise.race([entry.work, timer])
  } finally {
    expiry.abort()
  }
}

export function peekSettled(toolUseId: string): Decision | undefined {
  return entries.get(toolUseId)?.settled
}

export function forgetVerdict(toolUseId: string): void {
  entries.delete(toolUseId)
}

// Removes the entries older than MAX_AGE_MS, settled or not, and returns how many it removed.
export function sweep(now: number): number {
  let removed = 0
  for (const [toolUseId, entry] of entries) {
    if (now - entry.startedAt > MAX_AGE_MS) {
      entries.delete(toolUseId)
      removed += 1
    }
  }
  return removed
}
