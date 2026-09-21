'use strict';

const REPLY_LIMIT = 2000;

function replyBoundary(text, offset) {
  let end = Math.min(text.length, offset + REPLY_LIMIT);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
  return end;
}

function partitionReply(text, preferNewlines) {
  const parts = [];
  let offset = 0;
  while (offset < text.length) {
    let end = replyBoundary(text, offset);
    if (preferNewlines && end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= offset) end = newline + 1;
    }
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts.length ? parts : [''];
}

function replyBoundaryAllowed(text, end) {
  return end === text.length || !/[\uD800-\uDBFF]/.test(text[end - 1]);
}

function repartitionNonBlankReply(text) {
  if (!text.length) return [''];
  const nextVisible = new Array(text.length + 1).fill(text.length);
  let visible = text.length;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (/\S/u.test(text[index])) visible = index;
    nextVisible[index] = visible;
  }

  const canPartition = new Array(text.length + 1).fill(false);
  const reachableBoundaries = new Array(text.length + 2).fill(0);
  canPartition[text.length] = true;
  reachableBoundaries[text.length] = 1;
  for (let start = text.length - 1; start >= 0; start -= 1) {
    const firstVisible = nextVisible[start];
    const maxEnd = Math.min(text.length, start + REPLY_LIMIT);
    if (replyBoundaryAllowed(text, start) && firstVisible < text.length && firstVisible + 1 <= maxEnd) {
      const minEnd = firstVisible + 1;
      canPartition[start] = reachableBoundaries[minEnd] - reachableBoundaries[maxEnd + 1] > 0;
    }
    reachableBoundaries[start] = reachableBoundaries[start + 1] +
      (canPartition[start] && replyBoundaryAllowed(text, start) ? 1 : 0);
  }
  if (!canPartition[0]) return null;

  const parts = [];
  let start = 0;
  while (start < text.length) {
    const firstVisible = nextVisible[start];
    const maxEnd = Math.min(text.length, start + REPLY_LIMIT);
    let end = maxEnd;
    while (end > firstVisible && (!canPartition[end] || !replyBoundaryAllowed(text, end))) end -= 1;
    if (end <= firstVisible) return null;
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function splitReply(text) {
  let parts = partitionReply(text, true);
  if (!parts.some(part => !part.trim())) return parts;
  parts = partitionReply(text, false);
  const tail = parts.at(-1);
  if (parts.length > 1 && !tail.trim()) {
    const previous = parts.at(-2);
    const boundary = previous.search(/\S\s*$/u);
    if (boundary > 0 && previous.length - boundary + tail.length <= REPLY_LIMIT) {
      parts[parts.length - 2] = previous.slice(0, boundary);
      parts[parts.length - 1] = previous.slice(boundary) + tail;
    }
  }
  if (parts.some(part => !part.trim())) return repartitionNonBlankReply(text) || parts;
  return parts;
}

module.exports = { REPLY_LIMIT, splitReply };
