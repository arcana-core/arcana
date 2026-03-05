// Lightweight memory trigger helpers inspired by OpenClaw-style signals.
// ASCII code, but includes a few Chinese keywords in literals for detection.

// Truncate a string to a max length, keeping head and tail with an ellipsis when needed.
export function truncateText(input, max = 800) {
  const s = String(input == null ? "" : input);
  const limit = Math.max(16, Math.floor(max));
  if (s.length <= limit) return s;
  const head = Math.max(8, Math.floor(limit * 0.6));
  const tail = Math.max(8, limit - head - 1);
  return s.slice(0, head).trimEnd() + " … " + s.slice(s.length - tail).trimStart();
}

// Conservative detection of problem/issue mentions in user text.
// Keywords include both Chinese and English terms commonly used when reporting issues.
export function detectProblemMention(text) {
  const t = String(text || "");
  if (!t) return false;
  const tLower = t.toLowerCase();
  // English tokens: use word boundaries to reduce false positives.
  const en = /\b(?:bug|error|failed|crash|incorrect|wrong|timeout)\b/.test(tLower);
  // Chinese tokens: simple substring match (no word boundaries in typical usage).
  const zh = /问题|报错|失败|不工作|异常/.test(t);
  return en || zh;
}

export function detectCorrectionMention(text) {
  const t = String(text || "");
  if (!t) return false;
  const tLower = t.toLowerCase();
  // English tokens: corrections/negative feedback about prior answer.
  const en = /\b(?:correction|correct answer is|that's wrong|that is wrong|is wrong|not correct|you (?:are|were) wrong|you got (?:it )?wrong|should be [^.\n]*\bnot\b)\b/.test(tLower);
  // Chinese tokens: common ways to say the assistant was wrong or needs correction.
  const zh = /不对|错了|不是这样|纠正|更正|修正/.test(t);
  return en || zh;
}

export default { detectProblemMention, detectCorrectionMention, truncateText };

