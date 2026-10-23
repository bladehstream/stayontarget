import { expect, test } from 'claude-code/testing'

import { DEFAULT_CONFIG, parseConfig } from '../src/config'

test('no options gives the defaults', () => {
  expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG)
  expect(parseConfig({})).toEqual(DEFAULT_CONFIG)
  expect(parseConfig(null)).toEqual(DEFAULT_CONFIG)
})

test('the defaults are warn, haiku and no toasts', () => {
  expect(DEFAULT_CONFIG).toEqual({ mode: 'warn', model: 'haiku', toasts: false })
})

test('an invalid mode falls back to warn', () => {
  expect(parseConfig({ mode: 'loud' }).mode).toBe('warn')
  expect(parseConfig({ mode: 'STRICT' }).mode).toBe('warn')
  expect(parseConfig({ mode: 1 }).mode).toBe('warn')
})

test('a non-string or blank model falls back to haiku', () => {
  expect(parseConfig({ model: 42 }).model).toBe('haiku')
  expect(parseConfig({ model: '' }).model).toBe('haiku')
  expect(parseConfig({ model: '   ' }).model).toBe('haiku')
  expect(parseConfig({ model: true }).model).toBe('haiku')
})

test('a non-boolean toasts falls back to false', () => {
  expect(parseConfig({ toasts: 'yes' }).toasts).toBe(false)
  expect(parseConfig({ toasts: 1 }).toasts).toBe(false)
})

test('each invalid field falls back on its own', () => {
  expect(parseConfig({ mode: 'loud', model: 7, toasts: 'x' })).toEqual(DEFAULT_CONFIG)
  expect(parseConfig({ mode: 'strict', model: 7, toasts: true })).toEqual({
    mode: 'strict',
    model: 'haiku',
    toasts: true,
  })
})

test('valid values pass through', () => {
  expect(parseConfig({ mode: 'strict', model: 'sonnet', toasts: true })).toEqual({
    mode: 'strict',
    model: 'sonnet',
    toasts: true,
  })
  expect(parseConfig({ mode: 'warn', model: 'opus', toasts: false })).toEqual({
    mode: 'warn',
    model: 'opus',
    toasts: false,
  })
})
