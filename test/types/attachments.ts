import { normalizeAttachments, type Attachment } from '../../src/attachments';

// Compile with strict + noEmit; this is not a runtime test.
export function typecheckAttachments(input: unknown): Attachment[] {
  const attachments = normalizeAttachments(input);
  for (const attachment of attachments) {
    // @ts-expect-error Validated size is a number, not a string.
    const text: string = attachment.size;
    void text;
    // @ts-expect-error contentType is still nullable after validation.
    attachment.contentType.toLowerCase();
  }
  return attachments;
}
