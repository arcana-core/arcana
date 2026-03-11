import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function opError(message){
  const err = new Error(message || '1Password CLI command failed');
  err.code = 'op_failed';
  return err;
}

async function runOpJson(args, contextTag){
  const tag = String(contextTag || 'op');
  try {
    const { stdout } = await execFileAsync('op', args, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    const text = typeof stdout === 'string' ? stdout.trim() : String(stdout || '').trim();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw opError('1Password CLI returned invalid JSON for ' + tag);
    }
  } catch (e) {
    if (e && e.code === 'op_failed') throw e;
    throw opError('1Password CLI command failed for ' + tag);
  }
}

/**
 * Read a secret from 1Password via `op read <ref>`.
 * Returns the trimmed stdout on success, or an empty string on failure.
 * No logging or error propagation by design.
 */
export async function readOp(ref){
  const r = String(ref || '').trim();
  if (!r) return '';
  try {
    const { stdout } = await execFileAsync('op', ['read', r], { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
    if (typeof stdout === 'string') return stdout.trim();
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

// List available 1Password vaults; returns [{ id, name }, ...].
export async function opVaultList(){
  const data = await runOpJson(['vault', 'list', '--format', 'json'], 'vault_list');
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const v of data){
    if (!v || typeof v !== 'object') continue;
    const id = v.id || v.uuid || (v.vault && v.vault.id) || '';
    const name = v.name || (v.vault && v.vault.name) || '';
    const idStr = String(id || '').trim();
    const nameStr = String(name || '').trim();
    if (!idStr || !nameStr) continue;
    out.push({ id: idStr, name: nameStr });
  }
  return out;
}

// Create a password item: `op item create --category password --title <title> [--vault <vault>] password=<password> --format json`
export async function opItemCreatePassword({ title, password, vault }){
  const t = String(title || 'Arcana secret').trim() || 'Arcana secret';
  const args = ['item', 'create', '--category', 'password', '--title', t];
  const v = typeof vault === 'string' ? vault.trim() : '';
  if (v) args.push('--vault', v);
  args.push('password=' + String(password || ''));
  args.push('--format', 'json');
  return await runOpJson(args, 'item_create_password');
}

// Edit a password (or custom field) on an item: `op item edit <item> password=<password> --format json`
export async function opItemEditPassword({ item, password, field }){
  const id = String(item || '').trim();
  if (!id) throw opError('1Password item id is required');
  const key = String(field || 'password').trim() || 'password';
  const args = ['item', 'edit', id, key + '=' + String(password || ''), '--format', 'json'];
  return await runOpJson(args, 'item_edit_password');
}

export default { readOp, opVaultList, opItemCreatePassword, opItemEditPassword };
