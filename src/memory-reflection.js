// Build a concise prompt for extracting abstract learnings after a tool failure.
export function buildSopExtractionPrompt({ toolName, argsJson, errorText } = {}) {
  const t = String(toolName || 'unknown');
  const args = String(argsJson || '').slice(0, 1200);
  const err = String(errorText || '').slice(0, 2000);
  const lines = [
    'Internal Reflection - Tool Failure to Learning Bullets',
    '',
    'Goal: turn this failure into a small, reusable learning that can be stored in long-term memory.',
    '',
    'Inputs (for your reasoning only):',
    '- tool: ' + t,
    (args ? ('- args: ' + args) : ''),
    (err ? ('- error: ' + err) : ''),
    '',
    'Instructions:',
    '- Focus on abstract, non-procedural patterns: what went wrong and why, not step-by-step commands.',
    '- Think about the most reusable signal from this failure (preconditions, environment, assumptions, typical mistakes).',
    '- Produce ONLY 1 to 3 bullet lines of the form: "- symptom=\"...\" cause=\"...\" next=\"...\"".',
    '- Each bullet must be a single line of plain text, compact and self-contained.',
    '- Do not mention specific tool names or memory file names; describe only general patterns.',
    '- Do not mention session IDs, model names, file paths, log snippets, or parameter dumps.',
    '- Do not include raw logs, stack traces, secrets, API keys, tokens, or any user-identifying data.',
    '- Do not wrap the output in markdown fences. Do not ask questions.',
    'NO_REPLY'
  ].filter(Boolean).join('\n');
  return lines;
}
export default { buildSopExtractionPrompt };
