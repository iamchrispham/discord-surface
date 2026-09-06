const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SPARK_COMMAND = '/Users/cphamballer/.local/bin/codex';
const SPARK_MODEL = 'gpt-5.3-codex-spark';
const SPARK_EFFORT = 'low';

function disabledSkillConfig() {
  const roots = [
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(os.homedir(), '.codex', 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
    path.join(os.homedir(), '.codex', 'skills', '.system')
  ];
  const names = new Set();
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skill = path.join(root, entry.name, 'SKILL.md');
      try {
        const body = fs.readFileSync(skill, 'utf8');
        const header = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
        const name = header?.match(/^name:\s*["']?([^\r\n"']+)["']?\s*$/m)?.[1].trim();
        if (name) names.add(name);
      } catch {}
    }
  }
  return [...names].sort().map(name => `{name=${JSON.stringify(name)},enabled=false}`).join(',');
}

function buildSparkCommand({ cwd, schemaPath, answerPath }) {
  const args = [
    'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '--model', SPARK_MODEL, '--cd', cwd, '--json', '--output-schema', schemaPath,
    '--output-last-message', answerPath,
    '-c', `model_reasoning_effort="${SPARK_EFFORT}"`,
    '-c', 'forced_login_method="chatgpt"',
    '-c', 'project_doc_max_bytes=0',
    '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'multi_agent',
    '--disable', 'multi_agent_v2', '--disable', 'memories', '--disable', 'browser_use',
    '--enable', 'skip_host_skill_discovery', '--disable', 'computer_use',
    '--disable', 'image_generation', '--disable', 'sleep_tool',
    '-c', `skills.config=[${disabledSkillConfig()}]`,
    '-c', 'web_search="disabled"', '-'
  ];
  return { command: SPARK_COMMAND, args };
}

function scrubEnvironment(input) {
  const env = { ...input };
  for (const key of Object.keys(env)) {
    if (key === 'DISCORD_TOKEN' || key === 'CLAUDE_CODE_OAUTH_TOKEN' ||
      key.startsWith('OPENAI_') || key.startsWith('ANTHROPIC_') || key.startsWith('AZURE_OPENAI_')) delete env[key];
  }
  return env;
}

function isExited(child) {
  return (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined);
}

function exitWaiter(child) {
  if (isExited(child)) return { promise: Promise.resolve({ code: child.exitCode, signal: child.signalCode }) };
  let settled = false;
  let resolveExit;
  const promise = new Promise(resolve => { resolveExit = resolve; });
  const finish = result => {
    if (settled) return;
    settled = true;
    resolveExit(result);
  };
  child.once('exit', (code, signal) => finish({ code, signal }));
  child.once('error', error => finish({ error }));
  return { promise };
}

function killGroup(child, signal) {
  if (isExited(child)) return;
  if (Number.isInteger(child.pid) && child.pid > 0) {
    try { process.kill(-child.pid, signal); return; } catch {}
  }
  try { child.kill(signal); } catch {}
}

async function terminateChild(child, waiter, terminationGraceMs = 3000) {
  if (isExited(child)) return;
  killGroup(child, 'SIGTERM');
  const graceful = await Promise.race([waiter.promise, new Promise(resolve => setTimeout(() => resolve(null), terminationGraceMs))]);
  if (graceful) return;
  killGroup(child, 'SIGKILL');
  await Promise.race([waiter.promise, new Promise(resolve => setTimeout(resolve, 500))]);
}

async function runBoundedSpark({ command, args, cwd, prompt, signal, timeoutMs, terminationGraceMs, spawnProcess = spawn, onSpawn }) {
  let child;
  try {
    child = spawnProcess(command, args, {
      cwd,
      env: scrubEnvironment(process.env),
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true
    });
  } catch (error) {
    return { ok: false, reason: 'spawn-failed', error };
  }
  const waiter = exitWaiter(child);
  try {
    onSpawn?.(child);
  } catch (error) {
    await terminateChild(child, waiter, terminationGraceMs);
    return { ok: false, reason: 'spawn-failed', error };
  }
  let timer;
  let abortHandler;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ reason: 'timeout' }), timeoutMs);
  });
  const aborted = signal ? new Promise(resolve => {
    abortHandler = () => resolve({ reason: 'cancelled' });
    if (signal.aborted) abortHandler();
    else signal.addEventListener('abort', abortHandler, { once: true });
  }) : new Promise(() => {});
  try {
    try { child.stdin.end(prompt); } catch (error) {
      await terminateChild(child, waiter, terminationGraceMs);
      return { ok: false, reason: 'stdin-failed', error };
    }
    const first = await Promise.race([waiter.promise, timeout, aborted]);
    if (first?.reason) {
      await terminateChild(child, waiter, terminationGraceMs);
      return { ok: false, reason: first.reason };
    }
    if (first?.error || first?.code !== 0) return { ok: false, reason: 'provider-failed' };
    return { ok: true };
  } finally {
    clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
  }
}

module.exports = { buildSparkCommand, runBoundedSpark };
