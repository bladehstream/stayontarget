import { redactText, redactValue } from './redact'

export type Action =
  | { kind: 'ok'; tool: string; target: string; judgeText: string }
  | { kind: 'unsupported'; tool: string; target: string; reason: 'no-target' }

const EDIT_EXCERPT = 600
const WRITE_HEAD = 1000
const COMMAND_MAX = 2000
const TARGET_MAX = 120
const MCP_ARGS_MAX = 1500
const OTHER_ARGS_MAX = 1000
// Text is redacted only up to its display bound plus this margin, so a secret cut at the bound is still seen.
export const REDACT_WINDOW_MARGIN = 512
const STRING_CAP = 4096
const KEY_CAP_LENGTH = 256
const PATH_CAP = 4096
const NODE_BUDGET = 200
const ITEM_CAP = 50
const KEY_CAP = 50
const DEPTH_CAP = 6
const BUDGET_MARK = '«budget»'

function slashify(path: string): string {
  const forward = path.replace(/\\/g, '/')
  const unc = forward.startsWith('//')
  return (unc ? '//' : '') + forward.replace(/\/+/g, '/').slice(unc ? 1 : 0)
}

function looksWindows(path: string): boolean {
  return /^[A-Za-z]:\//.test(path) || path.startsWith('//')
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path)
}

// Resolves `.` and `..` segments. A `..` above an absolute root is dropped; a leading `..` on a relative path is kept.
function resolveDots(path: string): string {
  const unc = path.startsWith('//')
  const drive = /^[A-Za-z]:/.test(path) ? path.slice(0, 2) : ''
  const body = unc ? path.slice(2) : path.slice(drive.length)
  const absolute = unc || body.startsWith('/')
  const segments: string[] = []
  for (const segment of body.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') segments.push(segment)
    else if (segments.length > 0 && segments[segments.length - 1] !== '..') segments.pop()
    else if (!absolute) segments.push('..')
  }
  const root = unc ? '//' : drive + (body.startsWith('/') ? '/' : '')
  return root + segments.join('/')
}

// Windows paths are compared and returned lower-cased, so spellings that differ only in case are the same path.
// POSIX paths keep their case.
export function normalizePath(path: string, cwd: string | null): string {
  const base = cwd === null ? null : resolveDots(slashify(cwd).replace(/\/+$/, ''))
  let full = slashify(path)
  // A root-relative path (`\proj\x`) on a Windows cwd is on that cwd's drive.
  const drive = base === null ? null : /^[A-Za-z]:/.exec(base)?.[0] ?? null
  if (drive !== null && full.startsWith('/') && !full.startsWith('//')) full = `${drive}${full}`
  if (base !== null && !isAbsolute(full)) full = `${base}/${full}`
  full = resolveDots(full)

  const windows = looksWindows(full)
  const fold = (text: string) => (windows ? text.toLowerCase() : text)
  const relative = base !== null && fold(full).startsWith(`${fold(base)}/`) ? full.slice(base.length + 1) : null
  return fold(relative ?? full).replace(/^(?:\.\/)+/, '')
}

// The index to cut `text` at so that it keeps `max` units without splitting a surrogate pair.
function cutIndex(text: string, max: number): number {
  const last = text.charCodeAt(max - 1)
  return last >= 0xd800 && last <= 0xdbff ? max - 1 : max
}

// Counts UTF-16 units, the same convention as the Write `length` field.
export function bound(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, cutIndex(text, max))}…[+${text.length - max} chars]`
}

// Redacts a window of the text, then keeps its first `max` units; the marker counts the whole text.
function excerpt(text: string, max: number): string {
  const window = text.slice(0, max + REDACT_WINDOW_MARGIN)
  const head = redactText(window, text.length > window.length)
  const kept = head.length <= max ? head : head.slice(0, cutIndex(head, max))
  return text.length <= max ? kept : `${kept}…[+${text.length - max} chars]`
}

interface Budget {
  nodes: number
  chars: number
  limit: number
}

// Copies the input within a budget: at most NODE_BUDGET values, ITEM_CAP items per array, KEY_CAP keys per object,
// DEPTH_CAP levels, strings cut to STRING_CAP, and nothing more once `budget.limit` characters are counted.
function prune(value: unknown, depth: number, budget: Budget): unknown {
  if (budget.nodes >= NODE_BUDGET || budget.chars >= budget.limit) return BUDGET_MARK
  budget.nodes += 1
  if (typeof value === 'string') {
    const cut = value.length > STRING_CAP ? redactText(value.slice(0, STRING_CAP), true) : value
    budget.chars += cut.length
    return cut
  }
  if (typeof value !== 'object' || value === null) return value
  if (depth > DEPTH_CAP) return '«depth»'

  if (Array.isArray(value)) {
    const items = value.slice(0, ITEM_CAP).map(item => prune(item, depth + 1, budget))
    if (value.length > ITEM_CAP) items.push(`«+${value.length - ITEM_CAP} more items»`)
    return items
  }

  const record = value as Record<string, unknown>
  const kept: [string, unknown][] = []
  let keys = 0
  for (const rawKey in record) {
    if (!Object.hasOwn(record, rawKey)) continue
    if (keys < KEY_CAP) {
      const key = rawKey.length > KEY_CAP_LENGTH ? rawKey.slice(0, KEY_CAP_LENGTH) : rawKey
      budget.chars += key.length
      kept.push([key, prune(record[rawKey], depth + 1, budget)])
    }
    keys += 1
  }
  if (keys > KEY_CAP) kept.push(['…', `«+${keys - KEY_CAP} more keys»`])
  return Object.fromEntries(kept)
}

function requiredString(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function optionalString(fields: Record<string, unknown>, key: string): string {
  const value = fields[key]
  return typeof value === 'string' ? value : ''
}

function genericAction(tool: string, fields: Record<string, unknown>, max: number): Action {
  const pruned = prune(fields, 0, { nodes: 0, chars: 0, limit: max + REDACT_WINDOW_MARGIN })
  const args = bound(JSON.stringify(redactValue(pruned)), max)
  return { kind: 'ok', tool, target: redactText(tool), judgeText: `tool: ${redactText(tool)}\nargs: ${args}` }
}

export function extractAction(tool: string, input: unknown, cwd: string | null): Action {
  const unsupported: Action = { kind: 'unsupported', tool, target: redactText(tool), reason: 'no-target' }
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return unsupported
    const fields = input as Record<string, unknown>

    if (tool.startsWith('mcp__')) return genericAction(tool, fields, MCP_ARGS_MAX)

    switch (tool) {
      case 'Edit': {
        const path = requiredString(fields, 'file_path')
        if (path === null) return unsupported
        const file = redactText(normalizePath(path.slice(0, PATH_CAP), cwd))
        const judgeText = [
          'tool: Edit',
          `file: ${file}`,
          `replace_all: ${fields.replace_all === true}`,
          'old:',
          excerpt(optionalString(fields, 'old_string'), EDIT_EXCERPT),
          'new:',
          excerpt(optionalString(fields, 'new_string'), EDIT_EXCERPT),
        ].join('\n')
        return { kind: 'ok', tool, target: file, judgeText }
      }

      case 'Write': {
        const path = requiredString(fields, 'file_path')
        if (path === null) return unsupported
        const file = redactText(normalizePath(path.slice(0, PATH_CAP), cwd))
        const content = optionalString(fields, 'content')
        const judgeText = [
          'tool: Write',
          `file: ${file}`,
          `length: ${content.length} chars`,
          'content head:',
          excerpt(content, WRITE_HEAD),
        ].join('\n')
        return { kind: 'ok', tool, target: file, judgeText }
      }

      case 'NotebookEdit': {
        const path = requiredString(fields, 'notebook_path')
        if (path === null) return unsupported
        const file = redactText(normalizePath(path.slice(0, PATH_CAP), cwd))
        const cellRaw = fields.cell_id
        const cell = typeof cellRaw === 'string' || typeof cellRaw === 'number' ? redactText(String(cellRaw)) : null
        const mode = requiredString(fields, 'edit_mode')
        const judgeText = [
          'tool: NotebookEdit',
          `file: ${file}`,
          `cell id: ${cell ?? '(none)'}`,
          `edit mode: ${mode ?? '(none)'}`,
          'new source:',
          excerpt(optionalString(fields, 'new_source'), EDIT_EXCERPT),
        ].join('\n')
        return { kind: 'ok', tool, target: cell === null ? file : `${file}#${cell}`, judgeText }
      }

      case 'Bash':
      case 'PowerShell': {
        const command = requiredString(fields, 'command')
        if (command === null) return unsupported
        const window = command.slice(0, TARGET_MAX + REDACT_WINDOW_MARGIN)
        const firstLine = redactText(window, command.length > window.length).split(/\r?\n/)[0] ?? ''
        return {
          kind: 'ok',
          tool,
          target: bound(firstLine, TARGET_MAX),
          judgeText: `tool: ${tool}\ncommand:\n${excerpt(command, COMMAND_MAX)}`,
        }
      }

      default:
        return genericAction(tool, fields, OTHER_ARGS_MAX)
    }
  } catch {
    return unsupported
  }
}

export async function fingerprint(charterId: string, rev: number, tool: string, judgeText: string): Promise<string> {
  const material = [charterId, String(rev), tool, judgeText].join('\u0000')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
