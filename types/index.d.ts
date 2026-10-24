export type Verdict = 'in-scope' | 'adjacent' | 'drift' | 'unchecked'

export type Charter = {
  id: string
  rev: number
  request: string
  goal: string | null
  inScope: string[]
  outOfScope: string[]
  distilled: boolean
  editedFields: ('goal' | 'inScope' | 'outOfScope')[]
  pendingText: string[]
  createdAt: number
  // FR-CH-10: set by the `Same task` correction, consumed (removed) by the next applied update, which then takes the
  // reading as an amendment whatever the model said.
  forcedReading?: 'amendment'
}

// FR-CH-10: the reading of the last charter update, while the "Read as" line stands. View state: never in a snapshot.
export type ReadAs = {
  reading: 'new-task' | 'amendment'
  head: string
  before: Charter
  consumed: string[]
  afterId: string
  afterRev: number
  at: number
}

export type DriftEvent = {
  id: string
  toolUseId: string
  charterId: string | null
  charterRev: number
  mainTurnId: string | null
  agentId: string | null
  tool: string
  target: string
  verdict: Verdict
  reason: string
  excerpt: string
  cwd: string | null
  source: 'judge' | 'cache' | 'allowance' | 'none'
  action: 'none' | 'note' | 'ask' | 'unchecked'
  status: 'open' | 'allowed' | 'dismissed'
  at: number
}

export type Allowance = {
  charterId: string
  tool: string
  target: string
  at: number
}

export type Stats = {
  judged: number
  cacheHits: number
  allowanceHits: number
  unchecked: number
  inputTokens: number
  outputTokens: number
  charterUpdates: number
  charterFailures: number
  persistFailed: boolean
}

export type UiState = { expandedEventId: string | null; view: 'events' | 'charter' }

declare module 'claude-code' {
  interface PluginState {
    stayontarget: {
      charter: Charter | null
      events: DriftEvent[]
      allowances: Allowance[]
      stats: Stats
      ui: UiState
      readAs: ReadAs | null
    }
  }
}
