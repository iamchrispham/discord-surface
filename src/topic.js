const READINESS = Object.freeze(['pending', 'ready', 'unavailable', 'recovering', 'gap']);
const READINESS_PATTERN = READINESS.join('|');
const STATUS_SUFFIX = new RegExp(` \\[last-published-intake=(${READINESS_PATTERN}) at=(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)\\]$`);
const CONDUCTOR_MARKER = new RegExp(`^discord-surface:v2 conductor=([^\\s]+) provider=(codex|claude) repo=([^\\s]+) native=([^\\s]+) generation=(\\d+) readiness=(${READINESS_PATTERN})$`);

function topicPresentation(topic) {
  const current = typeof topic === 'string' ? topic : '';
  const suffix = current.match(STATUS_SUFFIX);
  const base = suffix ? current.slice(0, suffix.index) : current;
  const readiness = base.match(/\breadiness=([^\s]+)/)?.[1] || null;
  return {
    base,
    readiness,
    publishedReadiness: suffix?.[1] || null,
    publishedAt: suffix?.[2] || null,
    hasValidSuffix: Boolean(suffix)
  };
}

function conductorMarkerMatches(topic, expected) {
  const match = CONDUCTOR_MARKER.exec(topicPresentation(topic).base);
  if (!match) return false;
  try {
    return decodeURIComponent(match[1]) === expected.conductorId && match[2] === expected.provider &&
      decodeURIComponent(match[3]) === expected.repoKey && match[4] === expected.nativeId &&
      Number(match[5]) === expected.generation;
  } catch {
    return false;
  }
}

function topicWithReadiness(topic, readiness, publishedAt = new Date().toISOString()) {
  if (!READINESS.includes(readiness)) throw new Error('invalid Discord topic readiness');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(publishedAt)) throw new Error('invalid Discord topic publication timestamp');
  const base = topicPresentation(topic).base;
  const nextBase = /\breadiness=[^\s]+/.test(base)
    ? base.replace(/\breadiness=[^\s]+/, `readiness=${readiness}`)
    : `${base} readiness=${readiness}`;
  const suffix = ` [last-published-intake=${readiness} at=${publishedAt}]`;
  if (/^discord-surface:v2\s/.test(nextBase) && nextBase.length + suffix.length > 1024) {
    throw new Error('Discord topic publication qualifier exceeds topic limit');
  }
  return `${nextBase.slice(0, Math.max(0, 1024 - suffix.length))}${suffix}`;
}

module.exports = { conductorMarkerMatches, topicPresentation, topicWithReadiness };
