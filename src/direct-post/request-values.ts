const crypto = require('node:crypto') as typeof import('node:crypto');
const { BindingError } = require('../../src/state') as { BindingError: new (message?: string) => Error };

export function hash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function requiredString(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BindingError(`${name} must be a non-empty string`);
  }
  return value;
}

export function inReplyToValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, 'in-reply-to', 128);
}

export function errorMessage(error: unknown): string {
  return String((error as { message?: unknown }).message || error);
}
