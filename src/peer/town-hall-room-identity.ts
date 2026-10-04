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
    const expectedChannelDescriptor = Object.getOwnPropertyDescriptor(expected, 'channelId');
    const expectedGuildDescriptor = Object.getOwnPropertyDescriptor(expected, 'guildId');
    if (!expectedChannelDescriptor || !expectedGuildDescriptor ||
        !Object.hasOwn(expectedChannelDescriptor, 'value') ||
        !Object.hasOwn(expectedGuildDescriptor, 'value')) return false;
    const expectedChannelId = expectedChannelDescriptor.value;
    const expectedGuildId = expectedGuildDescriptor.value;
    if (!isTownHallRoom({ channelId: expectedChannelId, guildId: expectedGuildId })) return false;

    const responseIdDescriptor = Object.getOwnPropertyDescriptor(response, 'id');
    const responseGuildIdDescriptor = Object.getOwnPropertyDescriptor(response, 'guild_id');
    const responseTypeDescriptor = Object.getOwnPropertyDescriptor(response, 'type');
    const responseTopicDescriptor = Object.getOwnPropertyDescriptor(response, 'topic');
    if (!responseIdDescriptor || !responseGuildIdDescriptor ||
        !responseTypeDescriptor || !responseTopicDescriptor ||
        !Object.hasOwn(responseIdDescriptor, 'value') ||
        !Object.hasOwn(responseGuildIdDescriptor, 'value') ||
        !Object.hasOwn(responseTypeDescriptor, 'value') ||
        !Object.hasOwn(responseTopicDescriptor, 'value')) return false;
    const responseId = responseIdDescriptor.value;
    const responseGuildId = responseGuildIdDescriptor.value;
    const responseType = responseTypeDescriptor.value;
    const responseTopic = responseTopicDescriptor.value;

    if (responseId !== expectedChannelId) return false;
    if (responseGuildId !== expectedGuildId) return false;
    if (responseType !== 0) return false;
    if (typeof responseTopic !== 'string') return false;

    const suffix = responseTopic.slice(TOWN_HALL_ROOM_MARKER.length);
    return responseTopic.startsWith(TOWN_HALL_ROOM_MARKER) && (suffix === '' || /^\s/.test(suffix));
  } catch {
    return false;
  }
}
