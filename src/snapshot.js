const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SNAPSHOT_MAX_BUFFER = 8 * 1024 * 1024;

function readSnapshot(binding, { registry = path.join(os.homedir(), '.agents/work-control/pr-lanes.json'),
  ladderDir = path.join(os.homedir(), '.claude/skills/conduct-status/scripts'), now, signal } = {}) {
  const args = [path.join(__dirname, 'snapshot.py'), '--registry', registry, '--ladder-dir', ladderDir];
  if (now !== undefined) args.push('--now', String(now));
  return new Promise(resolve => {
    const child = execFile('/usr/bin/python3', args, { timeout: 3000, maxBuffer: SNAPSHOT_MAX_BUFFER, signal }, (error, stdout) => {
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

function truncate(text, limit) {
  if (text.length <= limit) return text;
  if (limit <= 1) return text.slice(0, limit);
  return `${text.slice(0, limit - 1)}…`;
}

function renderSnapshot(snapshot) {
  if (snapshot.unavailable) return 'Automatic artifact snapshot: source unavailable.';
  const { context, lanes, source } = snapshot;
  const updated = Date.parse(context.updated || '');
  const stamp = Number.isFinite(updated) ? `<t:${Math.floor(updated / 1000)}:R>` : 'time not recorded';
  const lines = [`**Automatic artifact snapshot · ${discordText(snapshot.identity.provider)}**`,
    `Recorded context: ${context.freshness === 'current' ? 'as of source' : context.freshness} · ${stamp}`];
  const renderField = (label, field, list = false, limit = 400) => {
    if (field.state === 'invalid') return `${label}: invalid.`;
    if (field.state !== 'recorded') return `${label}: not recorded.`;
    if (list && !field.value.length) return `${label}: none recorded${context.freshness === 'stale' ? ' (stale source)' : ''}.`;
    const prefix = `${label}: `;
    if (!list) return `${prefix}${truncate(discordText(field.value), Math.max(1, limit - prefix.length))}`;
    let output = prefix;
    let included = 0;
    for (const value of field.value) {
      const item = discordText(typeof value === 'string' ? value : value.text);
      const separator = included ? ' / ' : '';
      if (output.length + separator.length + item.length > limit) break;
      output += separator + item;
      included += 1;
    }
    let omitted = field.value.length - included;
    if (!omitted) return output;
    let suffix = `${included ? ' / ' : ''}${omitted} item(s) omitted.`;
    if (!included) {
      const item = discordText(typeof field.value[0] === 'string' ? field.value[0] : field.value[0].text);
      const itemRoom = limit - output.length - suffix.length;
      if (itemRoom > 1) {
        output += truncate(item, itemRoom);
        included = 1;
        omitted -= 1;
        suffix = `${omitted ? ' / ' : ''}${omitted} item(s) omitted.`;
      }
    }
    if (!omitted) return output;
    if (output.length + suffix.length <= limit) return output + suffix;
    const room = Math.max(prefix.length, limit - suffix.length);
    output = output.slice(0, Math.max(prefix.length, room - 1)) + '…';
    return output + suffix;
  };
  lines.push(renderField('Intent', context.intent, false, 300), renderField('Owed by you', context.owedByOperator, true, 420),
    renderField('Owed to you', context.owedToOperator, true, 420), renderField('Next', context.next, true, 300));
  let omitted = Number.isInteger(snapshot.omittedLanes) ? Math.max(0, snapshot.omittedLanes) : 0;
  const footer = `Source revision ${String(source?.revision || 'unknown').slice(0, 10)}. Recorded claims, not a live process census.`;
  const omissionReserve = `${Number.MAX_SAFE_INTEGER} lane record(s) omitted from this preview.`.length;
  const canAdd = line => lines.join('\n').length + 1 + line.length + 1 + footer.length + 1 + omissionReserve <= 2000;
  for (const lane of lanes) {
    const line = `${discordText(lane.ticket || lane.id)}${lane.pr ? ` #${discordText(lane.pr)}` : ''}: ${lane.percent ?? '??'}%${lane.held ? ' held' : ''} · ${discordText(lane.stateNote || lane.phase || 'state not recorded')}\nNext: ${discordText(lane.next || 'not recorded')}`;
    if (canAdd(line)) lines.push(line);
    else omitted += 1;
  }
  if (!lanes.length) {
    const empty = 'No matching lane records. This does not establish completion.';
    if (canAdd(empty)) lines.push(empty);
  }
  if (omitted) lines.push(`${omitted} lane record(s) omitted from this preview.`);
  lines.push(footer);
  return lines.join('\n');
}

module.exports = { readSnapshot, renderSnapshot };
