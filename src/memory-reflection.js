// Build a concise prompt for SOP extraction after a tool failure.
export function buildSopExtractionPrompt({ toolName, argsJson, errorText } = {}) {
  const t = String(toolName || 'unknown');
  const args = String(argsJson || '').slice(0, 1200);
  const err = String(errorText || '').slice(0, 2000);
  const lines = [
    'Internal Reflection - Tool Failure to SOP',
    '',
    'Goal: turn failure into a short, reusable SOP that prevents it next time; store in long-term memory.',
    '',
    'Inputs:',
    '- tool: ' + t,
    (args ? ('- args: ' + args) : ''),
    (err ? ('- error: ' + err) : ''),
    '',
    'Instructions:',
    '- Think of durable, actionable prevention steps: pre-checks, parameter validation, environment assumptions, retries/backoff, fallbacks, timeouts, required files/secrets.',
    '- Produce a very short SOP as bullets or a checklist, 3-7 lines, imperative tone. Do not include stack traces, secrets, or file paths.',
    '- Using the memory_append tool, write to target=longterm with heading "sop:<toolName>" and content being only the bullets.',
    '- Call memory_append once and do not output anything else.',
    'NO_REPLY'
  ].filter(Boolean).join('\n');
  return lines;
}
export default { buildSopExtractionPrompt };
