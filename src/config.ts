export type Config = { mode: 'warn' | 'strict'; model: string; toasts: boolean; notify: boolean }

export const DEFAULT_CONFIG: Config = { mode: 'warn', model: 'haiku', toasts: false, notify: false }

export function parseConfig(options: unknown): Config {
  const fields: Record<string, unknown> =
    typeof options === 'object' && options !== null ? (options as Record<string, unknown>) : {}
  const { mode, model, toasts, notify } = fields

  return {
    mode: mode === 'warn' || mode === 'strict' ? mode : DEFAULT_CONFIG.mode,
    model: typeof model === 'string' && model.trim() !== '' ? model : DEFAULT_CONFIG.model,
    toasts: typeof toasts === 'boolean' ? toasts : DEFAULT_CONFIG.toasts,
    notify: typeof notify === 'boolean' ? notify : DEFAULT_CONFIG.notify,
  }
}
