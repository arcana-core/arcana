export const HEARTBEAT_TOKEN = 'HEARTBEAT_OK';

// Strip a leading heartbeat acknowledgement token from model output.
//
// If the text (after trimming, and after optionally removing a leading
// responsePrefix plus following whitespace) starts with the token
// (case-insensitive) and the remaining suffix length is <= ackMaxChars,
// the payload is treated as an ack-only message and an empty string is
// returned. Otherwise the original trimmed text is returned.
export function stripHeartbeatAck(
  text,
  { token = HEARTBEAT_TOKEN, ackMaxChars = 30, responsePrefix } = {},
) {
  const raw = text == null ? '' : String(text);
  const originalTrimmed = raw.trim();

  const normalizedToken = token == null ? '' : String(token);
  let maxChars = Number(ackMaxChars);
  if (!Number.isFinite(maxChars) || maxChars < 0) {
    maxChars = 30;
  }

  if (!originalTrimmed || !normalizedToken) {
    return { text: originalTrimmed, isAckOnly: false };
  }

  let candidate = originalTrimmed;

  if (responsePrefix != null && responsePrefix !== '') {
    const prefixStr = String(responsePrefix);
    if (candidate.startsWith(prefixStr)) {
      candidate = candidate.slice(prefixStr.length).trimStart();
    }
  }

  const lowerCandidate = candidate.toLowerCase();
  const lowerToken = normalizedToken.toLowerCase();

  if (!lowerCandidate.startsWith(lowerToken)) {
    return { text: originalTrimmed, isAckOnly: false };
  }

  const suffix = candidate.slice(normalizedToken.length);
  const suffixTrimmed = suffix.trim();

  if (suffixTrimmed.length <= maxChars) {
    return { text: '', isAckOnly: true };
  }

  return { text: originalTrimmed, isAckOnly: false };
}

export default { HEARTBEAT_TOKEN, stripHeartbeatAck };
