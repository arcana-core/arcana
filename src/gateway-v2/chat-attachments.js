function normalizeMimeType(raw){
  const value = String(raw || '').split(';')[0].trim().toLowerCase();
  return value || '';
}

function stripDataUrlPrefix(raw){
  const value = String(raw || '').trim();
  const match = /^data:([^;,]+)?(?:;[^,]*)?,([\s\S]+)$/i.exec(value);
  if (!match) {
    return { mimeType: '', base64: value };
  }
  return {
    mimeType: normalizeMimeType(match[1] || ''),
    base64: String(match[2] || '').trim(),
  };
}

function estimateBase64DecodedBytes(base64){
  const trimmed = String(base64 || '').trim();
  if (!trimmed) return 0;
  const padding = trimmed.endsWith('==') ? 2 : (trimmed.endsWith('=') ? 1 : 0);
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

function isValidBase64(value){
  const trimmed = String(value || '').trim();
  return !!trimmed && trimmed.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed);
}

export function normalizeChatAttachments(raw){
  if (!Array.isArray(raw)) return [];
  return raw.filter((item) => item && typeof item === 'object');
}

export function extractAttachmentImages(rawAttachments, options = {}){
  const attachments = normalizeChatAttachments(rawAttachments);
  if (!attachments.length) return [];

  const maxBytes = Number(options.maxBytes);
  const effectiveMaxBytes = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 10 * 1024 * 1024;
  const images = [];

  for (let i = 0; i < attachments.length; i += 1){
    const attachment = attachments[i];
    const mimeType = normalizeMimeType(attachment.mimeType || attachment.mime || '');
    const rawContent = attachment.content != null ? attachment.content : attachment.data;
    const stripped = stripDataUrlPrefix(rawContent);
    const contentMimeType = normalizeMimeType(stripped.mimeType || mimeType);
    const base64 = String(stripped.base64 || '').trim();
    const label = String(attachment.fileName || attachment.name || attachment.type || ('attachment-' + String(i + 1)));

    if (!contentMimeType.startsWith('image/')) {
      const err = new Error('Unsupported attachment type for ' + label + ': ' + (contentMimeType || 'unknown'));
      err.code = 'UNSUPPORTED_ATTACHMENT_TYPE';
      throw err;
    }
    if (!isValidBase64(base64)) {
      const err = new Error('Invalid attachment payload for ' + label);
      err.code = 'INVALID_ATTACHMENT_PAYLOAD';
      throw err;
    }

    const decodedBytes = estimateBase64DecodedBytes(base64);
    if (!decodedBytes || decodedBytes > effectiveMaxBytes) {
      const err = new Error('Attachment too large for ' + label);
      err.code = 'ATTACHMENT_TOO_LARGE';
      throw err;
    }

    images.push({ type: 'image', data: base64, mimeType: contentMimeType });
  }

  return images;
}

export function attachmentsToMediaRefs(rawAttachments){
  const attachments = normalizeChatAttachments(rawAttachments);
  if (!attachments.length) return [];
  const refs = [];
  for (let i = 0; i < attachments.length; i += 1){
    const attachment = attachments[i];
    const mimeType = normalizeMimeType(attachment.mimeType || attachment.mime || '');
    const rawContent = attachment.content != null ? attachment.content : attachment.data;
    const stripped = stripDataUrlPrefix(rawContent);
    const contentMimeType = normalizeMimeType(stripped.mimeType || mimeType);
    const base64 = String(stripped.base64 || '').trim();
    if (!contentMimeType.startsWith('image/') || !isValidBase64(base64)) continue;
    refs.push('data:' + contentMimeType + ';base64,' + base64);
  }
  return refs;
}
