import {
  decodeTownHallChild,
  encodeTownHallChild,
  validateTownHallChild,
  TOWN_HALL_CHILD_CONTRACT,
  type TownHallChildAddress,
  type TownHallChildPacket,
  type TownHallChildRoom
} from '../../src/town-hall-child';

const source: TownHallChildAddress = {
  guildId: '100',
  channelId: '200',
  provider: 'codex',
  nativeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  generation: 1
};

const target: TownHallChildAddress = {
  guildId: '100',
  channelId: '300',
  provider: 'claude',
  nativeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  generation: 1
};

const room: TownHallChildRoom = { guildId: '100', channelId: '900' };

const candidate: unknown = JSON.parse('{}');
validateTownHallChild(candidate);

const packet: TownHallChildPacket = candidate;
const wire: string = encodeTownHallChild(packet, 'disposable-token');
const decoded: TownHallChildPacket | null = decodeTownHallChild(wire, 'disposable-token', target);

const prefix: 'discord-tether:town-hall:v1:' = TOWN_HALL_CHILD_CONTRACT.PREFIX;
const domain: 'discord-tether/town-hall-child/v1' = TOWN_HALL_CHILD_CONTRACT.DOMAIN;
const purpose: 'town-hall-child/v1' = TOWN_HALL_CHILD_CONTRACT.PURPOSE;
const routingVersion: 2 = TOWN_HALL_CHILD_CONTRACT.ROUTING_VERSION;
const maxTextBytes: 10000 = TOWN_HALL_CHILD_CONTRACT.MAX_TEXT_BYTES;
const maxEncodedLength: 81350 = TOWN_HALL_CHILD_CONTRACT.MAX_ENCODED_LENGTH;
const rootFields: readonly string[] = TOWN_HALL_CHILD_CONTRACT.ROOT_FIELDS;

if (decoded !== null) {
  const id: string = decoded.id;
  const kind: 'request' = decoded.kind;
  const replyTo: null = decoded.replyTo;
  const packetPurpose: 'town-hall-child/v1' = decoded.purpose;
  const text: string = decoded.text;
  const broadcastId: string = decoded.broadcastId;
  const journalKey: string = decoded.journalKey;
  const planFingerprint: string = decoded.planFingerprint;
  const roomMessageId: string = decoded.roomMessageId;
  const decodedSource: TownHallChildAddress = decoded.source;
  const decodedTarget: TownHallChildAddress = decoded.target;
  const decodedRoom: TownHallChildRoom = decoded.room;
  void id;
  void kind;
  void replyTo;
  void packetPurpose;
  void text;
  void broadcastId;
  void journalKey;
  void planFingerprint;
  void roomMessageId;
  void decodedSource;
  void decodedTarget;
  void decodedRoom;
}

void source;
void room;
void prefix;
void domain;
void purpose;
void routingVersion;
void maxTextBytes;
void maxEncodedLength;
void rootFields;

// @ts-expect-error packet text is provided only by encode(source)
packet.text = 'replacement';
// @ts-expect-error packet target address is provided only by encode(source)
packet.target = source;
// @ts-expect-error source native identity is provided only by encode(source)
packet.source.nativeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// @ts-expect-error target generation is provided only by encode(source)
packet.target.generation = 2;
// @ts-expect-error room channel identity is provided only by encode(source)
packet.room.channelId = '901';
// @ts-expect-error room message identity is provided only by encode(source)
packet.roomMessageId = '123';
