import { ownDataProperty } from '../agent-message';
import { isTownHallRoom, type TownHallRoom } from './town-hall-plan';

export const TOWN_HALL_ROOM_MARKER = '[discord-surface:town-hall:v1]' as const;

const RESPONSE_REQUIRED = ['id', 'guild_id', 'type', 'topic'] as const;
const EXPECTED_REQUIRED = ['guildId', 'channelId'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// True proves only this response identity and marker, not permission, live room
// stability, or caller authority.
export function validateTownHallRoomIdentity(response: unknown, expected: TownHallRoom): boolean {
  try {
    if (!isRecord(response) || !isRecord(expected)) return false;
    if (!RESPONSE_REQUIRED.every(key => ownDataProperty(response, key))) return false;
    if (!EXPECTED_REQUIRED.every(key => ownDataProperty(expected, key))) return false;
    if (!isTownHallRoom(expected)) return false;

    if (response.id !== expected.channelId) return false;
    if (response.guild_id !== expected.guildId) return false;
    if (response.type !== 0) return false;
    if (typeof response.topic !== 'string') return false;

    const suffix = response.topic.slice(TOWN_HALL_ROOM_MARKER.length);
    return response.topic.startsWith(TOWN_HALL_ROOM_MARKER) && (suffix === '' || /^\s/.test(suffix));
  } catch {
    return false;
  }
}
