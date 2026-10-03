import {
  planTownHallRoomParts,
  TOWN_HALL_ROOM_PARTS,
  type TownHallRoomPart,
  type TownHallRoomParts
} from '../../src/peer/town-hall-room-parts';

const source: unknown = JSON.parse('{"broadcastId":"b1"}');

const result: TownHallRoomParts = planTownHallRoomParts(source);
const version: 1 = result.version;
const broadcastId: string = result.plan.broadcastId;
const planText: string = result.plan.text;
const parts: readonly TownHallRoomPart[] = result.parts;
const first: TownHallRoomPart = result.parts[0];
const index: number = first.index;
const total: number = first.total;
const partId: string = first.partId;
const content: string = first.content;
const limit: 2000 = TOWN_HALL_ROOM_PARTS.CONTENT_LIMIT;
const prefix: 'townhall_room_' = TOWN_HALL_ROOM_PARTS.ID_PREFIX;

// @ts-expect-error the version is the literal readonly 1
result.version = 2;
// @ts-expect-error plan text is part of the frozen planner result
result.plan.text = 'replacement';
// @ts-expect-error the parts array is readonly and cannot be reassigned
result.parts = result.parts;
// @ts-expect-error the part index is read only
first.index = 2;
// @ts-expect-error the part total is read only
first.total = 99;
// @ts-expect-error the part id is read only
first.partId = 'townhall_room_other';
// @ts-expect-error the part content is read only
first.content = 'replacement';

void version;
void broadcastId;
void planText;
void parts;
void index;
void total;
void partId;
void content;
void limit;
void prefix;
