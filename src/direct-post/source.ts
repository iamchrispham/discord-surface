import type { DirectPostBinding, DirectPostState, DirectPostSource } from './contracts';
import type { DirectPostFileManifest, DirectPostFilePreparation } from '../direct-post-file';
import { hash, requiredString, inReplyToValue, errorMessage } from './request-values';
const crypto = require('node:crypto') as typeof import('node:crypto');
const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');
const { BindingError, splitReply } = require('../../src/state') as {
  BindingError: new (message?: string) => Error;
  splitReply: (text: string) => string[];
};
const {
  DIRECT_POST_FILE_PHASES,
  hashDirectPostFile,
  inspectDirectPostFile,
  stageDirectPostFile,
  stagedDirectPostFilePath
} = require('../../src/direct-post-file') as {
  DIRECT_POST_FILE_PHASES: Readonly<{ PREPARING: 'preparing'; ADMITTED: 'admitted'; RELEASED: 'released' }>;
  hashDirectPostFile: (sourcePath: unknown) => { sourcePath: string; filename: string; size: number; sha256: string };
  inspectDirectPostFile: (sourcePath: unknown) => { sourcePath: string; filename: string; size: number };
  stageDirectPostFile: (input: { sourcePath: unknown; stateDir: string; preparationId: string; caption: string; captionHash: string }) => DirectPostFileManifest;
  stagedDirectPostFilePath: (stateDir: string, preparationId: string) => string;
};

export function readTextFile(textFile: unknown): DirectPostSource {
  const sourcePath = path.resolve(requiredString(textFile, 'text-file'));
  let stat;
  try { stat = fs.statSync(sourcePath); }
  catch (error) { throw new BindingError(`text file is unavailable: ${(error as { message?: unknown }).message}`); }
  if (!stat.isFile()) throw new BindingError('text file must be a regular file');
  if (stat.size > 40000) throw new BindingError('text file exceeds the 10000 character input limit');
  let text;
  try { text = fs.readFileSync(sourcePath, 'utf8'); }
  catch (error) { throw new BindingError(`text file is unreadable: ${(error as { message?: unknown }).message}`); }
  if (!text.length || !text.trim()) throw new BindingError('text file must contain non-empty text');
  if (text.length > 10000) throw new BindingError('text file must be at most 10000 characters');
  const parts = splitReply(text);
  if (parts.some(part => !part.trim())) throw new BindingError('text file would produce a blank Discord message; remove excess whitespace');
  if (parts.some(part => part.length > 2000)) throw new BindingError('direct post part exceeds Discord 2000 character limit');
  return { sourcePath, text, textHash: hash(text), parts };
}

function directPostStateDir(state: DirectPostState, requested: string | undefined): string {
  if (requested !== undefined) return path.resolve(requiredString(requested, 'state-dir'));
  const dbPath = (state as unknown as { dbPath?: unknown }).dbPath;
  return typeof dbPath === 'string' ? path.dirname(dbPath) : process.cwd();
}

function assertFilePreparationAuthority(existing: DirectPostFilePreparation, binding: DirectPostBinding, operatorId: string,
  inReplyTo: unknown, resume = false): void {
  if (resume && inReplyTo !== undefined) throw new BindingError('direct post resume does not accept a replacement reply reference');
  const effectiveReplyTarget = inReplyTo === undefined ? existing.inReplyTo : inReplyToValue(inReplyTo);
  if (effectiveReplyTarget !== existing.inReplyTo) throw new BindingError('direct post file request cannot override immutable inReplyTo');
  for (const [key, expected, actual] of [
    ['channelId', existing.channelId, binding.channelId],
    ['guildId', existing.guildId, binding.guildId],
    ['provider', existing.provider, binding.provider],
    ['nativeId', existing.nativeId, binding.nativeId],
    ['generation', existing.generation, binding.generation],
    ['operatorId', existing.operatorId, operatorId],
    ['conductorId', existing.conductorId ?? null, binding.conductorId ?? null],
    ['repoKey', existing.repoKey ?? null, binding.repoKey ?? null]
  ] as const) {
    if (expected !== actual) throw new BindingError(`direct post resume cannot override immutable ${key}`);
  }
}

export function prepareFileSource({ state, requestId, textFile, attachmentFile, resume, stateDir, binding, operatorId, inReplyTo }:
  { state: DirectPostState; requestId: string; textFile: unknown; attachmentFile: unknown; resume: boolean; stateDir?: string;
    binding: DirectPostBinding; operatorId: string; inReplyTo: unknown }): DirectPostSource {
  if (!state.directPostFilePreparation || !state.beginDirectPostFilePreparation || !state.admitDirectPostFilePreparation) {
    throw new BindingError('direct post file custody is unavailable');
  }
  const existing = state.directPostFilePreparation(requestId);
  if (resume) {
    if (attachmentFile !== undefined || textFile !== undefined) throw new BindingError('direct post resume does not accept replacement files');
    if (!existing || existing.phase !== DIRECT_POST_FILE_PHASES.ADMITTED) throw new BindingError('direct post resume requires an admitted file preparation');
    assertFilePreparationAuthority(existing, binding, operatorId, inReplyTo, true);
    return { sourcePath: existing.sourcePath, text: existing.caption, textHash: existing.captionHash,
      parts: [existing.caption], fileManifest: existing, filePreparation: existing };
  }
  if (attachmentFile === undefined) throw new BindingError('attachment-file is required for a file post');
  const captionSource = readTextFile(textFile);
  if (captionSource.parts.length !== 1) throw new BindingError('file posts require one Discord message caption');
  let inspected;
  try { inspected = inspectDirectPostFile(attachmentFile); }
  catch (error) { throw new BindingError(errorMessage(error)); }
  const captionHash = captionSource.textHash;
  if (existing && existing.phase === DIRECT_POST_FILE_PHASES.ADMITTED) {
    assertFilePreparationAuthority(existing, binding, operatorId, inReplyTo);
    let descriptor;
    try { descriptor = hashDirectPostFile(attachmentFile); }
    catch (error) { throw new BindingError(errorMessage(error)); }
    if (descriptor.filename !== existing.filename || descriptor.size !== existing.size || descriptor.sha256 !== existing.sha256 || captionHash !== existing.captionHash) {
      throw new BindingError('direct post file request identity conflicts with its admitted custody');
    }
    return { sourcePath: existing.sourcePath, text: existing.caption, textHash: existing.captionHash,
      parts: [existing.caption], fileManifest: existing, filePreparation: existing };
  }
  if (existing && existing.phase === DIRECT_POST_FILE_PHASES.PREPARING) throw new BindingError('direct post file preparation is already in progress');
  const preparationId = crypto.randomUUID();
  const root = directPostStateDir(state, stateDir);
  const ownerIdentity = state.directPostOwnerIdentity(process.pid);
  if (!ownerIdentity) throw new BindingError('direct post file preparation owner identity is unavailable');
  const seed = {
    preparationId,
    requestId,
    custodyRoot: root,
    sourcePath: inspected.sourcePath,
    stagedPath: stagedDirectPostFilePath(root, preparationId),
    filename: inspected.filename,
    size: inspected.size,
    caption: captionSource.text,
    captionHash,
    channelId: binding.channelId,
    guildId: binding.guildId,
    provider: binding.provider,
    nativeId: binding.nativeId,
    generation: binding.generation,
    operatorId,
    inReplyTo: inReplyToValue(inReplyTo),
    ...(binding.conductorId ? { conductorId: binding.conductorId } : {}),
    ...(binding.repoKey ? { repoKey: binding.repoKey } : {}),
    ...ownerIdentity
  };
  const admittedSeed = state.beginDirectPostFilePreparation(seed);
  if (admittedSeed.phase === DIRECT_POST_FILE_PHASES.ADMITTED) {
    return { sourcePath: admittedSeed.sourcePath, text: admittedSeed.caption, textHash: admittedSeed.captionHash,
      parts: [admittedSeed.caption], fileManifest: admittedSeed, filePreparation: admittedSeed };
  }
  if (admittedSeed.phase !== DIRECT_POST_FILE_PHASES.PREPARING) throw new BindingError('direct post file preparation is unavailable');
  let manifest;
  try { manifest = stageDirectPostFile({ sourcePath: attachmentFile, stateDir: root, preparationId, caption: captionSource.text, captionHash }); }
  catch (error) { throw new BindingError(`direct post file preparation ${preparationId} is not admitted: ${errorMessage(error)}`); }
  let admitted;
  try { admitted = state.admitDirectPostFilePreparation(preparationId, manifest); }
  catch (error) { throw new BindingError(`direct post file preparation ${preparationId} could not be admitted: ${errorMessage(error)}`); }
  return { sourcePath: admitted.sourcePath, text: admitted.caption, textHash: admitted.captionHash,
    parts: [admitted.caption], fileManifest: admitted, filePreparation: admitted };
}
