import {
  TOWN_HALL_ROOM_MARKER,
  validateTownHallRoomIdentity
} from '../../src/peer/town-hall-room-identity';
import type { TownHallRoom } from '../../src/peer/town-hall-plan';

const room: TownHallRoom = Object.freeze({
  guildId: '111111111111111111',
  channelId: '222222222222222222'
});
const response: unknown = JSON.parse(
  '{"id":"222222222222222222","guild_id":"111111111111111111","type":0,' +
  '"topic":"[discord-surface:town-hall:v1]"}'
);
const notARoom: { guildId: string; channelId: number } = { guildId: room.guildId, channelId: 7 };
const partial: { guildId: string } = { guildId: room.guildId };

const accepted: boolean = validateTownHallRoomIdentity(response, room);
const marker: '[discord-surface:town-hall:v1]' = TOWN_HALL_ROOM_MARKER;

void marker;

// @ts-expect-error an unrecognized expected shape is not a TownHallRoom
validateTownHallRoomIdentity(response, notARoom);
// @ts-expect-error a TownHallRoom requires channelId
validateTownHallRoomIdentity(response, partial);
// @ts-expect-error a TownHallRoom is required, not null
validateTownHallRoomIdentity(response, null);
// @ts-expect-error the expected channelId must be a string
validateTownHallRoomIdentity(response, { guildId: room.guildId, channelId: 7 });
// @ts-expect-error the expected guildId must be a string
validateTownHallRoomIdentity(response, { guildId: 7, channelId: room.channelId });

void accepted;
