import {
  AGENT_ATTACHMENT_CONTENT_TYPE,
  AGENT_ATTACHMENT_FILENAME,
  AGENT_ATTACHMENT_MAX_BYTES,
  attachmentUrlAllowed,
  fetchAgentAttachment,
  normalizeAgentMessage,
  type AgentAttachmentOptions,
  type AttachmentFetch
} from '../../src/agent-attachment';

const attachment = {
  url: 'https://cdn.discordapp.com/attachments/100/102/agent-message.tether',
  filename: AGENT_ATTACHMENT_FILENAME,
  contentType: AGENT_ATTACHMENT_CONTENT_TYPE,
  size: AGENT_ATTACHMENT_MAX_BYTES
};

const fetchImpl: AttachmentFetch = async (url, init) => {
  const method: 'GET' = init.method;
  const redirect: 'manual' = init.redirect;
  const signal: AbortSignal = init.signal;
  void method;
  void redirect;
  void signal;
  return { ok: true, status: 200, url, headers: { get: () => null }, body: null };
};
const options: AgentAttachmentOptions = {
  fetchImpl,
  signal: null,
  timeoutMs: 1000,
  deadline: null,
  botId: 'bot-1'
};
const allowed: boolean = attachmentUrlAllowed(attachment.url);
const wire: Promise<string> = fetchAgentAttachment(attachment, options);
const normalized = normalizeAgentMessage(
  { author: { id: 'bot-1', bot: true } },
  { content: '', attachments: [attachment] },
  options
);

void allowed;
void wire;
void normalized;
