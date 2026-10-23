import { expect, test } from 'claude-code/testing'

import { REDACTED, redactText, redactValue } from '../src/redact'

// Key-shaped fixtures are assembled from parts, so this file never holds a whole key or token as one literal
// (secret scanners and push protection match on the literal).
const built = (...parts: string[]) => parts.join('')

test('the redaction marker is the guillemet form', () => {
  expect(REDACTED).toBe('«redacted»')
})

test('an Authorization header keeps its name and loses its value', () => {
  expect(redactText('Authorization: Bearer abc.def')).toBe('Authorization: «redacted»')
  expect(redactText('proxy-authorization: xyz')).toBe('proxy-authorization: «redacted»')
})

test('prose that mentions authorization without a header is unchanged', () => {
  expect(redactText('the authorization page is blank')).toBe('the authorization page is blank')
})

test('a bearer token keeps the scheme and loses the token', () => {
  expect(redactText('send Bearer abc123XYZ now')).toBe('send Bearer «redacted» now')
})

test('a basic credential keeps the scheme and loses the token', () => {
  expect(redactText('Basic dXNlcjpwYXNz')).toBe('Basic «redacted»')
  expect(redactText('Basic dGVzdA==')).toBe('Basic «redacted»')
})

test('a basic in prose is unchanged', () => {
  expect(redactText('Basic introduction to the codebase')).toBe('Basic introduction to the codebase')
  expect(redactText('Basic Authentication flow')).toBe('Basic Authentication flow')
})

test('name=value, name: value and JSON assignments redact the value', () => {
  expect(redactText('password=hunter2 ok')).toBe('password=«redacted» ok')
  expect(redactText('API_KEY: abc123')).toBe('API_KEY: «redacted»')
  expect(redactText('{"client_secret": "s3cr3t"}')).toBe('{"client_secret": "«redacted»"}')
  expect(redactText('export TOKEN=abc123 && run')).toBe('export TOKEN=«redacted» && run')
})

test('a value ends at an ampersand, semicolon or comma', () => {
  expect(redactText('https://x.test/?token=abc&b=1')).toBe('https://x.test/?token=«redacted»&b=1')
  expect(redactText('secret=aa;next=bb,c')).toBe('secret=«redacted»;next=bb,c')
})

test('--flag value and --flag=value redact the value', () => {
  expect(redactText('npm run x --token abc')).toBe('npm run x --token «redacted»')
  expect(redactText('tool --api-key=zzz&x=1')).toBe('tool --api-key=«redacted»&x=1')
  expect(redactText('tool --password-file --verbose')).toBe('tool --password-file --verbose')
})

test('a quoted flag value is redacted through its closing quote', () => {
  expect(redactText('tool --password "hunter2"')).toBe('tool --password "«redacted»"')
  expect(redactText("tool --token 'abc123'")).toBe("tool --token '«redacted»'")
  expect(redactText('tool --api-key="a b"')).toBe('tool --api-key="«redacted»"')
})

test('a quoted assignment value is redacted through its closing quote', () => {
  expect(redactText('password="correct horse battery staple"')).toBe('password="«redacted»"')
  expect(redactText('{"token": "x y z"}')).toBe('{"token": "«redacted»"}')
})

test('a quoted value with no closing quote is redacted to the end of input', () => {
  expect(redactText('password="correct horse')).toBe('password="«redacted»')
})

test('an escaped quote inside a quoted JSON value does not end the value early', () => {
  expect(redactText('{"password":"first\\"SECOND_HALF"}')).toBe('{"password":"«redacted»"}')
})

test('an escaped quote inside a quoted flag value does not end the value early', () => {
  expect(redactText('--password "a\\"b c"')).toBe('--password "«redacted»"')
})

test('a JSON value on the next line after its name is redacted', () => {
  expect(redactText('{"token":\n"sensitive-value"}')).toBe('{"token":\n"«redacted»"}')
})

test('an assignment with a newline before its value is redacted', () => {
  expect(redactText('password =\n  hunter2')).toBe('password =\n  «redacted»')
})

test('URL userinfo without a password keeps the host and loses the user', () => {
  expect(redactText('https://opaqueCredential@git.example.com/org/repo')).toBe(
    'https://«redacted»@git.example.com/org/repo',
  )
  expect(redactText('ssh://git@github.com/x')).toBe('ssh://«redacted»@github.com/x')
})

test('a bare email address is not redacted', () => {
  expect(redactText('contact bob@example.com')).toBe('contact bob@example.com')
})

test('a curl Authorization header inside double quotes stops at the closing quote', () => {
  expect(redactText('curl -H "Authorization: Bearer abc123" https://api.example.com/unrelated -X DELETE')).toBe(
    'curl -H "Authorization: «redacted»" https://api.example.com/unrelated -X DELETE',
  )
})

test('a curl Authorization header inside single quotes stops at the closing quote', () => {
  expect(redactText("curl -H 'Authorization: Bearer abc123' https://api.example.com/x")).toBe(
    "curl -H 'Authorization: «redacted»' https://api.example.com/x",
  )
})

test('URL userinfo with an empty user keeps the host and loses the password', () => {
  expect(redactText('redis://:hunter2@localhost:6379')).toBe('redis://«redacted»@localhost:6379')
})

test('an unquoted value continues across a backslash-escaped space', () => {
  expect(redactText('PASSWORD=first\\ second run')).toBe('PASSWORD=«redacted» run')
})

test('a single-quoted value treats a doubled quote as an escaped quote', () => {
  expect(redactText("password='first''SECOND_HALF'")).toBe("password='«redacted»'")
})

test('AWS temporary access key ids are redacted', () => {
  expect(redactText(built('id ', 'AS', 'IA', 'ABCDEFGHIJKLMNOP', ' end'))).toBe('id «redacted» end')
})

test('key names with an optional separator are sensitive', () => {
  const output = redactValue({
    AWS_ACCESS_KEY_ID: 'a',
    aws_secret_access_key: 'b',
    'client-secret': 'c',
    accessKeyId: 'd',
    name: 'kept',
  })

  expect(output).toEqual({
    AWS_ACCESS_KEY_ID: REDACTED,
    aws_secret_access_key: REDACTED,
    'client-secret': REDACTED,
    accessKeyId: REDACTED,
    name: 'kept',
  })
})

test('a quoted Authorization JSON value is redacted through its closing quote', () => {
  expect(redactText('{"Authorization":"opaqueCredential"}')).toBe('{"Authorization":"«redacted»"}')
})

test('a quoted Authorization header value is redacted', () => {
  expect(redactText('Authorization: "opaqueCredential"')).toBe('Authorization: «redacted»')
})

test('a curl Authorization header keeps the URL and the method', () => {
  const output = redactText('curl -H "Authorization: Bearer abc123" https://api.example.com/unrelated -X DELETE')

  expect(output.includes('https://api.example.com/unrelated -X DELETE')).toBe(true)
  expect(output.includes('abc123')).toBe(false)
})

test('a URL authority cut at the end of the window is redacted to the end', () => {
  expect(redactText('curl https://user:' + 's'.repeat(3000), true)).toBe('curl https://«redacted»')
})

test('a cut URL authority with no colon is redacted to the end', () => {
  expect(redactText('curl https://' + 's'.repeat(700), true)).toBe('curl https://«redacted»')
})

test('a complete URL at the end of the text is unchanged when the text was not cut', () => {
  expect(redactText('curl https://example.com')).toBe('curl https://example.com')
  expect(redactText('curl https://localhost:3000')).toBe('curl https://localhost:3000')
})

test('a credential key is redacted as a key', () => {
  expect(redactValue({ 'https://bob:hunter2@example.com': 'x' })).toEqual({ 'https://«redacted»@example.com': 'x' })
})

test('a URL with a port and a path inside the window stays unredacted', () => {
  expect(redactText('see https://example.com:8443/path')).toBe('see https://example.com:8443/path')
})

test('an unterminated quoted secret cut at the end of the window is redacted to the end', () => {
  expect(redactText('password="' + 'z'.repeat(3000))).toBe('password="«redacted»')
})

test('a secret assignment inside a non-secret value is still redacted', () => {
  expect(redactText('url=https://x.test/?token=abc')).toBe('url=https://x.test/?token=«redacted»')
})

test('redaction of a 200,000-character word completes quickly', () => {
  const started = Date.now()
  const output = redactText('a'.repeat(200000))
  const elapsed = Date.now() - started

  expect(output).toBe('a'.repeat(200000))
  expect(elapsed < 200).toBe(true)
})

test('prose that names a secret without an assignment is unchanged', () => {
  expect(redactText('count the tokens in the file')).toBe('count the tokens in the file')
  expect(redactText('password reset page copy')).toBe('password reset page copy')
})

test('an AWS access key id is redacted', () => {
  expect(redactText(built('id ', 'AK', 'IA', 'ABCDEFGHIJKLMNOP', ' end'))).toBe('id «redacted» end')
})

test('GitHub tokens are redacted', () => {
  expect(redactText('ghp_' + 'a'.repeat(36))).toBe(REDACTED)
  expect(redactText('github_pat_' + 'A1_'.repeat(20))).toBe(REDACTED)
})

test('OpenAI and Anthropic keys are redacted', () => {
  expect(redactText('sk-' + 'a'.repeat(24))).toBe(REDACTED)
  expect(redactText('sk-ant-' + 'a'.repeat(24))).toBe(REDACTED)
})

test('a word ending in sk- is not taken for an OpenAI key', () => {
  expect(redactText('risk-assessment-framework-document')).toBe('risk-assessment-framework-document')
})

test('a Slack token is redacted', () => {
  expect(redactText(built('xox', 'b-1234567890-abc'))).toBe(REDACTED)
})

test('a JWT is redacted', () => {
  expect(redactText(built('eyJhbGciOiJIUzI1NiJ9', '.eyJzdWIiOiIxIn0.abc_-DEF'))).toBe(REDACTED)
})

test('a PEM private key block is redacted whole', () => {
  const pem = built('-----BEGIN RSA ', 'PRIVATE KEY-----', '\nMIIB\nQQ==\n-----END RSA ', 'PRIVATE KEY-----')
  expect(redactText(`before\n${pem}\nafter`)).toBe(`before\n${REDACTED}\nafter`)
})

test('a truncated PEM private key block is still redacted to the end', () => {
  expect(redactText(built('-----BEGIN ', 'PRIVATE KEY-----', '\nMIIB'))).toBe(REDACTED)
})

test('prose about PEM files is unchanged', () => {
  expect(redactText('the PEM format is text')).toBe('the PEM format is text')
})

test('URL userinfo keeps the host and loses the password', () => {
  expect(redactText('https://bob:hunter2@example.com/x')).toBe('https://«redacted»@example.com/x')
})

test('a plain URL is unchanged', () => {
  expect(redactText('see https://example.com/path')).toBe('see https://example.com/path')
})

test('redactValue redacts strings and sensitive keys in a deep copy', () => {
  const input = {
    user: 'a',
    password: 'x',
    nested: { api_key: 'k', list: ['token=abc', 7, null] },
    cookie: 'session=1',
    'set-cookie': 'id=2',
    authorization: 'Bearer zzz',
  }
  const before = JSON.parse(JSON.stringify(input))

  expect(redactValue(input)).toEqual({
    user: 'a',
    password: REDACTED,
    nested: { api_key: REDACTED, list: ['token=«redacted»', 7, null] },
    cookie: REDACTED,
    'set-cookie': REDACTED,
    authorization: REDACTED,
  })
  expect(JSON.parse(JSON.stringify(input))).toEqual(before)
})

test('redactValue does not mutate its input and returns a new object', () => {
  const input = { password: 'x' }
  const output = redactValue(input)

  expect(output).not.toBe(input)
  expect(input.password).toBe('x')
})

test('redactValue marks a cycle instead of recursing', () => {
  const input: Record<string, unknown> = { name: 'x' }
  input.self = input

  const output = redactValue(input) as Record<string, unknown>

  expect(output.name).toBe('x')
  expect(output.self).toBe('«cycle»')
})

test('redactValue copies a shared reference twice rather than calling it a cycle', () => {
  const shared = { a: 'one' }

  expect(redactValue({ x: shared, y: shared })).toEqual({ x: { a: 'one' }, y: { a: 'one' } })
})
