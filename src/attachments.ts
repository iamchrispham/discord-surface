export interface Attachment {
  url: string;
  filename: string;
  contentType: string | null;
  size: number;
}

export function normalizeAttachments(value: unknown): Attachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new TypeError('attachments must be an array');
  if (value.length > 25) throw new TypeError('attachments must contain at most 25 items');
  return value.map((input: unknown, index): Attachment => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`attachment ${index} must be an object`);
    const attachment = input as Record<string, unknown>;
    const url = attachment.url;
    if (typeof url !== 'string' || url.length === 0 || url.length > 2048 || /[\u0000-\u001f\u007f]/.test(url)) throw new TypeError(`attachment ${index} url is invalid`);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new TypeError(`attachment ${index} url is invalid`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError(`attachment ${index} url must be an http or https URL`);
    const filename = attachment.filename;
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) throw new TypeError(`attachment ${index} filename is invalid`);
    const contentType = attachment.contentType === undefined || attachment.contentType === null ? null : attachment.contentType;
    if (contentType !== null && (typeof contentType !== 'string' || contentType.length === 0 || contentType.length > 255 || /[\u0000-\u001f\u007f]/.test(contentType))) throw new TypeError(`attachment ${index} contentType is invalid`);
    // isSafeInteger does not narrow unknown; retain the original property reads.
    if (!Number.isSafeInteger(attachment.size) || (attachment.size as number) < 0) throw new TypeError(`attachment ${index} size is invalid`);
    return { url, filename, contentType, size: attachment.size as number };
  });
}
