'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validateNativeId } = require('../state');

const bindingFields = ['channel_id', 'guild_id', 'provider', 'native_id', 'workspace',
  'session_root', 'endpoint', 'category_id', 'conductor_id', 'repo_key', 'readiness',
  'generation', 'active', 'updated_at'];
const watermarkFields = ['channel_id', 'guild_id', 'last_seen_id', 'recovered_through_id',
  'last_accepted_id', 'state', 'gap_from', 'gap_to', 'detail', 'updated_at'];
const dnsDetail = 'getaddrinfo ENOTFOUND discord.com';

function exactFields(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}

function readPrivateJson(file) {
  if (!path.isAbsolute(file) || typeof process.getuid !== 'function' ||
      typeof fs.constants.O_NOFOLLOW !== 'number' || typeof fs.constants.O_NONBLOCK !== 'number') {
    throw new Error('an absolute private intake expectation file is required');
  }
  const flags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(file, flags);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n ||
        (before.mode & 0o077n) !== 0n || before.size <= 0n || before.size > 32768n) {
      throw new Error('invalid private intake expectation file');
    }
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    const sameFile = ['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
      .every(key => before[key] === after[key] && before[key] === named[key]);
    if (!sameFile || used !== Number(before.size)) throw new Error('intake expectation file changed');
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
    } catch {
      throw new Error('invalid intake expectation JSON');
    }
  } finally {
    fs.closeSync(fd);
  }
}

function requireBindingIdentity(binding) {
  const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
  const absolute = (value, max) => text(value, max) && path.isAbsolute(value);
  const hasConductor = binding.conductor_id !== null;
  const hasRepo = binding.repo_key !== null;
  validateNativeId(binding.native_id);
  if (!text(binding.channel_id, 128) || !text(binding.guild_id, 128) ||
      !['codex', 'claude'].includes(binding.provider) || !absolute(binding.workspace, 4096) ||
      (binding.session_root !== null && !absolute(binding.session_root, 4096)) ||
      (binding.endpoint !== null && !absolute(binding.endpoint, 90)) ||
      (binding.provider === 'claude' && binding.endpoint === null) ||
      (binding.category_id !== null && !text(binding.category_id, 128)) ||
      hasConductor !== hasRepo || (hasConductor && !text(binding.conductor_id, 256)) ||
      (hasRepo && (!text(binding.repo_key, 1024) || path.isAbsolute(binding.repo_key) ||
        /[\u0000-\u001f\u007f]/.test(binding.repo_key)))) {
    throw new Error('invalid guarded intake binding identity');
  }
}

function readIntakeRecoveryExpectation(file, channelId) {
  const started = performance.now();
  const wallStarted = Date.now();
  const proof = readPrivateJson(file);
  if (!exactFields(proof, ['requestId', 'deadlineMs', 'binding', 'watermark']) ||
      typeof proof.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proof.requestId) ||
      !Number.isSafeInteger(proof.deadlineMs) ||
      !exactFields(proof.binding, bindingFields) || !exactFields(proof.watermark, watermarkFields)) {
    throw new Error('incomplete or invalid guarded intake expectation');
  }
  const { binding, watermark } = proof;
  requireBindingIdentity(binding);
  const text = value => typeof value === 'string' && value.length > 0;
  const cursor = value => value === null || (typeof value === 'string' && /^\d+$/.test(value));
  if (binding.channel_id !== channelId || watermark.channel_id !== channelId ||
      binding.guild_id !== watermark.guild_id ||
      binding.active !== 1 || !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
      binding.readiness !== 'unavailable' || watermark.state !== 'unavailable' || watermark.detail !== dnsDetail ||
      !text(binding.updated_at) || !text(watermark.updated_at) ||
      !['last_seen_id', 'recovered_through_id', 'last_accepted_id', 'gap_from', 'gap_to'].every(k => cursor(watermark[k]))) {
    throw new Error('expected an active parent and its exact unavailable Discord DNS watermark');
  }
  const monotonicDeadline = started + (proof.deadlineMs - wallStarted);
  if (!(Number.isFinite(monotonicDeadline) && Date.now() < proof.deadlineMs && performance.now() < monotonicDeadline)) {
    throw new Error('guarded intake recovery expired');
  }
  return { ...proof, monotonicDeadline };
}

module.exports = { readIntakeRecoveryExpectation };
