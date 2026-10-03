import { createHash } from 'node:crypto';
import { planTownHallBroadcast, type TownHallPlan } from './town-hall-plan';

const HASH_DOMAIN = 'discord-surface/town-hall-room-part/v1' as const;
const HIDDEN_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export interface TownHallRoomPart {
  readonly index: number;
  readonly total: number;
  readonly partId: string;
  readonly content: string;
}

export interface TownHallRoomParts {
  readonly version: 1;
  readonly plan: TownHallPlan;
  readonly parts: readonly TownHallRoomPart[];
}

export const TOWN_HALL_ROOM_PARTS = Object.freeze({
  VERSION: 1,
  CONTENT_LIMIT: 2000,
  ID_PREFIX: 'townhall_room_'
} as const);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeUnit(unit: number): string {
  return `\\u${unit.toString(16).padStart(4, '0')}`;
}

// A token is one indivisible unit of the serialized document: one code point,
// one existing JSON escape, or the two surrogate escapes produced from one
// supplementary hidden code point.
function tokenize(document: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < document.length) {
    const codePoint = document.codePointAt(index);
    if (codePoint === undefined) break;
    const unit = document[index];
    const width = codePoint > 0xffff ? 2 : 1;
    if (unit === '\\') {
      const size = document[index + 1] === 'u' ? 6 : 2;
      tokens.push(document.slice(index, index + size));
      index += size;
      continue;
    }
    if (unit === '`' || HIDDEN_CODE_POINT.test(String.fromCodePoint(codePoint))) {
      let escaped = '';
      for (let offset = 0; offset < width; offset += 1) {
        escaped += escapeUnit(document.charCodeAt(index + offset));
      }
      tokens.push(escaped);
      index += width;
      continue;
    }
    tokens.push(document.slice(index, index + width));
    index += width;
  }
  return tokens;
}

function contentFor(
  broadcastId: string,
  fingerprint: string,
  indexLabel: string,
  totalLabel: string,
  segment: string
): string {
  return `Town hall ${broadcastId} ${indexLabel}/${totalLabel}\n` +
    `Fingerprint ${fingerprint}\n` +
    'JSON segment, concatenate in index order:\n' +
    '```json\n' +
    `${segment}\n` +
    '```';
}

function segmentTokens(
  tokens: readonly string[],
  broadcastId: string,
  fingerprint: string,
  width: number
): string[] {
  const label = '9'.repeat(width);
  const budget = TOWN_HALL_ROOM_PARTS.CONTENT_LIMIT -
    contentFor(broadcastId, fingerprint, label, label, '').length;
  const segments: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current.length + token.length <= budget) {
      current += token;
    } else {
      segments.push(current);
      current = token;
    }
  }
  segments.push(current);
  return segments;
}

export function planTownHallRoomParts(input: unknown): TownHallRoomParts {
  const plan = planTownHallBroadcast(input);
  const tokens = tokenize(JSON.stringify(plan));

  // Numbering width must stabilize before the actual index/total labels exist.
  let width = 1;
  let segments = segmentTokens(tokens, plan.broadcastId, plan.fingerprint, width);
  while (String(segments.length).length > width) {
    width = String(segments.length).length;
    segments = segmentTokens(tokens, plan.broadcastId, plan.fingerprint, width);
  }

  const total = segments.length;
  const parts: TownHallRoomPart[] = segments.map((segment, offset) => {
    const index = offset + 1;
    const content = contentFor(plan.broadcastId, plan.fingerprint, String(index), String(total), segment);
    const partId = TOWN_HALL_ROOM_PARTS.ID_PREFIX + sha256Hex(
      JSON.stringify([HASH_DOMAIN, plan.fingerprint, index, total, content])
    );
    return Object.freeze({ index, total, partId, content });
  });

  const result: TownHallRoomParts = {
    version: 1,
    plan,
    parts: Object.freeze(parts)
  };
  return Object.freeze(result);
}
