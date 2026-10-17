'use strict';

function captureProcessOwnerIdentity(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return null;
  const normalizedPid = Number(pid);
  let ownerStartTime = null;
  let ownerCommand = null;
  try {
    const stat = require('node:fs').readFileSync(`/proc/${normalizedPid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close > 0) ownerStartTime = stat.slice(close + 2).trim().split(/\s+/)[19] || null;
    const command = require('node:fs').readFileSync(`/proc/${normalizedPid}/cmdline`, 'utf8');
    ownerCommand = command.split('\0').filter(Boolean).join('\0') || null;
  } catch (error) {
    try {
      ownerStartTime = require('node:child_process').execFileSync('ps', ['-p', String(normalizedPid), '-o', 'lstart='], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      }).trim().replace(/\s+/g, ' ') || null;
      ownerCommand = require('node:child_process').execFileSync('ps', ['-p', String(normalizedPid), '-o', 'command='], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
      }).trim() || null;
    } catch (fallbackError) {
      return null;
    }
  }
  if (!ownerStartTime && !ownerCommand) return null;
  return { ownerPid: normalizedPid, ownerStartTime, ownerCommand };
}

module.exports = { captureProcessOwnerIdentity };
