import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OwnerRecord, SocketIdentity } from './types';

type SocketIdentityRecord = {
  dev: string;
  ino: string;
  ctimeNs: string;
  birthtimeNs: string;
};

type QuarantineEntryType = 'socket' | 'file' | 'symlink';

type QuarantineManifest = {
  version: 1;
  endpoint: string;
  socket: SocketIdentityRecord;
  entryType?: QuarantineEntryType;
};

export type QuarantineDependencies = {
  ownerIdentity?: string;
  effectiveUserId: () => number | undefined;
  parseOwner: (ownerValue: string) => OwnerRecord;
  isOwnerAlive: (owner: OwnerRecord) => boolean;
  writeOwnerMarker: (ownerPath: string) => OwnerRecord;
  socketIdentity: (filePath: string) => SocketIdentity;
  sameSocket: (left: SocketIdentity, right: SocketIdentity) => boolean;
  sameQuarantinedSocket: (left: SocketIdentity, right: SocketIdentity) => boolean;
};

function staleQuarantinePrefix(deps: QuarantineDependencies): string {
  const identity = deps.ownerIdentity ? Buffer.from(deps.ownerIdentity).toString('base64url') : 'unknown';
  return `.stale-${process.pid}-${identity}-`;
}

export function removeSocketQuarantine(quarantineDirectory: string): void {
  fs.rmSync(quarantineDirectory, { recursive: true, force: true });
}

function serializeSocketIdentity(identity: SocketIdentity): SocketIdentityRecord {
  return {
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    ctimeNs: identity.ctimeNs.toString(),
    birthtimeNs: identity.birthtimeNs.toString()
  };
}

function deserializeSocketIdentity(value: unknown): SocketIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<SocketIdentityRecord>;
  if (typeof record.dev !== 'string' || typeof record.ino !== 'string' ||
    typeof record.ctimeNs !== 'string' || typeof record.birthtimeNs !== 'string') return undefined;
  try {
    return {
      dev: BigInt(record.dev),
      ino: BigInt(record.ino),
      ctimeNs: BigInt(record.ctimeNs),
      birthtimeNs: BigInt(record.birthtimeNs)
    };
  } catch {
    return undefined;
  }
}

function isQuarantineEntryType(value: unknown): value is QuarantineEntryType {
  return value === 'socket' || value === 'file' || value === 'symlink';
}

function matchesQuarantineEntry(stats: fs.Stats, entryType: QuarantineEntryType): boolean {
  if (entryType === 'socket') return stats.isSocket() && !stats.isSymbolicLink();
  if (entryType === 'file') return stats.isFile() && !stats.isSymbolicLink();
  return stats.isSymbolicLink();
}

function isRegularFile(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function readQuarantine(
  quarantineDirectory: string,
  socketDirectory: string,
  deps: QuarantineDependencies
): { owner: OwnerRecord; manifest: QuarantineManifest; socketPath?: string } | undefined {
  const ownerPath = path.join(quarantineDirectory, 'owner');
  const manifestPath = path.join(quarantineDirectory, 'manifest');
  const socketPath = path.join(quarantineDirectory, 'socket');
  let quarantineStats: fs.Stats;
  let ownerStats: fs.Stats;
  let manifestStats: fs.Stats;
  try {
    quarantineStats = fs.lstatSync(quarantineDirectory);
    ownerStats = fs.lstatSync(ownerPath);
    manifestStats = fs.lstatSync(manifestPath);
  } catch {
    return undefined;
  }
  const ownerUid = deps.effectiveUserId();
  if (!quarantineStats.isDirectory() || quarantineStats.isSymbolicLink() ||
    (ownerUid !== undefined && quarantineStats.uid !== ownerUid) || (quarantineStats.mode & 0o077) !== 0 ||
    !ownerStats.isFile() || ownerStats.isSymbolicLink() || !manifestStats.isFile() || manifestStats.isSymbolicLink() ||
    (ownerUid !== undefined && (ownerStats.uid !== ownerUid || manifestStats.uid !== ownerUid)) ||
    (ownerStats.mode & 0o077) !== 0 || (manifestStats.mode & 0o077) !== 0) return undefined;
  if (!isRegularFile(ownerPath) || !isRegularFile(manifestPath)) return undefined;
  let owner: OwnerRecord;
  let manifest: QuarantineManifest;
  try {
    owner = deps.parseOwner(fs.readFileSync(ownerPath, 'utf8').trim());
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as QuarantineManifest;
  } catch {
    return undefined;
  }
  const entryType = manifest.entryType ?? 'socket';
  if (!owner.generation || manifest.version !== 1 || typeof manifest.endpoint !== 'string' ||
    path.basename(manifest.endpoint) !== manifest.endpoint || !manifest.endpoint ||
    !deserializeSocketIdentity(manifest.socket) || !isQuarantineEntryType(entryType) || !isRegularFile(ownerPath)) return undefined;
  const socketStats = (() => {
    try { return fs.lstatSync(socketPath); } catch { return undefined; }
  })();
  const expectedEntries = new Set(['owner', 'manifest', 'socket']);
  let entries: string[];
  try { entries = fs.readdirSync(quarantineDirectory); } catch { return undefined; }
  const preRenameEntries = new Set(['owner', 'manifest']);
  const hasMovedSocket = entries.length === expectedEntries.size && entries.every(entry => expectedEntries.has(entry));
  const hasNotMovedSocket = entries.length === preRenameEntries.size && entries.every(entry => preRenameEntries.has(entry));
  if (!hasMovedSocket && !hasNotMovedSocket) return undefined;
  if (hasNotMovedSocket) return { owner, manifest, socketPath: undefined };
  if (!socketStats || !matchesQuarantineEntry(socketStats, entryType)) return undefined;
  const socketIdentity = deserializeSocketIdentity(manifest.socket)!;
  if (!deps.sameQuarantinedSocket(deps.socketIdentity(socketPath), socketIdentity)) return undefined;
  const socketOwner = (socketStats as fs.Stats).uid;
  if (ownerUid !== undefined && socketOwner !== ownerUid) return undefined;
  if (path.dirname(socketPath) !== quarantineDirectory || path.dirname(path.join(socketDirectory, manifest.endpoint)) !== socketDirectory) {
    return undefined;
  }
  return { owner, manifest, socketPath };
}

export function restoreQuarantinedSocket(
  quarantinedPath: string,
  socketPath: string,
  entryType: QuarantineEntryType = 'socket'
): boolean {
  if (entryType === 'symlink') {
    let target: string;
    try { target = fs.readlinkSync(quarantinedPath); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      throw error;
    }
    try {
      fs.symlinkSync(target, socketPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'EXDEV') return false;
      throw error;
    }
    fs.unlinkSync(quarantinedPath);
    return true;
  }
  try {
    fs.linkSync(quarantinedPath, socketPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return false;
    }
    if (code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'EXDEV') return false;
    throw error;
  }
  fs.unlinkSync(quarantinedPath);
  return true;
}

function clearOrphanSocketQuarantines(
  socketDirectory: string,
  deps: QuarantineDependencies,
  endpoint?: string
): void {
  let entries: string[];
  try { entries = fs.readdirSync(socketDirectory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith('.stale-')) continue;
    const quarantineDirectory = path.join(socketDirectory, entry);
    let stats: fs.Stats;
    try { stats = fs.lstatSync(quarantineDirectory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
    const quarantine = readQuarantine(quarantineDirectory, socketDirectory, deps);
    if (!quarantine || deps.isOwnerAlive(quarantine.owner)) continue;
    if (endpoint !== undefined && quarantine.manifest.endpoint !== endpoint) continue;
    const socketPath = path.join(socketDirectory, quarantine.manifest.endpoint);
    let endpointExists = false;
    try {
      fs.lstatSync(socketPath);
      endpointExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!quarantine.socketPath) {
      if (!endpointExists) continue;
      let endpointIdentity: SocketIdentity;
      try { endpointIdentity = deps.socketIdentity(socketPath); } catch { continue; }
      if (!deps.sameSocket(endpointIdentity, deserializeSocketIdentity(quarantine.manifest.socket)!)) continue;
      removeSocketQuarantine(quarantineDirectory);
      continue;
    }
    if (endpointExists) continue;
    if (!restoreQuarantinedSocket(quarantine.socketPath, socketPath, quarantine.manifest.entryType ?? 'socket')) continue;
    removeSocketQuarantine(quarantineDirectory);
  }
}

function createSocketQuarantine(
  socketPath: string,
  expected: SocketIdentity,
  deps: QuarantineDependencies,
  entryType: QuarantineEntryType = 'socket'
): { directory: string; ownerPath: string } {
  const directory = fs.mkdtempSync(path.join(path.dirname(socketPath), staleQuarantinePrefix(deps)));
  const ownerPath = path.join(directory, 'owner');
  const manifestPath = path.join(directory, 'manifest');
  try {
    deps.writeOwnerMarker(ownerPath);
    const manifest: QuarantineManifest = {
      version: 1,
      endpoint: path.basename(socketPath),
      socket: serializeSocketIdentity(expected),
      entryType
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
    return { directory, ownerPath };
  } catch (error) {
    removeSocketQuarantine(directory);
    throw error;
  }
}

export function unlinkSocketIfOwned(
  socketPath: string,
  expected: SocketIdentity | null | undefined,
  deps: QuarantineDependencies
): void {
  clearOrphanSocketQuarantines(path.dirname(socketPath), deps, path.basename(socketPath));
  if (!expected) return;
  let observed: SocketIdentity;
  try { observed = deps.socketIdentity(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!deps.sameSocket(observed, expected)) return;
  let quarantineDirectory: string | undefined;
  let quarantineMoved = false;
  try {
    const quarantine = createSocketQuarantine(socketPath, expected, deps);
    quarantineDirectory = quarantine.directory;
    const quarantinedPath = path.join(quarantineDirectory, 'socket');
    fs.renameSync(socketPath, quarantinedPath);
    quarantineMoved = true;
    const quarantined = deps.socketIdentity(quarantinedPath);
    if (!deps.sameQuarantinedSocket(quarantined, expected)) {
      if (!restoreQuarantinedSocket(quarantinedPath, socketPath)) return;
      removeSocketQuarantine(quarantineDirectory);
      quarantineDirectory = undefined;
      return;
    }
    fs.unlinkSync(quarantinedPath);
    removeSocketQuarantine(quarantineDirectory);
    quarantineDirectory = undefined;
  } catch (error) {
    if (quarantineDirectory !== undefined && !quarantineMoved) {
      removeSocketQuarantine(quarantineDirectory);
      quarantineDirectory = undefined;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function prepareSocketQuarantine(
  socketPath: string,
  expected: SocketIdentity,
  deps: QuarantineDependencies,
  entryType: QuarantineEntryType = 'socket'
): { directory: string; ownerPath: string } {
  return createSocketQuarantine(socketPath, expected, deps, entryType);
}

export function clearSocketQuarantines(
  socketDirectory: string,
  deps: QuarantineDependencies,
  endpoint?: string
): void {
  clearOrphanSocketQuarantines(socketDirectory, deps, endpoint);
}
