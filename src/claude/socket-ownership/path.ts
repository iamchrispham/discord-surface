import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileIdentity } from './types';

const caseSensitivityByDirectory = new Map<string, boolean>();
const normalizationSensitivityByDirectory = new Map<string, boolean>();

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(filePath: string): FileIdentity {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
}

function alternateCase(value: string): string {
  const index = value.search(/[A-Za-z]/);
  if (index < 0) return value;
  const character = value[index];
  const replacement = character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase();
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

function isCaseInsensitiveDirectory(directoryPath: string): boolean {
  const cached = caseSensitivityByDirectory.get(directoryPath);
  if (cached !== undefined) return cached;
  const probeName = `.discord-surface-case-${randomUUID()}`;
  const probePath = path.join(directoryPath, probeName);
  const alternatePath = path.join(directoryPath, alternateCase(probeName));
  let descriptor: number | undefined;
  let insensitive = false;
  try {
    descriptor = fs.openSync(probePath, 'wx', 0o600);
    try {
      insensitive = sameFile(fileIdentity(probePath), fileIdentity(alternatePath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(probePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try { fs.unlinkSync(alternatePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  caseSensitivityByDirectory.set(directoryPath, insensitive);
  return insensitive;
}

function isNormalizationInsensitiveDirectory(directoryPath: string): boolean {
  const cached = normalizationSensitivityByDirectory.get(directoryPath);
  if (cached !== undefined) return cached;
  const probeName = `.discord-surface-normalization-${randomUUID()}`;
  const composedPath = path.join(directoryPath, `${probeName}-é`);
  const decomposedPath = path.join(directoryPath, `${probeName}-e\u0301`);
  let descriptor: number | undefined;
  let insensitive = false;
  try {
    descriptor = fs.openSync(composedPath, 'wx', 0o600);
    try {
      insensitive = sameFile(fileIdentity(composedPath), fileIdentity(decomposedPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(composedPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try { fs.unlinkSync(decomposedPath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  normalizationSensitivityByDirectory.set(directoryPath, insensitive);
  return insensitive;
}

function filesystemCaseFold(value: string): string {
  return Array.from(value, character => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint === 0x1e9e) return 'ss';
    if (codePoint === 0x0131 || (codePoint >= 0x13a0 && codePoint <= 0x13f5)) return character;
    if (codePoint >= 0x13f8 && codePoint <= 0x13fd) {
      return String.fromCodePoint(codePoint - 8);
    }
    if (codePoint >= 0xab70 && codePoint <= 0xabbf) {
      return String.fromCodePoint(codePoint - 0x97d0);
    }
    return character.toUpperCase().toLowerCase();
  }).join('');
}

export function canonicalSocketPath(socketPath: string): string {
  const parentPath = path.dirname(socketPath);
  let canonicalParentPath = parentPath;
  try {
    canonicalParentPath = fs.realpathSync(parentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const basename = path.basename(socketPath);
  const caseInsensitive = isCaseInsensitiveDirectory(canonicalParentPath);
  const normalizationInsensitive = isNormalizationInsensitiveDirectory(canonicalParentPath);
  const normalizedBasename = normalizationInsensitive ? basename.normalize('NFC') : basename;
  if (!caseInsensitive && !normalizationInsensitive) return path.join(canonicalParentPath, basename);
  const comparableBasename = caseInsensitive ? filesystemCaseFold(normalizedBasename) : normalizedBasename;
  return path.join(canonicalParentPath, comparableBasename);
}

export function pathsOverlap(leftPath: string, rightPath: string): boolean {
  const isWithin = (parentPath: string, childPath: string): boolean => {
    const relativePath = path.relative(parentPath, childPath);
    return relativePath === '' ||
      (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
  };
  return isWithin(leftPath, rightPath) || isWithin(rightPath, leftPath);
}
