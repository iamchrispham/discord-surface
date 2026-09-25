import { generationValue, resolveDirectBinding, resolveDedupeKey, requestIdFor, canonicalAddress, resolveAgentAddress, verifyAgentDestination, partMeta } from './direct-post/delivery-identity';
import { readTextFile, prepareFileSource } from './direct-post/source';
import { hash, requiredString, inReplyToValue, errorMessage } from './direct-post/request-values';
import {
  AGENT_ROUTING_VERSION,
  assertLegacyParentSourcedIdentity,
  isLegacyRetryableOutcome,
  isAgentSourcePromotion,
  legacyParentSourcedReceipt,
  resolveAgentReplyRequest,
  type LegacyParentSourcedReceipt
} from './state/agent-routing';

type AgentAddress = import('./agent-message').AgentAddress;
type LegacyAgentAddressEnvelope = import('./agent-message').LegacyAgentAddressEnvelope;
type AgentMessage = import('./agent-message').AgentMessage;
type AgentMessageKind = import('./agent-message').AgentMessageKind;
type AgentProvider = import('./agent-message').AgentProvider;
type AgentPresentation = import('./agent-presentation').AgentPresentation;
type DirectPostFileManifest = import('./direct-post-file').DirectPostFileManifest;
type WatcherNotice = import('./watcher-notice').WatcherNotice;
type WatcherAddress = import('./watcher-notice').WatcherAddress;

import { DIRECT_POST_OUTCOMES } from './direct-post/contracts';
import type {
  DirectPostOutcome,
  DirectPostBinding,
  DirectPostState,
  DirectPostSource,
  DirectPostPartResult,
  DirectPostResult,
  FetchImplementation,
  DirectPostInput,
  DiscordMessage
} from './direct-post/contracts';

export { DIRECT_POST_OUTCOMES, DIRECT_POST_PART_STATUSES } from './direct-post/contracts';
export type {
  DirectPostOutcome,
  DirectPostPartStatus,
  DirectPostBinding,
  DirectPostReceiptRow,
  DirectPostReceiptDetail,
  DirectPostState,
  DirectPostSource,
  DirectPostPartResult,
  DirectPostResult,
  FetchSuccessResponse,
  FetchFailureResponse,
  FetchResponse,
  FetchOptions,
  FetchImplementation,
  DirectPostInput
} from './direct-post/contracts';

const { encodeAgentMessage, isLegacyAgentAddressEnvelope, sameAddress, verifyAgentAddress, verifyLegacyAgentAddress, KINDS } = require('../src/agent-message') as {
  encodeAgentMessage: (packet: AgentMessage, token: string) => string;
  isLegacyAgentAddressEnvelope: (value: unknown) => value is LegacyAgentAddressEnvelope;
  sameAddress: (left: unknown, right: unknown) => boolean;
  verifyAgentAddress: (envelope: unknown, token: string) => AgentAddress;
  verifyLegacyAgentAddress: (envelope: unknown, token: string) => AgentAddress;
  KINDS: Readonly<{ REQUEST: 'request'; RESULT: 'result' }>;
};
const { createWatcherNotice, encodeWatcherNotice, sameWatcherAddress, WATCHER_NOTICE_PROVIDERS } = require('../src/watcher-notice') as {
  createWatcherNotice: (input: { armKey: string; triggerKey: string; source: WatcherAddress; target: WatcherAddress; text: string }) => WatcherNotice;
  encodeWatcherNotice: (packet: WatcherNotice, token: string) => string;
  sameWatcherAddress: (left: unknown, right: unknown) => boolean;
  WATCHER_NOTICE_PROVIDERS: Readonly<{ CLAUDE: 'claude' }>;
};
const { AGENT_PRESENTATIONS, agentMessagePreview } = require('../src/agent-presentation') as {
  AGENT_PRESENTATIONS: Readonly<{ LEGACY: 'legacy'; ATTACHMENT: 'attachment-v1' }>;
  agentMessagePreview: (packet: AgentMessage) => string;
};
const { DirectPostFileSnapshotError, readDirectPostFileSnapshot } = require('../src/direct-post-file') as {
  DirectPostFileSnapshotError: new (message: string, options?: { cause?: unknown }) => Error;
  readDirectPostFileSnapshot: (manifest: DirectPostFileManifest) => Buffer;
};
const path = require('node:path') as typeof import('node:path');
const {
  BindingError,
  StaleGenerationError,
} = require('../src/state') as {
  BindingError: new (message?: string) => Error;
  StaleGenerationError: new (message?: string) => Error;
};
const { sendDiscordMessage } = require('../src/discord') as {
  sendDiscordMessage: (options: {
    token: string;
    channelId: string;
    content: string;
    nonce: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetchImpl?: FetchImplementation;
    messageReference?: {
      message_id: string;
      channel_id: string;
      fail_if_not_exists: boolean;
    } | null;
    agentAttachment?: Buffer | null;
    fileAttachment?: { bytes: Buffer; filename: string } | null;
  }) => Promise<DiscordMessage>;
};

function outcomeFor(error: unknown): DirectPostOutcome {
  const outcome = (error as { outcome?: unknown } | null | undefined)?.outcome;
  return typeof outcome === 'string' && Object.values(DIRECT_POST_OUTCOMES).includes(outcome as DirectPostOutcome)
    ? outcome as DirectPostOutcome
    : 'unknown';
}

function errorStatus(error: unknown): unknown {
  return (error as { status?: unknown }).status;
}

async function runDirectPost(input: DirectPostInput): Promise<DirectPostResult> {
  let { state, token, nativeId, generation, channelId = null, provider = null, textFile,
    agentThreadId = null, agentMode = false,
    dedupeKey, requestId: legacyRequestId, inReplyTo, signal, fetchImpl, timeoutMs, ordinary = false,
    agentTarget = null, agentKind = KINDS.REQUEST, agentReplyTo = null,
    agentPresentation = AGENT_PRESENTATIONS.LEGACY, attachmentFile, resume = false, stateDir, watcherNotice = null,
    agentDestinationCurrent = null } =
    input as DirectPostInput & { agentThreadId?: string | null };
  const binding = watcherNotice
    ? watcherNotice.binding
    : resolveDirectBinding(state, { nativeId, generation: generationValue(generation), channelId, provider, ordinary });
  if (watcherNotice) {
    if (provider !== null && provider !== WATCHER_NOTICE_PROVIDERS.CLAUDE) throw new BindingError('watcher notice provider is fixed to Claude');
    if (nativeId !== binding.nativeId || Number(generation) !== binding.generation ||
        !sameWatcherAddress(watcherNotice.packet.source, canonicalAddress(binding))) {
      throw new BindingError('watcher notice does not match its frozen arm');
    }
    if (typeof state.authorizeWatcherNoticeSend !== 'function') throw new BindingError('watcher notice custody is unavailable');
    state.authorizeWatcherNoticeSend(watcherNotice.packet);
  }
  const operatorId = state.requireConfig().operatorId;
  const replyTarget = inReplyToValue(inReplyTo);
  const isAgentMessage = agentMode || watcherNotice !== null || agentThreadId !== null || agentTarget !== null || agentKind === KINDS.RESULT;
  const fileRequested = attachmentFile !== undefined || resume;
  if (!Object.values(AGENT_PRESENTATIONS).includes(agentPresentation)) {
    throw new BindingError(`unsupported agent presentation: ${agentPresentation}`);
  }
  if (fileRequested && isAgentMessage) throw new BindingError('local file posts are only supported for ordinary direct posts');
  if (!isAgentMessage && agentPresentation !== AGENT_PRESENTATIONS.LEGACY) {
    throw new BindingError('attachment presentation is only supported for agent messages');
  }
  const requestedRequestId = watcherNotice
    ? resolveDedupeKey({ dedupeKey, requestId: legacyRequestId }, { required: false })
    : resolveDedupeKey({ dedupeKey, requestId: legacyRequestId }, { required: isAgentMessage });
  const explicitRequestId = watcherNotice ? requestedRequestId || watcherNotice.packet.id : requestedRequestId;
  if (watcherNotice && explicitRequestId !== watcherNotice.packet.id) {
    throw new BindingError('watcher notice dedupe key must match its frozen identity');
  }
  if (fileRequested && explicitRequestId === undefined) throw new BindingError('file posts require an explicit dedupe-key');
  let legacy: LegacyParentSourcedReceipt | null = null;
  if (!watcherNotice && isAgentMessage && explicitRequestId !== undefined) {
    state.recoverDirectPostReceipts();
    const allowLegacyChildRoute = isLegacyAgentAddressEnvelope(agentTarget) || agentThreadId !== null ||
      (agentKind === KINDS.RESULT && agentReplyTo !== null);
    legacy = legacyParentSourcedReceipt(state, binding, explicitRequestId, Object.values(DIRECT_POST_OUTCOMES),
      allowLegacyChildRoute);
  }
  let source: DirectPostSource;
  try {
    source = fileRequested
      ? prepareFileSource({ state, requestId: explicitRequestId as string, textFile, attachmentFile, resume, stateDir,
        binding, operatorId, inReplyTo })
      : readTextFile(textFile);
  } catch (error) {
    const legacySourcePath = legacy?.attempt.sourcePath;
    const requestedSourcePath = typeof textFile === 'string' ? path.resolve(textFile) : null;
    if (!legacy || fileRequested || requestedSourcePath === null || legacySourcePath !== requestedSourcePath ||
        typeof legacy.packet.text !== 'string' || !errorMessage(error).startsWith('text file is unavailable')) throw error;
    source = { sourcePath: requestedSourcePath, text: legacy.packet.text, textHash: hash(legacy.packet.text), parts: [legacy.packet.text] };
  }
  const effectiveReplyTarget = source.filePreparation?.inReplyTo ?? replyTarget;
  let deliveryTarget: AgentAddress | null = null;
  let agentPacket: AgentMessage | null = null;
  let agentRequestTarget: AgentAddress | null = null;
  let legacyPacket: AgentMessage | null = null;
  const legacyChildAddress = legacy && !sameAddress(legacy.packet.source, canonicalAddress(binding))
    ? legacy.packet.source
    : null;
  if (legacy) {
    if (legacyChildAddress !== null && agentThreadId !== null && agentThreadId !== legacyChildAddress.channelId) {
      throw new BindingError('direct post request identity conflicts with existing custody');
    }
    assertLegacyParentSourcedIdentity({ state, binding, token, requestId: explicitRequestId as string, packet: legacy.packet, sourceText: source.text,
      agentKind, agentTarget, agentReplyTo, sourceAddress: legacy.packet.source,
      allowRecordedTarget: legacyChildAddress !== null,
      verifyLegacyProof: isLegacyRetryableOutcome(legacy.outcome), BindingError });
    if (legacy.outcome === DIRECT_POST_OUTCOMES.SENT || legacy.outcome === DIRECT_POST_OUTCOMES.UNKNOWN) {
      const legacyMarker = legacy.detail.legacyAgentPacket;
      const migratedPacket = legacy.detail.agentPacket;
      if (!legacyMarker || typeof legacyMarker !== 'object' || Array.isArray(legacyMarker) ||
          !migratedPacket || typeof migratedPacket !== 'object' || Array.isArray(migratedPacket)) return legacy.result;
      if (!isAgentSourcePromotion(legacy.packet, migratedPacket, binding.channelId) ||
          (agentThreadId !== null && agentThreadId !== (migratedPacket as AgentMessage).source.channelId)) {
        throw new BindingError('direct post request identity conflicts with existing custody');
      }
      return legacy.result;
    }
    if (!isLegacyRetryableOutcome(legacy.outcome)) {
      throw new BindingError('direct post legacy custody has an unsupported retry outcome');
    }
    legacyPacket = legacy.packet;
  }

  let address = canonicalAddress(binding);
  if (!watcherNotice && isAgentMessage) {
    const resolvedAddress = resolveAgentAddress(state, binding, agentThreadId);
    if (legacyChildAddress !== null && !sameAddress(resolvedAddress, legacyChildAddress)) {
      throw new BindingError('direct post request identity conflicts with existing custody');
    }
    address = resolvedAddress;
  }
  if (legacyPacket?.kind === KINDS.REQUEST) verifyAgentAddress(agentTarget, token);
  if (watcherNotice) {
    if (agentThreadId !== null || agentTarget !== null || agentKind === KINDS.RESULT || agentReplyTo !== null) {
      throw new BindingError('watcher notices do not accept agent message options');
    }
    deliveryTarget = watcherNotice.packet.target as unknown as AgentAddress;
    if (source.text !== watcherNotice.packet.text) throw new BindingError('watcher notice content changed while reading custody');
    if (typeof state.recordWatcherNoticeTrigger !== 'function') throw new BindingError('watcher notice trigger custody is unavailable');
    state.recordWatcherNoticeTrigger(watcherNotice.packet);
    const wire = encodeWatcherNotice(watcherNotice.packet, token);
    source = {
      ...source,
      textHash: hash(JSON.stringify(watcherNotice.packet)),
      parts: [wire],
      displayParts: [wire]
    };
  } else if (isAgentMessage && legacyPacket !== null) {
    deliveryTarget = legacyPacket.target;
    agentTarget = deliveryTarget;
    agentReplyTo = legacyPacket.replyTo;
    agentPacket = legacyPacket.kind === KINDS.RESULT
      ? { ...legacyPacket, source: address, routingVersion: AGENT_ROUTING_VERSION, sourceParentChannelId: binding.channelId }
      : { ...legacyPacket, source: address };
    if (legacyPacket.kind === KINDS.RESULT) {
      const request = resolveAgentReplyRequest(state, legacyPacket.replyTo, legacyPacket.source, legacyPacket.target, null, BindingError);
      agentRequestTarget = sameAddress(request.target, address) ? null : request.target;
    }
    const wire = encodeAgentMessage(agentPacket, token);
    const unchangedLegacyChild = legacyChildAddress !== null && sameAddress(legacyPacket.source, address);
    const legacyTextHash = unchangedLegacyChild && typeof legacy?.attempt.textHash === 'string'
      ? legacy.attempt.textHash
      : null;
    source = {
      ...source,
      textHash: legacyTextHash ?? hash(agentPacket),
      parts: [wire],
      displayParts: [agentPresentation === AGENT_PRESENTATIONS.ATTACHMENT ? agentMessagePreview(agentPacket) : wire]
    };
  } else if (isAgentMessage) {
    if (replyTarget !== null) throw new BindingError('agent messages use agent reply correlation, not Discord reply targets');
    if (agentKind === KINDS.RESULT) {
      const replyTo = requiredString(agentReplyTo, 'agent-reply-to', 128);
      const hasProof = agentTarget !== null && typeof agentTarget === 'object' && Object.hasOwn(agentTarget, 'proof');
      const legacyTargetEnvelope = agentTarget !== null && isLegacyAgentAddressEnvelope(agentTarget) ? agentTarget : null;
      let resolvedTarget = agentTarget as AgentAddress | null;
      if (legacyTargetEnvelope !== null) resolvedTarget = verifyLegacyAgentAddress(legacyTargetEnvelope, token);
      else if (hasProof) resolvedTarget = verifyAgentAddress(agentTarget, token);
      const request = resolveAgentReplyRequest(state, replyTo, address,
        resolvedTarget, canonicalAddress(binding), BindingError, legacyTargetEnvelope !== null);
      agentTarget = resolvedTarget;
      agentRequestTarget = sameAddress(request.target, address) ? null : request.target;
      deliveryTarget = request.source;
      agentTarget = deliveryTarget;
      agentReplyTo = request.id;
    } else {
      deliveryTarget = verifyAgentAddress(agentTarget, token);
      agentTarget = deliveryTarget;
    }
    const packetTarget = deliveryTarget as AgentAddress;
    const packet = {
      id: explicitRequestId as string,
      kind: agentKind,
      source: address,
      target: packetTarget,
      replyTo: (agentReplyTo ?? null) as string | null,
      routingVersion: AGENT_ROUTING_VERSION,
      ...(agentKind === KINDS.RESULT ? { sourceParentChannelId: binding.channelId } : {}),
      text: source.text
    } as unknown as AgentMessage;
    agentPacket = packet;
    const wire = encodeAgentMessage(packet, token);
    source = {
      ...source,
      textHash: hash(JSON.stringify(packet)),
      parts: [wire],
      displayParts: [agentPresentation === AGENT_PRESENTATIONS.ATTACHMENT ? agentMessagePreview(packet) : wire]
    };
  }
  const legacyMigration = legacyChildAddress === null || legacyPacket?.kind === KINDS.RESULT ? legacyPacket : null;
  const requestId = requestIdFor(binding, operatorId, source.sourcePath, source.textHash, explicitRequestId, effectiveReplyTarget);
  state.recoverDirectPostReceipts();
  const parts: DirectPostPartResult[] = [];
  let claimedAny = false;
  let recorded = false;
  const currentBinding = () => {
    if (!watcherNotice) return state.directPostBindingCurrent(binding, operatorId, address.channelId);
    try {
      state.authorizeWatcherNoticeSend?.(watcherNotice.packet);
      return true;
    } catch {
      return false;
    }
  };
  const currentDestination = () => {
    if (deliveryTarget === null || typeof agentDestinationCurrent !== 'function') return true;
    try { return agentDestinationCurrent(deliveryTarget); }
    catch { return false; }
  };
  for (let partIndex = 0; partIndex < source.parts.length; partIndex += 1) {
    if (signal?.aborted) {
      parts.push({ index: partIndex, status: 'not_sent', messageId: null });
      break;
    }
    const meta = partMeta(binding, operatorId, requestId, effectiveReplyTarget, source.sourcePath, source.textHash, source.parts, partIndex, address, deliveryTarget, agentPresentation, agentPacket, source.fileManifest || null, watcherNotice?.packet || null,
      legacyMigration, agentRequestTarget,
      legacy === null && isAgentMessage ? AGENT_ROUTING_VERSION : null);
    if (deliveryTarget !== null) meta.deliveryChannelId = deliveryTarget.channelId;
    if (deliveryTarget !== null) {
      let existing;
      try { existing = state.inspectDirectPostPart(meta); }
      catch (error) {
        if (!(error instanceof StaleGenerationError)) throw error;
        parts.push({ index: partIndex, status: 'stale', messageId: null });
        break;
      }
      if (existing) {
        parts.push({ index: partIndex, status: existing.status, messageId: existing.outcome?.messageId || null });
        if (existing.status !== 'sent') break;
        continue;
      }
      try {
        await verifyAgentDestination({ token, agentTarget: deliveryTarget, fetchImpl, signal, timeoutMs });
      } catch (error) {
        if (!currentBinding() || !currentDestination()) {
          const stale = state.recordDirectPostPreflight(meta, 'stale', { reason: 'binding changed during destination lookup' });
          parts.push({ index: partIndex, status: stale.outcome, messageId: null });
          break;
        }
        const preflight = state.recordDirectPostPreflight(meta, outcomeFor(error), {
          status: errorStatus(error) || null, error: errorMessage(error).slice(0, 300)
        });
        parts.push({ index: partIndex, status: preflight.outcome, messageId: null });
        break;
      }
      if (!currentBinding() || !currentDestination()) {
        const stale = state.recordDirectPostPreflight(meta, 'stale', { reason: 'binding changed during destination lookup' });
        parts.push({ index: partIndex, status: stale.outcome, messageId: null });
        break;
      }
      if (signal?.aborted) {
        const stopped = state.recordDirectPostPreflight(meta, 'not_sent', { reason: 'direct post stopped before custody' });
        parts.push({ index: partIndex, status: stopped.outcome, messageId: null });
        break;
      }
    }
    let claim;
    try { claim = state.beginDirectPostPart(meta); }
    catch (error) {
      if (!(error instanceof StaleGenerationError)) throw error;
      if (deliveryTarget !== null) {
        const stale = state.recordDirectPostPreflight(meta, 'stale', { reason: 'binding changed before custody' });
        parts.push({ index: partIndex, status: stale.outcome, messageId: null });
      } else {
        parts.push({ index: partIndex, status: 'stale', messageId: null });
      }
      break;
    }
    if (!claim.claimed) {
      parts.push({ index: partIndex, status: claim.status, messageId: claim.outcome?.messageId || null });
      if (claim.status !== 'sent') break;
      continue;
    }
    claimedAny = true;
    if (!currentBinding() || !currentDestination()) {
      const stale = state.recordDirectPostOutcome(requestId, claim.attemptId, 'stale', { reason: 'binding changed before network' });
      parts.push({ index: partIndex, status: stale.outcome });
      break;
    }
    try {
      if (!currentBinding() || !currentDestination()) {
        const stale = state.recordDirectPostOutcome(requestId, claim.attemptId, 'stale', { reason: 'binding changed before send' });
        parts.push({ index: partIndex, status: stale.outcome });
        break;
      }
      const sent = await sendDiscordMessage({ token, channelId: deliveryTarget?.channelId || binding.channelId,
        content: source.displayParts?.[partIndex] ?? source.parts[partIndex],
        agentAttachment: isAgentMessage && agentPresentation === AGENT_PRESENTATIONS.ATTACHMENT
          ? Buffer.from(source.parts[partIndex], 'utf8')
          : null,
        fileAttachment: source.fileManifest ? { bytes: readDirectPostFileSnapshot(source.fileManifest), filename: source.fileManifest.filename } : null,
        nonce: claim.nonce,
        messageReference: effectiveReplyTarget === null ? null : { message_id: effectiveReplyTarget, channel_id: binding.channelId, fail_if_not_exists: true },
        signal, fetchImpl, timeoutMs });
      const outcome = state.recordDirectPostOutcome(requestId, claim.attemptId, 'sent', { messageId: String(sent.id), status: 200 });
      parts.push({ index: partIndex, status: outcome.outcome, messageId: outcome.messageId });
      recorded = true;
    } catch (error) {
      const outcome = source.fileManifest && error instanceof DirectPostFileSnapshotError ? 'not_sent' : outcomeFor(error);
      const recorded = state.recordDirectPostOutcome(requestId, claim.attemptId, outcome, { status: errorStatus(error) || null, error: errorMessage(error).slice(0, 300) });
      parts.push({ index: partIndex, status: recorded.outcome, messageId: recorded.messageId || null });
      break;
    }
  }
  const status = parts.every(part => part.status === 'sent') ? 'sent' : parts.find(part => part.status !== 'sent')?.status || 'not_sent';
  const duplicate = !claimedAny && parts.length > 0 && parts.every(part => part.status === 'sent');
  return { requestId, dedupeKey: requestId, inReplyTo: effectiveReplyTarget, channelId: deliveryTarget?.channelId || binding.channelId, provider: binding.provider,
    nativeId: binding.nativeId, generation: binding.generation, status, state: status, recorded, duplicate,
    ...(source.fileManifest ? { filePreparationId: source.fileManifest.preparationId } : {}),
    messageIds: parts.filter((part): part is DirectPostPartResult & { messageId: string } => typeof part.messageId === 'string')
      .map(part => part.messageId), parts };
}

export async function runWatcherNoticePost({ state, token, armKey, triggerKey, textFile, signal, fetchImpl, timeoutMs, stateDir }: {
  state: DirectPostState;
  token: string;
  armKey: string;
  triggerKey: string;
  textFile: unknown;
  signal?: AbortSignal;
  fetchImpl?: FetchImplementation;
  timeoutMs?: number;
  stateDir?: string;
}): Promise<DirectPostResult> {
  if (typeof state.getWatcherNoticeArm !== 'function') throw new BindingError('watcher notice arm custody is unavailable');
  const arm = state.getWatcherNoticeArm(armKey);
  if (!arm) throw new BindingError('watcher notice arm is unknown');
  const source = readTextFile(textFile);
  const packet = createWatcherNotice({ armKey, triggerKey, source: arm.source, target: arm.target, text: source.text });
  const binding: DirectPostBinding = {
    active: true,
    guildId: arm.source.guildId,
    channelId: arm.source.channelId,
    provider: arm.provider,
    nativeId: arm.source.nativeId,
    generation: arm.generation,
    conductorId: arm.conductorId,
    repoKey: arm.repoKey
  };
  return runDirectPost({
    state,
    token,
    nativeId: arm.source.nativeId,
    generation: arm.generation,
    channelId: arm.source.channelId,
    provider: arm.provider,
    textFile,
    dedupeKey: packet.id,
    signal,
    fetchImpl,
    timeoutMs,
    stateDir,
    watcherNotice: { packet, binding }
  });
}

export { readTextFile, resolveAgentAddress, resolveDedupeKey, resolveDirectBinding, requestIdFor, runDirectPost };
