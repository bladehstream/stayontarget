import { expect, test } from 'claude-code/testing'

// The command is run through the plugin's own hooks; the engine stands beneath them: `command.register` and `ui.open` are
// answered here, as the example test does, and `ui.log` and `ui.status` are answered so the plugin's notes are dropped.
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

test('/stayontarget opens the pane (FR-UI-1)', async ($, on) => {
  const opened: unknown[] = []
  on('command.register', () => ({ value: { command: 'stayontarget' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', (_, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ command: 'stayontarget', args: '', ...RUN })

  expect(opened).toMatchObject([{ id: 'stayontarget', title: 'Stay on target' }])
  expect(result.text).toBe('stayontarget pane opened.')
})

test('the pane is named as placed later when there is no room (FR-UI-1)', async ($, on) => {
  on('command.register', () => ({ value: { command: 'stayontarget' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'narrow terminal' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const result = await $.command.run({ command: 'stayontarget', args: '', ...RUN })

  expect(result.text).toBe('stayontarget pane opened; it will appear when there is room.')
})

test('a pane the engine refuses says so (FR-UI-1, fail-open)', async ($, on) => {
  on('command.register', () => ({ value: { command: 'stayontarget' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ deny: 'no room' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ command: 'stayontarget', args: '', ...RUN })

  expect(result.text).toBe('stayontarget: the pane could not be opened.')
})

test('/stayontarget new starts a new task (FR-UI-1, FR-CH-8)', async ($, on) => {
  on('command.register', () => ({ value: { command: 'stayontarget' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ command: 'stayontarget', args: ' New ', ...RUN })

  expect(result.text).toBe('stayontarget: the next prompt starts a new task.')
})

test('any other argument gets the usage line (FR-UI-1)', async ($, on) => {
  on('command.register', () => ({ value: { command: 'stayontarget' } }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ command: 'stayontarget', args: 'bogus', ...RUN })

  expect(result.text).toBe('Usage: /stayontarget [new|eval]')
})
