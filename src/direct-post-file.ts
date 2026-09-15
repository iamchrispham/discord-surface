import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentProvider } from './agent-message';

export const DIRECT_POST_FILE_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxReservations: 8,
  contentType: 'application/octet-stream'
});

export const DIRECT_POST_FILE_PHASES = Object.freeze({
  PREPARING: 'preparing',
  ADMITTED: 'admitted',
  RELEASED: 'released'
} as const);

export type DirectPostFilePhase = typeof DIRECT_POST_FILE_PHASES[keyof typeof DIRECT_POST_FILE_PHASES];

export interface DirectPostFileManifest {
  preparationId: string;
  sourcePath: string;
  stagedPath: string;
  filename: string;
  size: number;
  sha256: string;
  caption: string;
  captionHash: string;
}

export interface DirectPostFilePreparation extends DirectPostFileManifest {
  requestId: string;
  custodyRoot: string;
  phase: DirectPostFilePhase;
  channelId: string;
  guildId: string;
  provider: AgentProvider;
  nativeId: string;
  generation: number;
  operatorId: string;
  inReplyTo: string | null;
  conductorId?: string | null;
  repoKey?: string | null;
  ownerPid: number;
  ownerStartTime: string | null;
  ownerCommand: string | null;
}

export class DirectPostFileSnapshotError extends Error {
  readonly outcome = 'not_sent' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DirectPostFileSnapshotError';
  }
}

function preparationPath(stateDir: string, preparationId: string): string {
  if (!/^[0-9a-f-]{16,80}$/i.test(preparationId)) throw new Error('direct post preparation id is invalid');
  return path.join(path.resolve(stateDir), '.direct-post-files', `${preparationId}.bin`);
}

function assertPrivateStagedPath(stateDir: string, preparationId: string, stagedPath: string): string {
  const expected = preparationPath(stateDir, preparationId);
  if (path.resolve(stagedPath) !== expected) throw new Error('direct post staged path is outside the private custody directory');
  return expected;
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function inspectDirectPostFile(sourcePath: unknown): { sourcePath: string; filename: string; size: number } {
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || /[\u0000\u0001-\u001f\u007f]/.test(sourcePath)) {
    throw new Error('attachment-file must be a non-empty path');
  }
  const resolved = path.resolve(sourcePath);
  let stat: fs.Stats;
  try { stat = fs.statSync(resolved); }
  catch (error) { throw new Error(`attachment file is unavailable: ${(error as Error).message}`); }
  if (!stat.isFile()) throw new Error('attachment file must be a regular file');
  if (stat.size > DIRECT_POST_FILE_LIMITS.maxBytes) throw new Error('attachment file exceeds the 20 MiB limit');
  return { sourcePath: resolved, filename: path.basename(resolved), size: stat.size };
}

export function stagedDirectPostFilePath(stateDir: string, preparationId: string): string {
  return preparationPath(stateDir, preparationId);
}

export function stageDirectPostFile({ sourcePath, stateDir, preparationId, caption, captionHash }:
  { sourcePath: unknown; stateDir: string; preparationId: string; caption: string; captionHash: string }): DirectPostFileManifest {
  const inspected = inspectDirectPostFile(sourcePath);
  const stagedPath = preparationPath(stateDir, preparationId);
  const spool = path.dirname(stagedPath);
  fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(spool, 0o700); } catch {}
  const partialPath = `${stagedPath}.partial`;
  let sourceFd: number | null = null;
  let partialFd: number | null = null;
  let copied = 0;
  const digest = crypto.createHash('sha256');
  try { syncDirectory(path.dirname(spool)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    sourceFd = fs.openSync(inspected.sourcePath, 'r');
    partialFd = fs.openSync(partialPath, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (copied < inspected.size) {
      const count = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, inspected.size - copied), copied);
      if (count === 0) throw new Error('attachment file changed while it was being copied');
      digest.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) written += fs.writeSync(partialFd as number, buffer, written, count - written);
      copied += count;
    }
    const finalSize = fs.fstatSync(sourceFd).size;
    if (finalSize !== inspected.size || copied !== inspected.size) throw new Error('attachment file changed while it was being copied');
    fs.fsyncSync(partialFd);
    fs.closeSync(partialFd); partialFd = null;
    fs.closeSync(sourceFd); sourceFd = null;
    fs.renameSync(partialPath, stagedPath);
    try { fs.chmodSync(stagedPath, 0o600); } catch {}
    syncDirectory(spool);
    return { preparationId, sourcePath: inspected.sourcePath, stagedPath, filename: inspected.filename,
      size: copied, sha256: digest.digest('hex'), caption, captionHash };
  } catch (error) {
    if (partialFd !== null) try { fs.closeSync(partialFd); } catch {}
    if (sourceFd !== null) try { fs.closeSync(sourceFd); } catch {}
    throw error;
  }
}

export function readDirectPostFileSnapshot(manifest: DirectPostFileManifest): Buffer {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(manifest.stagedPath); }
  catch (error) {
    throw new DirectPostFileSnapshotError('direct post staged file is unavailable', { cause: error });
  }
  if (bytes.length !== manifest.size || crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) {
    throw new DirectPostFileSnapshotError('direct post staged file does not match its admitted manifest');
  }
  return bytes;
}

export function hashDirectPostFile(sourcePath: unknown): { sourcePath: string; filename: string; size: number; sha256: string } {
  const inspected = inspectDirectPostFile(sourcePath);
  const bytes = fs.readFileSync(inspected.sourcePath);
  return { ...inspected, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

export function removeDirectPostFile({ stateDir, preparationId, stagedPath }:
  { stateDir: string; preparationId: string; stagedPath: string }): void {
  const expected = assertPrivateStagedPath(stateDir, preparationId, stagedPath);
  let found = false;
  for (const candidate of [expected, `${expected}.partial`]) {
    try { fs.unlinkSync(candidate); found = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  try { syncDirectory(path.dirname(expected)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
