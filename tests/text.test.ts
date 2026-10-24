import { expect, test } from 'claude-code/testing'

import { printable } from '../src/text'

test('an escape character is drawn as \\x1b, and other controls as their hex code (FR-UI-2)', () => {
  expect(printable('a\u001b[31mb')).toBe('a\\x1b[31mb')
  expect(printable('bell\u0007')).toBe('bell\\x07')
  expect(printable('del\u007f')).toBe('del\\x7f')
  expect(printable('c1\u009b')).toBe('c1\\x9b')
  expect(printable('cr\r')).toBe('cr\\x0d')
})

test('tab and newline are kept, and printable text is unchanged (FR-UI-2)', () => {
  expect(printable('a\tb\nc')).toBe('a\tb\nc')
  expect(printable('plain text — ünïcode █')).toBe('plain text — ünïcode █')
})
