import {
  deserializeReplyContext,
  isSnowflakeId,
  normalizeReplyContext,
  serializeReplyContext,
  truncateExcerpt,
  type ReplyContext
} from '../../src/reply-context';

// Compile with strict + noEmit; this is not a runtime test.
export function typecheckReplyContext(candidate: unknown, stored: unknown): void {
  // Positive compile-checks: each helper's declared return shape.
  const normalized: ReplyContext | null = normalizeReplyContext(candidate);
  const serialized: string | null = serializeReplyContext(candidate);
  const hydrated: ReplyContext | null = deserializeReplyContext(stored);
  const excerpt: string | null = truncateExcerpt(candidate);

  if (normalized) {
    // The five canonical fields have exactly these types.
    const messageId: string = normalized.messageId;
    const channelId: string = normalized.channelId;
    const guildId: string = normalized.guildId;
    const excerptText: string = normalized.excerpt;
    const isBotAuthor: boolean | null = normalized.isBotAuthor;
    void messageId;
    void channelId;
    void guildId;
    void excerptText;
    void isBotAuthor;
  }

  // isSnowflakeId narrows unknown to string.
  if (isSnowflakeId(candidate)) {
    const narrowed: string = candidate;
    void narrowed;
  }

  void serialized;
  void hydrated;
  void excerpt;

  // Negative compile-checks: ids and excerpt are strings, not numbers.
  const numericMessageId: ReplyContext = {
    // @ts-expect-error messageId is a string, not a number.
    messageId: 1,
    channelId: '2',
    guildId: '3',
    excerpt: 'text',
    isBotAuthor: null
  };

  const numericExcerpt: ReplyContext = {
    messageId: '1',
    channelId: '2',
    guildId: '3',
    // @ts-expect-error excerpt is a string, not a number.
    excerpt: 4,
    isBotAuthor: null
  };

  // Negative compile-check: isBotAuthor is boolean | null, not string.
  const stringIsBotAuthor: ReplyContext = {
    messageId: '1',
    channelId: '2',
    guildId: '3',
    excerpt: 'text',
    // @ts-expect-error isBotAuthor is boolean | null, not a string.
    isBotAuthor: 'yes'
  };

  // Negative compile-check: isBotAuthor is boolean | null, not number.
  const numericIsBotAuthor: ReplyContext = {
    messageId: '1',
    channelId: '2',
    guildId: '3',
    excerpt: 'text',
    // @ts-expect-error isBotAuthor is boolean | null, not a number.
    isBotAuthor: 0
  };

  void numericMessageId;
  void numericExcerpt;
  void stringIsBotAuthor;
  void numericIsBotAuthor;
}
