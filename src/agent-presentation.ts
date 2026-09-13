import { KINDS } from './agent-message';
import type { AgentMessage } from './agent-message';

export const AGENT_PRESENTATIONS = Object.freeze({
  LEGACY: 'legacy',
  ATTACHMENT: 'attachment-v1'
} as const);

export type AgentPresentation = typeof AGENT_PRESENTATIONS[keyof typeof AGENT_PRESENTATIONS];

const PREVIEW_EXCERPT_LIMIT = 240;

function previewExcerpt(text: string): string {
  const normalized = text
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized.length <= PREVIEW_EXCERPT_LIMIT) return normalized;
  return `${normalized.slice(0, PREVIEW_EXCERPT_LIMIT - 1).trimEnd()}…`;
}

export function agentMessagePreview(packet: AgentMessage): string {
  const label = packet.kind === KINDS.RESULT ? 'Agent result' : 'Agent request';
  return `${label} from ${packet.source.provider} to ${packet.target.provider}: ${previewExcerpt(packet.text)}`;
}
