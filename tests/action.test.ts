import { expect, test } from 'claude-code/testing'

import { REDACT_WINDOW_MARGIN, bound, extractAction, fingerprint, normalizePath } from '../src/action'

const HEX_64 = /^[0-9a-f]{64}$/

test('a Windows path inside cwd is relative, in any case', () => {
  expect(normalizePath('C:\\Proj\\src\\a.ts', 'c:/proj')).toBe('src/a.ts')
  expect(normalizePath('c:\\PROJ\\x.ts', 'C:\\proj')).toBe('x.ts')
  expect(normalizePath('C:/Proj/src/a.ts', 'C:/Proj/')).toBe('src/a.ts')
})

test('a Windows path outside cwd is absolute with a lower-case drive', () => {
  expect(normalizePath('D:/other/x.ts', 'C:/proj')).toBe('d:/other/x.ts')
})

test('a POSIX path inside cwd is relative, with duplicate slashes collapsed', () => {
  expect(normalizePath('/home/u/proj//src/a.ts', '/home/u/proj/')).toBe('src/a.ts')
  expect(normalizePath('/home/u/proj/./a.ts', '/home/u/proj')).toBe('a.ts')
})

test('Windows spellings that differ only in case normalise to the same path', () => {
  expect(normalizePath('C:/Proj/Src/A.ts', 'c:/proj')).toBe('src/a.ts')
  expect(normalizePath('c:/proj/src/a.ts', 'c:/proj')).toBe('src/a.ts')
  expect(normalizePath('D:/Other/File.ts', 'C:/proj')).toBe('d:/other/file.ts')
  expect(normalizePath('Src/A.ts', 'c:/proj')).toBe('src/a.ts')
})

test('Windows spellings that differ only in case give equal targets, judge text and fingerprints', async () => {
  const first = extractAction('Edit', { file_path: 'C:/Proj/Src/A.ts', old_string: 'a', new_string: 'b' }, 'c:/proj')
  const second = extractAction('Edit', { file_path: 'c:/proj/src/a.ts', old_string: 'a', new_string: 'b' }, 'c:/proj')

  expect(first.kind === 'ok' && second.kind === 'ok').toBe(true)
  if (first.kind !== 'ok' || second.kind !== 'ok') return
  expect(first.target).toBe(second.target)
  expect(first.judgeText).toBe(second.judgeText)
  expect(await fingerprint('charter', 1, first.tool, first.judgeText)).toBe(
    await fingerprint('charter', 1, second.tool, second.judgeText),
  )
})

test('POSIX paths that differ only in case stay different', () => {
  expect(normalizePath('/home/u/proj/Src/A.ts', '/home/u/proj')).toBe('Src/A.ts')
  expect(normalizePath('/home/u/proj/src/a.ts', '/home/u/proj')).toBe('src/a.ts')
  expect(normalizePath('/home/u/Proj/a.ts', null)).not.toBe(normalizePath('/home/u/proj/a.ts', null))
})

test('an escaped quote in a credential inside a Write does not leak the rest of the value', () => {
  const action = extractAction('Write', { file_path: 'a.json', content: '{"password":"first\\"SECOND_HALF"}' }, null)

  expect(action.kind === 'ok' && action.judgeText.includes('SECOND_HALF')).toBe(false)
})

test('a Write of a long repeated value is judged in bounded time', () => {
  const started = Date.now()
  const action = extractAction('Write', { file_path: 'a', content: 'x='.repeat(200000) }, null)
  const elapsed = Date.now() - started

  expect(action.kind).toBe('ok')
  expect(elapsed < 200).toBe(true)
})

test('a long MCP argument value is judged in bounded time', () => {
  const started = Date.now()
  const action = extractAction('mcp__x__y', { data: 'x='.repeat(200000) }, null)
  const elapsed = Date.now() - started

  expect(action.kind).toBe('ok')
  expect(elapsed < 200).toBe(true)
})

test('a Write excerpt keeps its head and marks the length of the whole content', () => {
  const action = extractAction('Write', { file_path: 'a.md', content: 'a'.repeat(5000) }, null)

  expect(action.kind === 'ok' && action.judgeText.endsWith('a'.repeat(1000) + '…[+4000 chars]')).toBe(true)
})

test('the redaction window margin is 512 characters', () => {
  expect(REDACT_WINDOW_MARGIN).toBe(512)
})

test('dot segments are resolved before the cwd containment check', () => {
  expect(normalizePath('C:/proj/src/../a.ts', 'C:/proj')).toBe('a.ts')
  expect(normalizePath('C:/proj/a.ts', 'C:/proj')).toBe('a.ts')
  expect(normalizePath('C:/proj/../outside/a.ts', 'C:/proj')).toBe('c:/outside/a.ts')
  expect(normalizePath('/home/u/proj/src/../a.ts', '/home/u/proj')).toBe('a.ts')
  expect(normalizePath('/home/u/proj/../outside/a.ts', '/home/u/proj')).toBe('/home/u/outside/a.ts')
  expect(normalizePath('/../../etc/hosts', null)).toBe('/etc/hosts')
})

test('a 5,000,000-character Write is judged in bounded time', () => {
  const started = Date.now()
  const action = extractAction('Write', { file_path: 'a', content: 'x'.repeat(5000000) }, null)
  const elapsed = Date.now() - started

  expect(action.kind).toBe('ok')
  expect(elapsed < 200).toBe(true)
})

test('an MCP input of 1,000 long rows is judged in bounded time and size', () => {
  const started = Date.now()
  const rows = Array.from({ length: 1000 }, () => 'x='.repeat(2000))
  const action = extractAction('mcp__x__y', { rows }, null)
  const elapsed = Date.now() - started

  expect(action.kind).toBe('ok')
  expect(elapsed < 200).toBe(true)
  expect(action.kind === 'ok' && action.judgeText.length < 1700).toBe(true)
})

test('a small MCP object is judged in full', () => {
  const action = extractAction('mcp__x__y', { a: 1, b: 'two', c: [1, 2], d: { e: 'f' } }, null)

  expect(action).toEqual({
    kind: 'ok',
    tool: 'mcp__x__y',
    target: 'mcp__x__y',
    judgeText: 'tool: mcp__x__y\nargs: {"a":1,"b":"two","c":[1,2],"d":{"e":"f"}}',
  })
})

test('a Windows root-relative path is on the drive of a Windows cwd', () => {
  expect(normalizePath('\\proj\\src\\A.ts', 'C:\\proj')).toBe('src/a.ts')
})

test('a POSIX root-relative path is left alone under a POSIX cwd', () => {
  expect(normalizePath('/proj/x', '/home/u/proj')).toBe('/proj/x')
})

test('a Bash command cut inside URL userinfo leaks no run of the credential', () => {
  const action = extractAction('Bash', { command: 'curl https://user:' + 's'.repeat(3000) + '@example.com' }, null)

  expect(action.kind).toBe('ok')
  if (action.kind !== 'ok') return
  expect(/s{11}/.test(action.target)).toBe(false)
  expect(/s{11}/.test(action.judgeText)).toBe(false)
})

test('a credential whose @ falls past the target window is not shown in the target', () => {
  const action = extractAction('Bash', { command: 'curl https://user:' + 'p'.repeat(700) + '@example.com' }, null)

  expect(action.kind).toBe('ok')
  if (action.kind !== 'ok') return
  expect(/p{11}/.test(action.target)).toBe(false)
  expect(action.target).toBe('curl https://«redacted»')
})

test('a Bash command cut inside a colon-less URL authority leaks no run of the host', () => {
  const action = extractAction('Bash', { command: 'curl https://' + 's'.repeat(700) + '@example.com' }, null)

  expect(action.kind).toBe('ok')
  if (action.kind !== 'ok') return
  expect(/s{11}/.test(action.target)).toBe(false)
  expect(/s{11}/.test(action.judgeText)).toBe(false)
})

test('a complete URL in a Bash command is unchanged', () => {
  const action = extractAction('Bash', { command: 'curl https://example.com' }, null)

  expect(action).toEqual({
    kind: 'ok',
    tool: 'Bash',
    target: 'curl https://example.com',
    judgeText: 'tool: Bash\ncommand:\ncurl https://example.com',
  })
})

test('a credential key in an MCP argument is redacted in judge text', () => {
  const action = extractAction('mcp__x__y', { data: { 'https://bob:hunter2@example.com': 'x' } }, null)

  expect(action.kind === 'ok' && action.judgeText.includes('hunter2')).toBe(false)
})

test('a Write outside cwd with a credential-looking cwd leaks no credential', () => {
  const action = extractAction('Write', { file_path: '../outside/a', content: 'x' }, '/w/token=hunter2/proj')

  expect(action.kind === 'ok' && action.target.includes('hunter2')).toBe(false)
  expect(action.kind === 'ok' && action.judgeText.includes('hunter2')).toBe(false)
})

test('an absolute and a relative spelling of one file under a credential-looking cwd give equal targets', () => {
  const cwd = '/w/token=x/proj'
  const relative = extractAction('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, cwd)
  const absolute = extractAction('Edit', { file_path: '/w/token=x/proj/src/a.ts', old_string: 'a', new_string: 'b' }, cwd)

  expect(relative.kind === 'ok' && absolute.kind === 'ok').toBe(true)
  if (relative.kind !== 'ok' || absolute.kind !== 'ok') return
  expect(relative.target).toBe(absolute.target)
})

test('an MCP object with a single 40,000-character key is judged in bounded time', () => {
  const started = Date.now()
  const action = extractAction('mcp__x__y', { ['x='.repeat(20000)]: 'v' }, null)
  const elapsed = Date.now() - started

  expect(action.kind).toBe('ok')
  expect(elapsed < 100).toBe(true)
})

test('a normal URL with a port and path fully inside the window stays unredacted in judge text', () => {
  const action = extractAction('Bash', { command: 'curl https://example.com:8443/path' }, null)

  expect(action.kind === 'ok' && action.judgeText.includes('https://example.com:8443/path')).toBe(true)
})

test('bound does not split a surrogate pair', () => {
  expect(bound('a😀b', 2)).toBe('a…[+2 chars]')
  expect(bound('a😀b', 3)).toBe('a😀…[+1 chars]')
})

test('a POSIX path outside cwd stays absolute', () => {
  expect(normalizePath('/etc/hosts', '/home/u/proj')).toBe('/etc/hosts')
})

test('a relative path is taken from cwd', () => {
  expect(normalizePath('src/a.ts', '/home/u/proj')).toBe('src/a.ts')
  expect(normalizePath('./src/a.ts', '/home/u/proj')).toBe('src/a.ts')
})

test('with no cwd the path is only normalised', () => {
  expect(normalizePath('/a//b\\c', null)).toBe('/a/b/c')
  expect(normalizePath('\\\\server\\share\\a.ts', null)).toBe('//server/share/a.ts')
})

test('bound keeps short text and marks the cut in long text', () => {
  expect(bound('abc', 3)).toBe('abc')
  expect(bound('abcdef', 3)).toBe('abc…[+3 chars]')
})

test('an Edit is judged by its path, flag and bounded excerpts', () => {
  const action = extractAction(
    'Edit',
    { file_path: '/w/proj/src/a.ts', old_string: 'foo', new_string: 'bar', replace_all: false },
    '/w/proj',
  )

  expect(action).toEqual({
    kind: 'ok',
    tool: 'Edit',
    target: 'src/a.ts',
    judgeText: 'tool: Edit\nfile: src/a.ts\nreplace_all: false\nold:\nfoo\nnew:\nbar',
  })
})

test('an Edit excerpt over 600 characters is bounded', () => {
  const action = extractAction('Edit', { file_path: '/w/a.ts', old_string: 'x'.repeat(700), new_string: '' }, '/w')

  expect(action.kind).toBe('ok')
  expect(action.kind === 'ok' && action.judgeText.includes('x'.repeat(600) + '…[+100 chars]')).toBe(true)
})

test('an Edit redacts a credential in its old or new text', () => {
  const action = extractAction('Edit', { file_path: '/w/a.ts', old_string: 'password=hunter2', new_string: '' }, '/w')

  expect(action.kind === 'ok' && action.judgeText.includes('password=«redacted»')).toBe(true)
  expect(action.kind === 'ok' && action.judgeText.includes('hunter2')).toBe(false)
})

test('a Write reports its length and a bounded head', () => {
  const action = extractAction('Write', { file_path: '/w/a.md', content: 'a'.repeat(1200) }, '/w')

  expect(action.kind).toBe('ok')
  if (action.kind !== 'ok') return
  expect(action.target).toBe('a.md')
  expect(action.judgeText.startsWith('tool: Write\nfile: a.md\nlength: 1200 chars\ncontent head:\n')).toBe(true)
  expect(action.judgeText.endsWith('a'.repeat(1000) + '…[+200 chars]')).toBe(true)
})

test('a NotebookEdit targets the notebook and its cell', () => {
  const action = extractAction(
    'NotebookEdit',
    { notebook_path: '/w/proj/n.ipynb', cell_id: 'c1', edit_mode: 'replace', new_source: 'print(1)' },
    '/w/proj',
  )

  expect(action).toEqual({
    kind: 'ok',
    tool: 'NotebookEdit',
    target: 'n.ipynb#c1',
    judgeText: 'tool: NotebookEdit\nfile: n.ipynb\ncell id: c1\nedit mode: replace\nnew source:\nprint(1)',
  })
})

test('a NotebookEdit without a cell id targets the notebook alone', () => {
  const action = extractAction('NotebookEdit', { notebook_path: '/w/n.ipynb', new_source: '' }, '/w')

  expect(action.kind === 'ok' && action.target).toBe('n.ipynb')
})

test('a Bash command is judged in full and targeted by its first line', () => {
  const action = extractAction('Bash', { command: 'npm test\necho done' }, '/w')

  expect(action).toEqual({
    kind: 'ok',
    tool: 'Bash',
    target: 'npm test',
    judgeText: 'tool: Bash\ncommand:\nnpm test\necho done',
  })
})

test('a long first line of a command is bounded to 120 characters in the target', () => {
  const action = extractAction('Bash', { command: 'a'.repeat(200) }, null)

  expect(action.kind === 'ok' && action.target).toBe('a'.repeat(120) + '…[+80 chars]')
})

test('a Bash command redacts a credential in its target and judge text', () => {
  const action = extractAction('Bash', { command: 'export TOKEN=abc123 && run' }, null)

  expect(action.kind).toBe('ok')
  if (action.kind !== 'ok') return
  expect(action.target.includes('abc123')).toBe(false)
  expect(action.judgeText.includes('abc123')).toBe(false)
  expect(action.judgeText).toContain('TOKEN=«redacted»')
})

test('a PowerShell command is judged like a Bash command', () => {
  const action = extractAction('PowerShell', { command: 'Remove-Item x' }, null)

  expect(action).toEqual({
    kind: 'ok',
    tool: 'PowerShell',
    target: 'Remove-Item x',
    judgeText: 'tool: PowerShell\ncommand:\nRemove-Item x',
  })
})

test('an mcp tool is judged by its name and redacted, bounded arguments', () => {
  const action = extractAction('mcp__github__create_issue', { title: 'x', body: 'password=zz' }, null)

  expect(action).toEqual({
    kind: 'ok',
    tool: 'mcp__github__create_issue',
    target: 'mcp__github__create_issue',
    judgeText: 'tool: mcp__github__create_issue\nargs: {"title":"x","body":"password=«redacted»"}',
  })
})

test('mcp arguments are bounded at 1,500 characters', () => {
  const action = extractAction('mcp__x__y', { data: 'a'.repeat(2000) }, null)

  expect(action.kind === 'ok' && action.judgeText.includes('…[+')).toBe(true)
  expect(action.kind === 'ok' && action.judgeText.length < 1600).toBe(true)
})

test('any other tool is judged by its name and bounded arguments', () => {
  const action = extractAction('WebFetch', { url: 'https://x' }, null)

  expect(action).toEqual({
    kind: 'ok',
    tool: 'WebFetch',
    target: 'WebFetch',
    judgeText: 'tool: WebFetch\nargs: {"url":"https://x"}',
  })
})

test('a missing required field is unsupported with reason no-target', () => {
  expect(extractAction('Edit', { old_string: 'x' }, null)).toEqual({
    kind: 'unsupported',
    tool: 'Edit',
    target: 'Edit',
    reason: 'no-target',
  })
  expect(extractAction('Write', { content: 'x' }, null)).toEqual({
    kind: 'unsupported',
    tool: 'Write',
    target: 'Write',
    reason: 'no-target',
  })
  expect(extractAction('NotebookEdit', { new_source: 'x' }, null)).toEqual({
    kind: 'unsupported',
    tool: 'NotebookEdit',
    target: 'NotebookEdit',
    reason: 'no-target',
  })
  expect(extractAction('Bash', { command: '   ' }, null)).toEqual({
    kind: 'unsupported',
    tool: 'Bash',
    target: 'Bash',
    reason: 'no-target',
  })
  expect(extractAction('PowerShell', {}, null)).toEqual({
    kind: 'unsupported',
    tool: 'PowerShell',
    target: 'PowerShell',
    reason: 'no-target',
  })
})

test('an input that is not an object is unsupported and never throws', () => {
  for (const input of [undefined, null, 'x', 42, true, []]) {
    for (const tool of ['Edit', 'Bash', 'mcp__x__y', 'WebFetch']) {
      expect(extractAction(tool, input, null)).toEqual({
        kind: 'unsupported',
        tool,
        target: tool,
        reason: 'no-target',
      })
    }
  }
})

test('an input that cannot be serialised is unsupported and never throws', () => {
  const input = { big: BigInt(1) }

  expect(extractAction('WebFetch', input, null)).toEqual({
    kind: 'unsupported',
    tool: 'WebFetch',
    target: 'WebFetch',
    reason: 'no-target',
  })
})

test('a fingerprint is 64 lower-case hex digits', async () => {
  expect(HEX_64.test(await fingerprint('charter', 1, 'Edit', 'text'))).toBe(true)
})

test('equal inputs give equal fingerprints', async () => {
  const a = await fingerprint('charter', 1, 'Edit', 'text')
  const b = await fingerprint('charter', 1, 'Edit', 'text')

  expect(a).toBe(b)
})

test('a fingerprint changes with the judge text, rev or charter id', async () => {
  const base = await fingerprint('charter', 1, 'Edit', 'text')

  expect(await fingerprint('charter', 1, 'Edit', 'other')).not.toBe(base)
  expect(await fingerprint('charter', 2, 'Edit', 'text')).not.toBe(base)
  expect(await fingerprint('other', 1, 'Edit', 'text')).not.toBe(base)
})

test('two different Edits to the same file have different fingerprints', async () => {
  const first = extractAction('Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }, '/w')
  const second = extractAction('Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'c' }, '/w')

  expect(first.kind === 'ok' && second.kind === 'ok').toBe(true)
  if (first.kind !== 'ok' || second.kind !== 'ok') return
  const fromFirst = await fingerprint('charter', 1, first.tool, first.judgeText)
  const fromSecond = await fingerprint('charter', 1, second.tool, second.judgeText)

  expect(fromFirst).not.toBe(fromSecond)
})
