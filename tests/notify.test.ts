import { expect, test } from 'claude-code/testing'

import type { DriftEvent } from '../types'
import { DEFAULT_CONFIG } from '../src/config'
import { maybeNotify, maybeToast } from '../src/notify'

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
    excerpt: '',
    cwd: null,
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

// The notification's clock is the caller's too: each test starts 100 million ms after the one before, so the last send of
// one test is never within a minute of the next test's first.
const NOTIFY_ON = { ...DEFAULT_CONFIG, notify: true }
const sendOk = async () => ({ isSent: true, channel: 'terminal_bell' })

// A fake `$` with the nouns a notification needs: the sends it was asked for and the debug log. `answer` settles each send.
function notifications(answer: () => Promise<unknown>) {
  const sent: { text: string; title?: string }[] = []
  const logs: string[] = []
  const $ = {
    ui: {
      notify: (text: string, options?: { title?: string }) => {
        sent.push({ text, title: options?.title })
        return answer()
      },
      log: (text: string) => {
        logs.push(text)
      },
    },
  } as unknown as Parameters<typeof maybeNotify>[0]
  return { $, sent, logs }
}

test('notifications are off by default (FR-UI-9)', async () => {
  const { $, sent } = notifications(sendOk)

  await maybeNotify($, DEFAULT_CONFIG, event('drift'), 100_000_000)

  expect(DEFAULT_CONFIG.notify).toBe(false)
  expect(sent).toEqual([])
})

test('only a drift notifies (FR-UI-9)', async () => {
  const { $, sent } = notifications(sendOk)
  const base = 200_000_000

  await maybeNotify($, NOTIFY_ON, event('adjacent'), base)
  await maybeNotify($, NOTIFY_ON, event('in-scope'), base + 1)
  await maybeNotify($, NOTIFY_ON, event('unchecked'), base + 2)

  expect(sent).toEqual([])
})

test('a drift notifies with its tool, target and reason, under the drift title (FR-UI-9)', async () => {
  const { $, sent } = notifications(sendOk)

  await maybeNotify($, NOTIFY_ON, event('drift'), 300_000_000)

  expect(sent).toEqual([{ text: 'Edit src/a.ts: x', title: 'stayontarget: drift' }])
})

test('one notification per minute, and a second within 60 s does not (FR-UI-9)', async () => {
  const { $, sent } = notifications(sendOk)
  const first = 400_000_000

  await maybeNotify($, NOTIFY_ON, event('drift'), first)
  await maybeNotify($, NOTIFY_ON, event('drift'), first + 59_999)
  expect(sent).toHaveLength(1)

  await maybeNotify($, NOTIFY_ON, event('drift'), first + 60_000)
  expect(sent).toHaveLength(2)
})

test('a send the terminal did not take is logged and not retried, and does not throw (FR-UI-9)', async () => {
  const { $, sent, logs } = notifications(async () => ({ isSent: false, reason: 'disabled' }))

  await maybeNotify($, NOTIFY_ON, event('drift'), 500_000_000)
  await maybeNotify($, NOTIFY_ON, event('drift'), 500_000_001)

  expect(sent).toHaveLength(1)
  expect(logs).toEqual(['stayontarget: notification not sent: disabled'])
})

test('a rejected send is logged and does not throw (FR-UI-9)', async () => {
  const { $, logs } = notifications(() => Promise.reject(new Error('no bus')))

  await maybeNotify($, NOTIFY_ON, event('drift'), 600_000_000)

  expect(logs).toHaveLength(1)
  expect(logs[0]).toContain('no bus')
})
