import type { AcknowledgmentCommandInput } from './acknowledgment/contracts';
export type { AcknowledgmentMessage, AcknowledgmentBinding, AcknowledgmentState, NativeAcknowledgmentInput, AcknowledgmentCommandInput, NativeAcknowledgmentResult, AcknowledgmentWaitStopped, AcknowledgmentWatch, AcknowledgmentSend, AcknowledgmentDelivery, AcknowledgmentWatchOptions } from './acknowledgment/contracts';
export type { NativeProvider, MessageState, AcknowledgmentOutcome } from './acknowledgment/constants';
import * as path from 'node:path';

import { ACK, ACK_OUTCOMES, ACK_WAITING, NATIVE_PROVIDERS, REACTION } from './acknowledgment/constants';
import { isAcknowledgmentPending, pendingAcknowledgments, recordNativeAcknowledgment } from './acknowledgment/receipts';
import { createAcknowledgmentDelivery, waitForAcknowledgment } from './acknowledgment/delivery';
import { watchAcknowledgments } from './acknowledgment/watch';

export { ACK, ACK_OUTCOMES, ACK_WAITING, NATIVE_PROVIDERS, REACTION };
export { isAcknowledgmentPending, pendingAcknowledgments, recordNativeAcknowledgment };
export { createAcknowledgmentDelivery, waitForAcknowledgment };
export { watchAcknowledgments };

export function acknowledgmentCommand(message: AcknowledgmentCommandInput, dbPath: string, cliPath = path.join(__dirname, '..', 'src', 'cli.js')): string[] {
  return [process.execPath, cliPath, 'native-ack', '--db', dbPath,
    '--provider', message.provider, '--message-id', message.id,
    '--native-id', message.nativeId, '--generation', String(message.generation)];
}
