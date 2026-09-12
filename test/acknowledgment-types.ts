import {
  ACK,
  ACK_WAITING,
  REACTION,
  acknowledgmentCommand,
  createAcknowledgmentDelivery,
  isAcknowledgmentPending,
  pendingAcknowledgments,
  recordNativeAcknowledgment,
  waitForAcknowledgment,
  watchAcknowledgments,
  type AcknowledgmentMessage,
  type AcknowledgmentOutcome,
  type AcknowledgmentSend,
  type AcknowledgmentState,
  type AcknowledgmentWatch,
  type NativeAcknowledgmentInput,
  type NativeAcknowledgmentResult,
  type NativeProvider
} from '../src/acknowledgment';

declare const state: AcknowledgmentState;
const message: AcknowledgmentMessage = {
  id: 'discord-message-1',
  provider: 'codex',
  nativeId: '9caa5d21-2169-429d-918b-5f08651b5dbd',
  generation: 1,
  state: 'submitted'
};
const provider: NativeProvider = message.provider;
const input: NativeAcknowledgmentInput = {
  provider,
  messageId: message.id,
  nativeId: message.nativeId,
  generation: message.generation
};
const send: AcknowledgmentSend = async (source, reaction) => {
  const id: string = source.id;
  const acknowledged: typeof REACTION.ACKNOWLEDGED = reaction as typeof REACTION.ACKNOWLEDGED;
  void id;
  void acknowledged;
};
const delivery = createAcknowledgmentDelivery({ state, send });
const command: string[] = acknowledgmentCommand(message, '/tmp/surface.sqlite');
const pending: string[] = pendingAcknowledgments(state);
const eligible: boolean = isAcknowledgmentPending(state, message.id);
const result: NativeAcknowledgmentResult = recordNativeAcknowledgment(state, input);
const waiting: typeof ACK_WAITING = ACK_WAITING;
const maybeWaiting = waitForAcknowledgment(state, delivery, message.id);
const watcher: AcknowledgmentWatch = watchAcknowledgments({ state, send, deliver: delivery });
const stopped: Promise<void> = watcher.stop();
void ACK;
void command;
void pending;
void eligible;
void result;
void waiting;
void maybeWaiting;
void stopped;

// @ts-expect-error The provider vocabulary is intentionally closed.
const invalidProvider: NativeAcknowledgmentInput = { ...input, provider: 'spark' };
// @ts-expect-error The reaction outcome vocabulary is intentionally closed.
const invalidOutcome: AcknowledgmentOutcome = 'pending';
void invalidProvider;
void invalidOutcome;
