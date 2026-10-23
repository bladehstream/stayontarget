export type Verdict = 'in-scope' | 'adjacent' | 'drift' | 'unchecked'

export type Charter = {
  id: string
  rev: number
  request: string
  goal: string | null
  inScope: string[]
  outOfScope: string[]
  distilled: boolean
  editedFields: ('goal')[]
  pendingText: string[]
  createdAt: number
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

declare module 'claude-code' {
  interface PluginState {
    stayontarget: {
      charter: Charter | null
      events: DriftEvent[]
      allowances: Allowance[]
      stats: Stats
    }
  }
}
