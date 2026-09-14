import {
  THREAD_INTAKE_REASONS,
  THREAD_RECEIPT_KINDS,
  THREAD_STATES,
  createThreadEnrollmentHandlers,
  type ThreadBinding,
  type ThreadEnrollment,
  type ThreadEnrollmentDependencies,
  type ThreadEnrollmentState,
  type ThreadIntakeReason,
  type ThreadReceiptKind,
  type ThreadRoute,
  type ThreadState
} from '../src/state/thread-enrollment';

const nativeId = '9caa5d21-2169-429d-918b-5f08651b5dbd';

const binding: ThreadBinding = {
  channelId: 'parent',
  guildId: 'guild',
  provider: 'codex',
  nativeId,
  workspace: '/tmp/workspace',
  sessionRoot: null,
  endpoint: null,
  categoryId: null,
  conductorId: null,
  repoKey: null,
  readiness: 'ready',
  generation: 1,
  active: true
};

const enrollment: ThreadEnrollment = {
  threadId: 'child',
  parentChannelId: binding.channelId,
  guildId: binding.guildId,
  state: THREAD_STATES.PENDING,
  active: true,
  adoptedThroughId: null,
  adoptedAt: null,
  lastSeenId: null,
  recoveredThroughId: null,
  lastAcceptedId: null,
  gapFrom: null,
  gapTo: null,
  detail: null,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:00:00.000Z'
};

const db: ThreadEnrollmentState['db'] = {
  prepare: () => ({
    all: <T extends Record<string, unknown> = Record<string, unknown>>(..._parameters: unknown[]) => [] as T[],
    get: <T extends Record<string, unknown> = Record<string, unknown>>(..._parameters: unknown[]) => undefined as T | undefined,
    run: (..._parameters: unknown[]) => undefined
  })
};

const state: ThreadEnrollmentState = {
  db,
  transaction: operation => operation(),
  getBinding: id => id === binding.channelId ? binding : null,
  receipt: () => undefined
};

const dependencies: ThreadEnrollmentDependencies = {
  BindingError: class extends Error {},
  THREAD_STATES,
  READINESS: { READY: 'ready' },
  assertText: value => String(value),
  bindingMatchesExpected: () => true,
  compareDiscordIds: (left, right) => String(left).localeCompare(String(right)),
  now: () => '2026-09-13T00:00:00.000Z'
};

const handlers = createThreadEnrollmentHandlers(dependencies);
const route: ThreadRoute = {
  binding,
  enrollment,
  deliveryChannelId: enrollment.threadId,
  ready: false,
  handoffCutoffId: null
};
const stateValue: ThreadState = THREAD_STATES.READY;
const routeValue = handlers.getMessageRoute(state, binding.channelId);
const enrollmentValue = handlers.getThreadEnrollment(state, enrollment.threadId);
const receiptKind: ThreadReceiptKind = THREAD_RECEIPT_KINDS.RECONCILED;
const intakeReason: ThreadIntakeReason = THREAD_INTAKE_REASONS.GAP;

// @ts-expect-error thread states reject values outside the finite vocabulary
const invalidState: ThreadState = 'failed';
// @ts-expect-error thread receipt kinds reject values outside the finite vocabulary
const invalidReceiptKind: ThreadReceiptKind = 'thread-enroled';
// @ts-expect-error thread intake reasons reject values outside the finite vocabulary
const invalidIntakeReason: ThreadIntakeReason = 'thread-timeout';
// @ts-expect-error binding providers reject unknown values
const invalidProvider: ThreadBinding['provider'] = 'native';
// @ts-expect-error enrollment state rejects values outside the finite vocabulary
const invalidEnrollment: ThreadEnrollment = { ...enrollment, state: 'recovering' };
// @ts-expect-error routes require the actual delivery channel identity
const invalidRoute: ThreadRoute = { binding, enrollment, ready: false };

void nativeId;
void route;
void stateValue;
void routeValue;
void enrollmentValue;
void receiptKind;
void intakeReason;
void invalidState;
void invalidReceiptKind;
void invalidIntakeReason;
void invalidProvider;
void invalidEnrollment;
void invalidRoute;
void handlers;
