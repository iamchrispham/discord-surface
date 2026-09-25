export function qualifiedReadbackInstant(value: unknown, field = 'observedAt'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const input = value.replace(/[t ]/, 'T').replace(/z$/, 'Z');
  const match = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(input);
  if (!match || /-00:?00$/.test(input)) throw new Error(`${field} must be a timezone-qualified ISO timestamp`);
  const hours = Number(match[9] || 0);
  const minutes = Number(match[10] || 0);
  const instant = Date.parse(input.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  const offsetMinutes = (match[8] === '-' ? -1 : 1) * (hours * 60 + minutes);
  if (hours > 23 || minutes > 59 || !Number.isFinite(instant)) {
    throw new Error(`${field} must be a timezone-qualified ISO timestamp`);
  }
  const localInstant = instant + offsetMinutes * 60_000;
  const localDate = new Date(localInstant);
  const sameCalendar = (date: Date): boolean => date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) && date.getUTCDate() === Number(match[3]);
  const sameTime = sameCalendar(localDate) && localDate.getUTCHours() === Number(match[4]) &&
    localDate.getUTCMinutes() === Number(match[5]) && localDate.getUTCSeconds() === Number(match[6] || 0);
  const endOfDay = /T24:00(?::00(?:\.0+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(input) &&
    localDate.getUTCHours() === 0 && localDate.getUTCMinutes() === 0 && localDate.getUTCSeconds() === 0 &&
    sameCalendar(new Date(localInstant - 86_400_000));
  if (!sameTime && !endOfDay) throw new Error(`${field} must be a timezone-qualified ISO timestamp`);
  return new Date(instant).toISOString();
}
