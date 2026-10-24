// The control characters a drawing refuses: every C0 control but tab and newline, DEL, and the C1 controls (FR-UI-2). A
// refused character would make the engine refuse the whole tree, so each one is drawn as a visible escape instead.
const UNPRINTABLE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

// The text as a drawing may hold it: each unprintable character as `\xNN`, tab and newline kept (FR-UI-2, FR-UI-6).
export function printable(text: string): string {
  return text.replace(UNPRINTABLE, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
}
