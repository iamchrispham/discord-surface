const READINESS = Object.freeze(['pending', 'ready', 'unavailable', 'recovering', 'gap']);
const READINESS_PATTERN = READINESS.join('|');
const STATUS_SUFFIX = new RegExp(` \\[last-published-intake=(${READINESS_PATTERN}) at=(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)\\]$`);
const ADDRESS_QUALIFIER = '[address only, not live status]';
const STATIC_CONDUCTOR_MARKER = /^discord-surface:v3 conductor=([^\s]+) provider=(codex|claude) repo=([^\s]+) \[address only, not live status\]$/;
const LEGACY_CONDUCTOR_MARKER = new RegExp(`^discord-surface:v2 conductor=([^\\s]+) provider=(codex|claude) repo=([^\\s]+) native=([^\\s]+) generation=(\\d+) readiness=(${READINESS_PATTERN})$`);

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
  const presentation = topicPresentation(topic);
  if (presentation.publishedReadiness && /^discord-surface:v3\s/.test(presentation.base)) return false;
  const base = presentation.base;
  const staticMatch = STATIC_CONDUCTOR_MARKER.exec(base);
  if (staticMatch) {
    try {
      const conductorId = decodeURIComponent(staticMatch[1]);
      const repoKey = decodeURIComponent(staticMatch[3]);
      return encodeURIComponent(conductorId) === staticMatch[1] &&
        encodeURIComponent(repoKey) === staticMatch[3] &&
        conductorId === expected.conductorId && staticMatch[2] === expected.provider && repoKey === expected.repoKey;
    } catch {
      return false;
    }
  }
  const legacyMatch = LEGACY_CONDUCTOR_MARKER.exec(base);
  if (!legacyMatch) return false;
  try {
    return decodeURIComponent(legacyMatch[1]) === expected.conductorId && legacyMatch[2] === expected.provider &&
      decodeURIComponent(legacyMatch[3]) === expected.repoKey && legacyMatch[4] === expected.nativeId &&
      Number(legacyMatch[5]) === expected.generation;
  } catch {
    return false;
  }
}

function staticConductorMarker({ provider, conductorId, repoKey }) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('unsupported provider');
  if (typeof conductorId !== 'string' || !conductorId || typeof repoKey !== 'string' || !repoKey) {
    throw new Error('conductorId and repoKey are required');
  }
  const marker = `discord-surface:v3 conductor=${encodeURIComponent(conductorId)} provider=${provider} repo=${encodeURIComponent(repoKey)} ${ADDRESS_QUALIFIER}`;
  if (marker.length > 1024) throw new Error('conductor channel topic marker exceeds Discord topic limit');
  return marker;
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

module.exports = { ADDRESS_QUALIFIER, conductorMarkerMatches, staticConductorMarker, topicPresentation, topicWithReadiness };
