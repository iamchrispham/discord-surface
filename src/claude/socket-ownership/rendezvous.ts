import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileGeneration } from './types';

export const SOCKET_ENDPOINT_MAX_LENGTH = 90;
export const LOCK_NAMESPACE = '.discord-surface-locks';
export const LOCK_NAMESPACE_SUFFIX = 'coordination';

export type RendezvousDependencies = {
  effectiveUserId: () => number | undefined;
  fileGeneration: (filePath: string) => FileGeneration;
  sameGeneration: (left: FileGeneration, right: FileGeneration) => boolean;
};

export function lockNamespaceCandidate(parentPath: string, prefix: string): string {
  const componentPrefix = `${prefix}-${LOCK_NAMESPACE_SUFFIX}`;
  const minimumComponentLength = SOCKET_ENDPOINT_MAX_LENGTH + 1 - parentPath.length - path.sep.length;
  const component = componentPrefix.length >= minimumComponentLength
    ? componentPrefix
    : `${componentPrefix}${'x'.repeat(minimumComponentLength - componentPrefix.length)}`;
  return path.join(parentPath, component);
}

export function assertLockNamespaceIsUsable(namespacePath: string, owner: number | undefined): void {
  const directory = fs.lstatSync(namespacePath);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
    (owner !== undefined && directory.uid !== owner)) {
    throw new Error('Claude channel socket lock namespace is unusable');
  }
}

function isOwnerControlledHome(directory: fs.Stats, owner: number | undefined): boolean {
  return directory.isDirectory() && !directory.isSymbolicLink() &&
    (owner === undefined || directory.uid === owner) &&
    (owner === undefined || (directory.mode & 0o200) !== 0) &&
    (directory.mode & 0o022) === 0;
}

function publishedFallbackRoot(root: string, owner: number | undefined): string | undefined {
  let directory: fs.Stats;
  try { directory = fs.statSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const stickySharedRoot = (directory.mode & 0o1000) !== 0 && (directory.mode & 0o002) !== 0;
  if (!directory.isDirectory() || !stickySharedRoot) return undefined;

  const ownerName = owner === undefined ? 'shared' : String(owner);
  const privateRootPrefix = `.claude-channel-${ownerName}-`;
  const rendezvousName = path.basename(lockNamespaceCandidate(root, `${LOCK_NAMESPACE}-${ownerName}`));
  const rendezvousPrefix = `${rendezvousName}-`;
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let publishedRoot: string | undefined;
  let publishedKind: 'direct' | 'fallback' | undefined;
  for (const entry of entries.filter(name => name === rendezvousName || name.startsWith(rendezvousPrefix)).sort()) {
    const rendezvousDirectory = path.join(root, entry);
    let rendezvousStats: fs.Stats;
    try { rendezvousStats = fs.lstatSync(rendezvousDirectory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const rendezvousOwnerControlled = owner === undefined || rendezvousStats.uid === owner;
    if (!rendezvousStats.isDirectory() || rendezvousStats.isSymbolicLink() || !rendezvousOwnerControlled ||
      (rendezvousStats.mode & 0o077) !== 0) continue;
    const directHomePath = path.join(rendezvousDirectory, 'direct-home');
    let directHomeMarker: fs.Stats | undefined;
    try { directHomeMarker = fs.lstatSync(directHomePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (directHomeMarker) {
      const directMarkerOwnerControlled = owner === undefined || directHomeMarker.uid === owner;
      if (!directHomeMarker.isFile() || directHomeMarker.isSymbolicLink() || !directMarkerOwnerControlled ||
        (directHomeMarker.mode & 0o077) !== 0) {
        throw new Error('Claude channel direct-home rendezvous is unusable');
      }
      const directHomeRoot = fs.readFileSync(directHomePath, 'utf8').trim();
      if (!path.isAbsolute(directHomeRoot)) throw new Error('Claude channel direct-home rendezvous is invalid');
      let directHomeStats: fs.Stats | undefined;
      try { directHomeStats = fs.lstatSync(directHomeRoot); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (directHomeStats) {
        if (!isOwnerControlledHome(directHomeStats, owner)) {
          throw new Error('Claude channel direct-home target is unusable');
        }
        if (publishedKind === 'fallback') continue;
        if (publishedRoot !== undefined && publishedRoot !== directHomeRoot) {
          throw new Error('Claude channel direct-home rendezvous is ambiguous');
        }
        publishedRoot = directHomeRoot;
        publishedKind = 'direct';
      }
    }
    const rendezvousPath = path.join(rendezvousDirectory, 'fallback-root');
    let marker: fs.Stats;
    try { marker = fs.lstatSync(rendezvousPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const markerOwnerControlled = owner === undefined || marker.uid === owner;
    if (!marker.isFile() || marker.isSymbolicLink() || !markerOwnerControlled || (marker.mode & 0o077) !== 0) {
      throw new Error('Claude channel fallback-root rendezvous is unusable');
    }
    const markerLines = fs.readFileSync(rendezvousPath, 'utf8').trim().split('\n');
    const target = markerLines[0];
    if (!target || path.basename(target) !== target || !target.startsWith(privateRootPrefix)) {
      throw new Error('Claude channel fallback-root rendezvous is invalid');
    }
    const privateRoot = path.join(root, target);
    let privateDirectory: fs.Stats;
    try { privateDirectory = fs.lstatSync(privateRoot); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const privateOwnerControlled = owner === undefined || privateDirectory.uid === owner;
    const privateOwnerWritable = owner === undefined || (privateDirectory.mode & 0o200) !== 0;
    if (privateDirectory.isDirectory() && !privateDirectory.isSymbolicLink() && privateOwnerControlled &&
      privateOwnerWritable && (privateDirectory.mode & 0o077) === 0) {
      if (publishedKind === 'fallback' && publishedRoot !== privateRoot) {
        throw new Error('Claude channel fallback-root rendezvous is ambiguous');
      }
      publishedRoot = privateRoot;
      publishedKind = 'fallback';
    }
  }
  return publishedRoot;
}

function fallbackRendezvousClaimed(root: string, owner: number | undefined): boolean {
  let directory: fs.Stats;
  try { directory = fs.statSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const stickySharedRoot = (directory.mode & 0o1000) !== 0 && (directory.mode & 0o002) !== 0;
  if (!directory.isDirectory() || !stickySharedRoot) return false;

  const ownerName = owner === undefined ? 'shared' : String(owner);
  const rendezvousName = path.basename(lockNamespaceCandidate(root, `${LOCK_NAMESPACE}-${ownerName}`));
  const rendezvousPrefix = `${rendezvousName}-`;
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries.filter(name => name === rendezvousName || name.startsWith(rendezvousPrefix))) {
    const rendezvousDirectory = path.join(root, entry);
    let rendezvousStats: fs.Stats;
    try { rendezvousStats = fs.lstatSync(rendezvousDirectory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const rendezvousOwnerControlled = owner === undefined || rendezvousStats.uid === owner;
    if (rendezvousStats.isDirectory() && !rendezvousStats.isSymbolicLink() && rendezvousOwnerControlled &&
      (rendezvousStats.mode & 0o077) === 0) return true;
  }
  return false;
}

function publishDirectHomeRendezvous(root: string, homeRoot: string, owner: number | undefined): boolean {
  let directory: fs.Stats;
  try { directory = fs.statSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const stickySharedRoot = (directory.mode & 0o1000) !== 0 && (directory.mode & 0o002) !== 0;
  if (!directory.isDirectory() || !stickySharedRoot) return false;

  const ownerName = owner === undefined ? 'shared' : String(owner);
  const rendezvousName = path.basename(lockNamespaceCandidate(root, `${LOCK_NAMESPACE}-${ownerName}`));
  const deterministicNames = [
    rendezvousName,
    `${rendezvousName}-shared`,
    `${rendezvousName}-election`
  ];
  const usable = (candidate: string): boolean => {
    try {
      const stats = fs.lstatSync(candidate);
      const ownerControlled = owner === undefined || stats.uid === owner;
      return stats.isDirectory() && !stats.isSymbolicLink() && ownerControlled && (stats.mode & 0o077) === 0;
    } catch {
      return false;
    }
  };

  for (const name of deterministicNames) {
    const candidate = path.join(root, name);
    if (!usable(candidate)) {
      try { fs.mkdirSync(candidate, { mode: 0o700 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    if (!usable(candidate)) continue;
    try { fs.lstatSync(path.join(candidate, 'fallback-root')); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return publishDirectHomeMarker(candidate, homeRoot);
    }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(root, `${rendezvousName}-direct-${randomUUID()}`);
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      return publishDirectHomeMarker(candidate, homeRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return false;
}

function publishDirectHomeMarker(rendezvousDirectory: string, homeRoot: string): boolean {
  const markerPath = path.join(rendezvousDirectory, 'direct-home');
  try {
    const marker = fs.readFileSync(markerPath, 'utf8').trim();
    if (marker !== homeRoot) throw new Error('Claude channel direct-home rendezvous is ambiguous');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const markerTemp = path.join(rendezvousDirectory, `.direct-home-${process.pid}-${randomUUID()}`);
  fs.writeFileSync(markerTemp, `${homeRoot}\n`, { mode: 0o600, flag: 'wx' });
  try {
    try {
      fs.linkSync(markerTemp, markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const winner = fs.readFileSync(markerPath, 'utf8').trim();
      if (winner !== homeRoot) throw new Error('Claude channel direct-home rendezvous is ambiguous');
    }
  } finally {
    try { fs.unlinkSync(markerTemp); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return true;
}

export function ownerControlledNamespaceRoot(deps: RendezvousDependencies): string {
  const owner = deps.effectiveUserId();
  const ownerName = owner === undefined ? 'shared' : String(owner);
  let homeIdentity: string | undefined;
  try { homeIdentity = path.resolve(os.userInfo().homedir); } catch {}
  const candidates: string[] = [];
  try {
    candidates.push(fs.realpathSync(os.userInfo().homedir));
  } catch {
    // Try the stable system temporary root below.
  }
  try { candidates.push(fs.realpathSync('/tmp')); } catch {
    // No stable system temporary root is available.
  }

  const fallbackClaimed = candidates.some(root => fallbackRendezvousClaimed(root, owner));
  for (const root of candidates) {
    const publishedRoot = publishedFallbackRoot(root, owner);
    if (publishedRoot) return publishedRoot;
  }

  for (const root of candidates) {
    let directory: fs.Stats;
    try { directory = fs.statSync(root); } catch { continue; }
    if (!directory.isDirectory()) continue;
    const fallbackClaimedNow = fallbackClaimed || candidates.some(candidate => fallbackRendezvousClaimed(candidate, owner));
    if (isOwnerControlledHome(directory, owner) && !fallbackClaimedNow) {
      try {
        fs.accessSync(root, fs.constants.W_OK | fs.constants.X_OK);
        let published = true;
        let stableRootFound = false;
        for (const stableRoot of candidates) {
          if (stableRoot === root) continue;
          let stableDirectory: fs.Stats;
          try { stableDirectory = fs.statSync(stableRoot); } catch { continue; }
          if (!stableDirectory.isDirectory() || (stableDirectory.mode & 0o1000) === 0 ||
            (stableDirectory.mode & 0o002) === 0) continue;
          stableRootFound = true;
          if (publishDirectHomeRendezvous(stableRoot, root, owner)) {
            published = true;
            break;
          }
          published = false;
        }
        if (published || !stableRootFound) return root;
      } catch {
        // Try the next candidate.
      }
    }

    const stickySharedRoot = (directory.mode & 0o1000) !== 0 && (directory.mode & 0o002) !== 0;
    if (!stickySharedRoot) continue;
    const privateRootPrefix = `.claude-channel-${ownerName}-`;
    const rendezvousName = path.basename(lockNamespaceCandidate(root, `${LOCK_NAMESPACE}-${ownerName}`));
    type RendezvousState = { root?: string; staleMarker?: FileGeneration };
    const isUsableRendezvousDirectory = (candidate: string): boolean => {
      try {
        const directory = fs.lstatSync(candidate);
        const ownerControlled = owner === undefined || directory.uid === owner;
        const ownerWritable = owner === undefined || (directory.mode & 0o200) !== 0;
        return directory.isDirectory() && !directory.isSymbolicLink() && ownerControlled && ownerWritable &&
          (directory.mode & 0o077) === 0;
      } catch {
        return false;
      }
    };
    const readRendezvousRoot = (rendezvousDirectory: string): RendezvousState => {
      const rendezvousPath = path.join(rendezvousDirectory, 'fallback-root');
      let marker: fs.Stats;
      try {
        marker = fs.lstatSync(rendezvousPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
      }
      const markerOwnerControlled = owner === undefined || marker.uid === owner;
      const markerOwnerWritable = owner === undefined || (marker.mode & 0o200) !== 0;
      if (!marker.isFile() || marker.isSymbolicLink() || !markerOwnerControlled || !markerOwnerWritable ||
        (marker.mode & 0o077) !== 0) {
        throw new Error('Claude channel fallback-root rendezvous is unusable');
      }
      const markerLines = fs.readFileSync(rendezvousPath, 'utf8').trim().split('\n');
      const target = markerLines[0];
      if (!target || path.basename(target) !== target || !target.startsWith(privateRootPrefix)) {
        throw new Error('Claude channel fallback-root rendezvous is invalid');
      }
      const privateRoot = path.join(root, target);
      try {
        const privateDirectory = fs.lstatSync(privateRoot);
        const privateOwnerControlled = owner === undefined || privateDirectory.uid === owner;
        const privateOwnerWritable = owner === undefined || (privateDirectory.mode & 0o200) !== 0;
        if (!privateDirectory.isDirectory() || privateDirectory.isSymbolicLink() || !privateOwnerControlled ||
          !privateOwnerWritable || (privateDirectory.mode & 0o077) !== 0) {
          throw new Error('Claude channel fallback-root target is unusable');
        }
        return { root: privateRoot };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        let staleMarker: FileGeneration;
        try { staleMarker = deps.fileGeneration(rendezvousPath); } catch (markerError) {
          if ((markerError as NodeJS.ErrnoException).code === 'ENOENT') return {};
          throw markerError;
        }
        return { staleMarker };
      }
    };
    const readPublishedRendezvousRoot = (rendezvousDirectory: string, message: string): string => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const winnerRoot = readRendezvousRoot(rendezvousDirectory).root;
        if (winnerRoot) return winnerRoot;
      }
      throw new Error(message);
    };
    try {
      const privateRoots = fs.readdirSync(root)
        .filter(entry => entry.startsWith(privateRootPrefix))
        .map(entry => path.join(root, entry))
        .filter(candidate => {
          try {
            const privateDirectory = fs.lstatSync(candidate);
            const privateOwnerControlled = owner === undefined || privateDirectory.uid === owner;
            const privateOwnerWritable = owner === undefined || (privateDirectory.mode & 0o200) !== 0;
            return privateDirectory.isDirectory() && !privateDirectory.isSymbolicLink() && privateOwnerControlled &&
              privateOwnerWritable && (privateDirectory.mode & 0o077) === 0;
          } catch {
            return false;
          }
        });
      const rendezvousNames = [
        rendezvousName,
        `${rendezvousName}-shared`,
        `${rendezvousName}-election`
      ];
      let rendezvousDirectory: string | undefined;
      let rendezvousState: RendezvousState = {};
      for (const rendezvousNameCandidate of rendezvousNames) {
        const candidate = path.join(root, rendezvousNameCandidate);
        if (!isUsableRendezvousDirectory(candidate)) {
          try {
            fs.mkdirSync(candidate, { mode: 0o700 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          }
        }
        if (!isUsableRendezvousDirectory(candidate)) continue;
        rendezvousDirectory = candidate;
        rendezvousState = readRendezvousRoot(candidate);
        break;
      }
      if (!rendezvousDirectory) {
        const legacyElectionName = `${rendezvousName}-fallback-election`;
        const electionPrefix = `${legacyElectionName}-`;
        const winnerElectionName = `${electionPrefix}winner`;
        const winnerElectionPath = path.join(root, winnerElectionName);
        const randomPrefix = `${rendezvousName}-random-`;
        const readElection = (): string | undefined => {
          let entries: string[];
          try {
            entries = fs.readdirSync(root)
              .filter(entry => entry === legacyElectionName || entry.startsWith(electionPrefix))
              .sort();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          }
          const candidates: Array<{ candidate: string; createdAt: number; inode: number; entry: string }> = [];
          for (const entry of entries) {
            const electionPath = path.join(root, entry);
            let marker: fs.Stats;
            try {
              marker = fs.lstatSync(electionPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
              throw error;
            }
            const markerOwnerControlled = owner === undefined || marker.uid === owner;
            if (!markerOwnerControlled) continue;
            if (!marker.isFile() || marker.isSymbolicLink() || (marker.mode & 0o077) !== 0) {
              throw new Error('Claude channel fallback-root rendezvous election is unusable');
            }
            const candidate = fs.readFileSync(electionPath, 'utf8').trim();
            if (!candidate || path.basename(candidate) !== candidate || !candidate.startsWith(randomPrefix)) {
              throw new Error('Claude channel fallback-root rendezvous election is invalid');
            }
            const candidatePath = path.join(root, candidate);
            if (isUsableRendezvousDirectory(candidatePath)) {
              if (entry === winnerElectionName) return candidate;
              candidates.push({
                candidate,
                createdAt: Number.isFinite(marker.ctimeMs) ? marker.ctimeMs :
                  (Number.isFinite(marker.birthtimeMs) ? marker.birthtimeMs : 0),
                inode: marker.ino,
                entry
              });
              continue;
            }
            let candidateExists = true;
            try { fs.lstatSync(candidatePath); } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') candidateExists = false;
              else throw error;
            }
            if (!candidateExists) {
              let markerGeneration: FileGeneration;
              try { markerGeneration = deps.fileGeneration(electionPath); } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
              }
              let currentGeneration: FileGeneration;
              try { currentGeneration = deps.fileGeneration(electionPath); } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
                throw error;
              }
              if (deps.sameGeneration(currentGeneration, markerGeneration)) {
                try { fs.unlinkSync(electionPath); } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
              }
            }
          }
          candidates.sort((left, right) => left.createdAt - right.createdAt || left.inode - right.inode ||
            left.entry.localeCompare(right.entry));
          return candidates[0]?.candidate;
        };
        let randomRendezvousName = readElection();
        if (!randomRendezvousName) {
          const candidate = `${randomPrefix}${randomUUID()}`;
          const candidatePath = path.join(root, candidate);
          fs.mkdirSync(candidatePath, { mode: 0o700 });
          const markerTemp = path.join(root, `.fallback-election-${process.pid}-${randomUUID()}`);
          fs.writeFileSync(markerTemp, `${candidate}\n`, { mode: 0o600, flag: 'wx' });
          let published = false;
          let publishedElectionPath: string | undefined;
          try {
            try {
              fs.linkSync(markerTemp, winnerElectionPath);
              published = true;
              publishedElectionPath = winnerElectionPath;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            if (!published) randomRendezvousName = readElection();
            if (!randomRendezvousName && !published) {
              for (;;) {
                const electionPath = path.join(root, `${electionPrefix}${randomUUID()}`);
                try {
                  fs.linkSync(markerTemp, electionPath);
                  published = true;
                  publishedElectionPath = electionPath;
                  break;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                }
              }
            }
            if (published) randomRendezvousName = candidate;
            if (published) {
              const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
              for (let attempt = 0; attempt < 8; attempt += 1) {
                const winner = readElection();
                if (winner && winner !== candidate) {
                  randomRendezvousName = winner;
                  break;
                }
                Atomics.wait(waitBuffer, 0, 0, 1);
              }
            }
          } finally {
            try { fs.unlinkSync(markerTemp); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
          }
          if (!randomRendezvousName) throw new Error('Claude channel fallback-root rendezvous election is missing');
          if (randomRendezvousName !== candidate) {
            if (publishedElectionPath) {
              try {
                fs.unlinkSync(publishedElectionPath);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
            }
            try { fs.rmdirSync(candidatePath); } catch { /* preserve the winner if cleanup races */ }
          }
        }
        rendezvousDirectory = path.join(root, randomRendezvousName);
        if (!isUsableRendezvousDirectory(rendezvousDirectory)) {
          throw new Error('Claude channel fallback-root rendezvous election target is unusable');
        }
        rendezvousState = readRendezvousRoot(rendezvousDirectory);
      }
      if (!rendezvousDirectory) {
        throw new Error('Claude channel fallback-root rendezvous is unusable');
      }
      const rendezvousPath = path.join(rendezvousDirectory, 'fallback-root');
      let privateRoot = rendezvousState.root;
      let staleMarker = rendezvousState.staleMarker;
      let createdPrivateRoot = false;
      if (!privateRoot && privateRoots.length > 1) {
        throw new Error('Claude channel fallback-root rendezvous is ambiguous');
      }
      if (!privateRoot) privateRoot = privateRoots[0];
      if (!privateRoot) {
        privateRoot = fs.mkdtempSync(path.join(root, privateRootPrefix));
        createdPrivateRoot = true;
      }
      const currentRendezvousState = readRendezvousRoot(rendezvousDirectory);
      staleMarker = currentRendezvousState.staleMarker ?? staleMarker;
      if (currentRendezvousState.root) {
        const rendezvousRoot = currentRendezvousState.root;
        if (createdPrivateRoot && rendezvousRoot !== privateRoot) {
          try { fs.rmdirSync(privateRoot); } catch { /* preserve the winner if cleanup races */ }
        }
        privateRoot = rendezvousRoot;
      } else {
        const markerTemp = path.join(rendezvousDirectory, `.fallback-root-${process.pid}-${randomUUID()}`);
        const markerContents = homeIdentity === undefined
          ? `${path.basename(privateRoot)}\n`
          : `${path.basename(privateRoot)}\n${homeIdentity}\n`;
        fs.writeFileSync(markerTemp, markerContents, { mode: 0o600, flag: 'wx' });
        try {
          if (staleMarker) {
            const markerBeforeReplace = readRendezvousRoot(rendezvousDirectory).staleMarker;
            if (!markerBeforeReplace) {
              let published = false;
              try {
                fs.linkSync(markerTemp, rendezvousPath);
                published = true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              }
              if (published) {
                staleMarker = undefined;
              } else {
                const winnerRoot = readPublishedRendezvousRoot(rendezvousDirectory,
                  'Claude channel fallback-root rendezvous changed');
                if (createdPrivateRoot && winnerRoot !== privateRoot) {
                  try { fs.rmdirSync(privateRoot); } catch { /* preserve the winner if cleanup races */ }
                }
                privateRoot = winnerRoot;
              }
            } else if (!deps.sameGeneration(markerBeforeReplace, staleMarker)) {
              const winnerRoot = readPublishedRendezvousRoot(rendezvousDirectory,
                'Claude channel fallback-root rendezvous changed');
              if (createdPrivateRoot && winnerRoot !== privateRoot) {
                try { fs.rmdirSync(privateRoot); } catch { /* preserve the winner if cleanup races */ }
              }
              privateRoot = winnerRoot;
            } else {
              const markerClaim = path.join(rendezvousDirectory, `.fallback-root-claim-${process.pid}-${randomUUID()}`);
              let claimed = false;
              try {
                fs.renameSync(rendezvousPath, markerClaim);
                claimed = true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              }
              if (!claimed) {
                let published = false;
                try {
                  fs.linkSync(markerTemp, rendezvousPath);
                  published = true;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                }
                if (published) {
                  staleMarker = undefined;
                } else {
                  const winnerRoot = readPublishedRendezvousRoot(rendezvousDirectory,
                    'Claude channel fallback-root rendezvous changed');
                  if (createdPrivateRoot && winnerRoot !== privateRoot) {
                    try { fs.rmdirSync(privateRoot); } catch { /* preserve the winner if cleanup races */ }
                  }
                  privateRoot = winnerRoot;
                }
              } else {
                const claimedIdentity = fs.lstatSync(markerClaim, { bigint: true });
                if (claimedIdentity.dev !== staleMarker.dev || claimedIdentity.ino !== staleMarker.ino) {
                  try {
                    fs.linkSync(markerClaim, rendezvousPath);
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                  }
                  try { fs.unlinkSync(markerClaim); } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                  }
                  const winnerRoot = readPublishedRendezvousRoot(rendezvousDirectory,
                    'Claude channel fallback-root rendezvous changed');
                  if (createdPrivateRoot && winnerRoot !== privateRoot) {
                    try { fs.rmdirSync(privateRoot); } catch { /* preserve the winner if cleanup races */ }
                  }
                  privateRoot = winnerRoot;
                } else {
                  let published = false;
                  try {
                    fs.linkSync(markerTemp, rendezvousPath);
                    published = true;
                  } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                  }
                  if (published) {
                    try { fs.unlinkSync(markerClaim); } catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    }
                    staleMarker = undefined;
                  } else {
                    const winnerRoot = readPublishedRendezvousRoot(rendezvousDirectory,
                      'Claude channel fallback-root rendezvous changed');
                    if (createdPrivateRoot && winnerRoot !== privateRoot) {
                      try { fs.rmdirSync(privateRoot); } catch { /* preserve the winner if cleanup races */ }
                    }
                    privateRoot = winnerRoot;
                    try { fs.unlinkSync(markerClaim); } catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                    }
                  }
                }
              }
            }
          } else {
            try {
              fs.linkSync(markerTemp, rendezvousPath);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              const winnerRoot = readPublishedRendezvousRoot(rendezvousDirectory,
                'Claude channel fallback-root rendezvous is missing');
              if (createdPrivateRoot && winnerRoot !== privateRoot) {
                try { fs.rmdirSync(privateRoot); } catch { /* preserve the winner if cleanup races */ }
              }
              privateRoot = winnerRoot;
            }
          }
        } finally {
          try { fs.unlinkSync(markerTemp); } catch { /* marker link owns the content */ }
        }
      }
      const publishedRoot = publishedFallbackRoot(root, owner);
      if (!publishedRoot) {
        throw new Error('Claude channel fallback-root rendezvous is missing');
      }
      if (publishedRoot !== privateRoot) {
        if (createdPrivateRoot) {
          try { fs.rmdirSync(privateRoot); } catch { /* preserve the winner if cleanup races */ }
        }
        privateRoot = publishedRoot;
      }
      const privateDirectory = fs.lstatSync(privateRoot);
      const privateOwnerControlled = owner === undefined || privateDirectory.uid === owner;
      const privateOwnerWritable = owner === undefined || (privateDirectory.mode & 0o200) !== 0;
      if (privateDirectory.isDirectory() && !privateDirectory.isSymbolicLink() && privateOwnerControlled &&
        privateOwnerWritable && (privateDirectory.mode & 0o077) === 0) {
        fs.accessSync(privateRoot, fs.constants.W_OK | fs.constants.X_OK);
        return privateRoot;
      }
    } catch (error) {
      if (error instanceof Error && /ambiguous|rendezvous is missing/.test(error.message)) throw error;
      // Try the next candidate.
    }
  }
  throw new Error('Claude channel socket lock namespace root is unusable');
}
