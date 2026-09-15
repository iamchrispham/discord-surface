import { createDecisionConsumer, type DecisionConsumerState, type DecisionMessage } from '../src/discord/decision';

declare const state: DecisionConsumerState;
declare const message: DecisionMessage;

const consumer = createDecisionConsumer({
  state,
  processAccepted: async (candidate, signal, options) => {
    const id: string = candidate.id;
    const stopped: boolean = Boolean(signal?.aborted);
    const awaitOutcome: unknown = options?.awaitDispatchOutcome;
    return { id, stopped, awaitOutcome };
  }
});

const accepted: Promise<unknown> = consumer.recover();
void accepted;
void message;

// @ts-expect-error The native bridge accepts the state message contract, not a raw string.
createDecisionConsumer({ state, processAccepted: async (candidate: string) => candidate });
