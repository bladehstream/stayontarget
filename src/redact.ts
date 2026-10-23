export const REDACTED = '«redacted»'

// '_' or '-' (or neither) may separate the words of a key name: api_key, api-key, apikey, AccessKeyId, client-secret.
const SECRET_NAME =
  'password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|proxy-authorization|cookie'
const SECRET_KEY = new RegExp(SECRET_NAME, 'i')
const SECRET_HEADER_KEYS = new Set(['authorization', 'cookie', 'set-cookie'])

// A value is a quoted string or a bare run up to a delimiter. In a double-quoted string a backslash escapes the next
// character; in a single-quoted string a doubled '' is an escaped quote (PowerShell); a bare run continues across a
// backslash-escaped character (`first\ second`). Each alternative ends at its closing quote, or end of input.
const VALUE = `(?:"(?:[^"\\\\]|\\\\[\\s\\S])*"?|'(?:[^'\\\\]|\\\\[\\s\\S]|'')*'?|(?:[^\\s"'&;,\\\\]|\\\\[\\s\\S])+)`
// Each match starts at a token boundary, so a long word is scanned once rather than once per start position.
// name=value, name: value, "name": "value", with any whitespace (newlines too) around the separator and value
// (the name token is checked for a secret name in the replacer)
const ASSIGNMENT = new RegExp(`(?<![\\w-])([\\w-]+)(["']?\\s*[=:]\\s*)${VALUE}`, 'g')
// --name value (a following flag is not a value)
const FLAG = new RegExp(`(?<![\\w-])(--[\\w-]+)([ \\t]+)(?!-)${VALUE}`, 'g')

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g
// The header value ends at the end of the line, or at the quote that closes an enclosing quoted string (curl -H "...").
const AUTH_HEADER = /\b((?:Proxy-)?Authorization[ \t]*:)[ \t]*(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\r\n"']*)/gi
// scheme://user@host, scheme://user:pass@host and scheme://:pass@host; a bare email address is not a URL
const URL_USERINFO = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@:]+(?::[^\s/@]+)?|:[^\s/@]+)@/gi
// Only for text cut by a window: a URL authority that runs to the end of the text may continue past the cut, so it is
// redacted to the end. The authority has no '@' (a complete userinfo is handled above).
const TRUNCATED_AUTHORITY = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*$/gi
const BEARER = /(\bBearer[ \t]+)[A-Za-z0-9\-._~+/]+=*/gi
// Basic is common prose, so only a token that looks like base64 is redacted
const BASIC = /(\b[Bb]asic[ \t]+)([A-Za-z0-9+/]{6,}={0,2})/g
const KEY_FORMATS = [
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{60,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
]

function looksLikeBase64(token: string): boolean {
  return /[0-9+/=]/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1)))
}

// Keeps the quotes of a quoted value and redacts what is inside them.
function redactedValue(value: string): string {
  const quote = value[0]
  if (quote !== '"' && quote !== "'") return REDACTED
  const closed = value.length > 1 && value.endsWith(quote)
  return `${quote}${REDACTED}${closed ? quote : ''}`
}

// Redacts the value of each assignment whose name holds a secret word. A non-secret assignment resumes the
// scan just after its separator, so a secret inside its value (`url=https://x?token=abc`) is still found.
function redactAssignments(text: string, pattern: RegExp): string {
  let out = ''
  let copied = 0
  let found: RegExpExecArray | null
  pattern.lastIndex = 0
  while ((found = pattern.exec(text)) !== null) {
    const whole = found[0]
    const name = found[1] ?? ''
    const separator = found[2] ?? ''
    const valueStart = found.index + name.length + separator.length
    if (!SECRET_KEY.test(name)) {
      pattern.lastIndex = valueStart
      continue
    }
    out += text.slice(copied, valueStart) + redactedValue(whole.slice(name.length + separator.length))
    copied = found.index + whole.length
  }
  return out + text.slice(copied)
}

// `cut` says the text is a window that ends inside the original text.
export function redactText(text: string, cut = false): string {
  let out = text.replace(PEM_BLOCK, REDACTED)
  out = out.replace(AUTH_HEADER, `$1 ${REDACTED}`)
  out = out.replace(URL_USERINFO, `$1${REDACTED}@`)
  out = out.replace(BEARER, `$1${REDACTED}`)
  out = out.replace(BASIC, (match, lead: string, token: string) =>
    looksLikeBase64(token) ? `${lead}${REDACTED}` : match,
  )
  if (cut) out = out.replace(TRUNCATED_AUTHORITY, `$1${REDACTED}`)
  out = redactAssignments(out, FLAG)
  out = redactAssignments(out, ASSIGNMENT)
  for (const format of KEY_FORMATS) out = out.replace(format, REDACTED)
  return out
}

function isSensitiveKey(key: string): boolean {
  return SECRET_KEY.test(key) || SECRET_HEADER_KEYS.has(key.toLowerCase())
}

export function redactValue(value: unknown): unknown {
  return copyRedacted(value, new Set())
}

function copyRedacted(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value === 'string') return redactText(value)
  if (typeof value !== 'object' || value === null) return value
  if (ancestors.has(value)) return '«cycle»'

  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => copyRedacted(item, ancestors))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactText(key),
        isSensitiveKey(key) ? REDACTED : copyRedacted(item, ancestors),
      ]),
    )
  } finally {
    ancestors.delete(value)
  }
}
