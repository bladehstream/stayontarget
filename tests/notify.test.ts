import { expect, test } from 'claude-code/testing'

import type { DriftEvent } from '../types'
import { DEFAULT_CONFIG } from '../src/config'
import { maybeToast } from '../src/notify'

// The toast's clock is the caller's: each test starts at its own time, far from the last toast of the one before it, since
// the last toast's time is kept by the module.
const BASE = 10_000_000
const ON = { ...DEFAULT_CONFIG, toasts: true }

function event(verdict: DriftEvent['verdict']): DriftEvent {
  return {
    id: 'e',
    toolUseId: 't',
    charterId: 'c',
    charterRev: 1,
    mainTurnId: null,
    agentId: null,
    tool: 'Edit',
    target: 'src/a.ts',
    verdict,
    reason: 'x',
    source: 'judge',
    action: 'note',
    status: 'open',
    at: 0,
  }
}

// A fake `$` with the one noun a toast needs: the toasts it was asked to show, in order.
function toasts() {
  const shown: string[] = []
  const $ = { ui: { toast: (text: string) => shown.push(text) } } as unknown as Parameters<typeof maybeToast>[0]
  return { $, shown }
}

test('toasts are off by default (FR-RS-7)', () => {
  const { $, shown } = toasts()

  maybeToast($, DEFAULT_CONFIG, event('drift'), BASE)

  expect(DEFAULT_CONFIG.toasts).toBe(false)
  expect(shown).toEqual([])
})

test('a drift toasts once, and a second within 30 s does not (FR-RS-7)', () => {
  const { $, shown } = toasts()

  maybeToast($, ON, event('drift'), BASE + 1_000)
  maybeToast($, ON, event('drift'), BASE + 1_000 + 29_999)

  expect(shown).toEqual(['stayontarget: drift: Edit src/a.ts'])
})

test('a drift after 30 s toasts again (FR-RS-7)', () => {
  const { $, shown } = toasts()
  const first = BASE + 2_000_000

  maybeToast($, ON, event('drift'), first)
  maybeToast($, ON, event('drift'), first + 30_000)

  expect(shown).toHaveLength(2)
})

test('a non-drift verdict never toasts (FR-RS-7)', () => {
  const { $, shown } = toasts()

  maybeToast($, ON, event('adjacent'), BASE + 3_000_000)
  maybeToast($, ON, event('in-scope'), BASE + 3_000_001)
  maybeToast($, ON, event('unchecked'), BASE + 3_000_002)

  expect(shown).toEqual([])
})
