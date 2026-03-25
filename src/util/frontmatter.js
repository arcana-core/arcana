// Minimal YAML frontmatter parser used by Arcana runtime.
// Avoid importing the full pi-coding-agent stack inside isolated tool sandboxes.
//
// Format:
// ---\n<yaml>\n---\n<body>

import YAML from 'yaml';

export function parseFrontmatter(raw){
  const text = String(raw || '');
  // Must start at beginning.
  if (!text.startsWith('---')){
    return { frontmatter: {}, body: text };
  }

  // Find the closing '---' on its own line.
  // Accept both \n and \r\n.
  const lines = text.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---'){
    return { frontmatter: {}, body: text };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++){
    if (lines[i].trim() === '---'){
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1){
    return { frontmatter: {}, body: text };
  }

  const yamlText = lines.slice(1, endIdx).join('\n');
  const body = lines.slice(endIdx + 1).join('\n');

  let frontmatter = {};
  try {
    const parsed = YAML.parse(yamlText);
    if (parsed && typeof parsed === 'object') frontmatter = parsed;
  } catch {
    frontmatter = {};
  }

  return { frontmatter, body };
}

export default { parseFrontmatter };
