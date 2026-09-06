const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

function readSnapshot(binding, { registry = path.join(os.homedir(), '.agents/work-control/pr-lanes.json'),
  ladderDir = path.join(os.homedir(), '.claude/skills/conduct-status/scripts'), now, signal } = {}) {
  const args = [path.join(__dirname, 'snapshot.py'), '--registry', registry, '--ladder-dir', ladderDir];
  if (now !== undefined) args.push('--now', String(now));
  return new Promise(resolve => {
    const child = execFile('/usr/bin/python3', args, { timeout: 3000, maxBuffer: 128 * 1024, signal }, (error, stdout) => {
      try {
        const result = JSON.parse(stdout);
        resolve(error ? { unavailable: result.unavailable || 'snapshot reader failed' } : result);
      } catch { resolve({ unavailable: error?.message || 'invalid snapshot output' }); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(binding));
  });
}

function discordText(value) {
  return String(value).replace(/([\\`*_~>|])/g, '\\$1').replace(/@/g, '@\u200b');
}

function renderSnapshot(snapshot) {
  if (snapshot.unavailable) return 'Automatic artifact snapshot: source unavailable.';
  const { context, lanes, source } = snapshot;
  const updated = Date.parse(context.updated || '');
  const stamp = Number.isFinite(updated) ? `<t:${Math.floor(updated / 1000)}:R>` : 'time not recorded';
  const lines = [`**Automatic artifact snapshot · ${discordText(snapshot.identity.provider)}**`,
    `Recorded context: ${context.freshness === 'current' ? 'as of source' : context.freshness} · ${stamp}`];
  const renderField = (label, field, list = false) => {
    if (field.state !== 'recorded') return `${label}: not recorded.`;
    if (list && !field.value.length) return `${label}: none recorded${context.freshness === 'stale' ? ' (stale source)' : ''}.`;
    return `${label}: ${list ? field.value.map(value => discordText(typeof value === 'string' ? value : value.text)).join(' / ') : discordText(field.value)}`;
  };
  lines.push(renderField('Intent', context.intent), renderField('Owed by you', context.owedByOperator, true),
    renderField('Owed to you', context.owedToOperator, true), renderField('Next', context.next, true));
  let omitted = snapshot.omittedLanes;
  for (const lane of lanes) {
    const line = `${discordText(lane.ticket || lane.id)}${lane.pr ? ` #${discordText(lane.pr)}` : ''}: ${lane.percent ?? '??'}%${lane.held ? ' held' : ''} · ${discordText(lane.stateNote || lane.phase || 'state not recorded')}\nNext: ${discordText(lane.next || 'not recorded')}`;
    if (lines.join('\n').length + line.length > 1700) { omitted += 1; continue; }
    lines.push(line);
  }
  if (!lanes.length) lines.push('No matching lane records. This does not establish completion.');
  if (omitted) lines.push(`${omitted} lane record(s) omitted from this preview.`);
  lines.push(`Source revision ${source.revision.slice(0, 10)}. Recorded claims, not a live process census.`);
  const result = lines.join('\n');
  if (result.length <= 2000) return result;
  return result.slice(0, 1830) + '\nPreview truncated. Some recorded context is omitted.';
}

module.exports = { readSnapshot, renderSnapshot };
