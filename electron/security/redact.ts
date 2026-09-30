const SENSITIVE = /(pass(word)?|secret|token|key|authorization)/i;

/** Deep-clones an object, masking sensitive fields. Use before any logging/audit write. */
export function redact<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : redact(v)])
    ) as T;
  }
  return value;
}
