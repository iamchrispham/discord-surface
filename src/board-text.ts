export const BOARD_MESSAGE_LIMIT = 2000;

export function normalizeBoardText(value: string): string {
  return value.replace(/[\r\n]+$/u, '');
}

export function readBoardText(value: unknown): string {
  const normalized = typeof value === 'string' ? normalizeBoardText(value) : '';
  if (typeof value !== 'string' || normalized.length === 0 || normalized.length > BOARD_MESSAGE_LIMIT || !normalized.trim() || /[\u0000\u007f]/.test(normalized)) {
    throw new Error('board text must be non-empty and at most 2000 characters');
  }
  return normalized;
}

export function boardTextEquivalent(left: string, right: string): boolean {
  return normalizeBoardText(left) === normalizeBoardText(right);
}
