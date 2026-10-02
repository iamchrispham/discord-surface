const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const childProcess = require('node:child_process');

const AUTHORITY_MODULE = ['.claude', 'skills', 'phone-notify', 'scripts', 'tg-codex-mcp-launch-authority.mjs'];
const BINDING_MODULE = ['.claude', 'hooks', 'session-chat-binding.mjs'];

function observeProcessStart(pid) {
  const value = childProcess.execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

async function resolveCurrentCodexWatcherCaller(nativeId) {
  if (process.env.NODE_OPTIONS || process.execArgv.length || Object.keys(process.env).some(key => key.startsWith('DYLD_'))) {
    throw new Error('codex caller environment refused');
  }
  const home = os.userInfo().homedir;
  const authority = await import(pathToFileURL(path.join(home, ...AUTHORITY_MODULE)).href);
  const bindings = await import(pathToFileURL(path.join(home, ...BINDING_MODULE)).href);
  if (typeof authority.verifySealedCodexMcpOwner !== 'function' || typeof bindings.trustedCodexActiveParentBinding !== 'function') {
    throw new Error('codex caller authority export is unavailable');
  }
  const seal = authority.verifySealedCodexMcpOwner(process.ppid);
  const binding = bindings.trustedCodexActiveParentBinding(nativeId, {
    workersDir: path.join(home, '.agents', 'work-control', 'workers'),
    sessionsRoot: path.join(home, '.codex', 'sessions'),
    sessionIndexFile: path.join(home, '.codex', 'session_index.jsonl'),
    observeProcessStart
  });
  if (!binding || binding.sessionId !== nativeId || binding.harness !== 'codex') {
    throw new Error('codex caller binding does not identify the requested session');
  }
  if (!seal || !positiveNumber(seal.parent_pid) || !positiveNumber(seal.parent_start_time) ||
      binding.caller?.pid !== seal.parent_pid || binding.caller?.processStartTime !== seal.parent_start_time) {
    throw new Error('codex caller binding does not match the sealed parent process');
  }
  return { harness: 'codex', sessionId: binding.sessionId, threadId: binding.sessionId };
}

module.exports = { resolveCurrentCodexWatcherCaller };
