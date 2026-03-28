#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generate build/icon.ico from an existing PNG if missing.
 * Priority search order:
 *  - packages/desktop/resources/icon.png
 *  - repoRoot/media/icon.png
 *  - repoRoot/rounded_mask_v2.png (fallback)
 */
async function main(){
  const cwd = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(cwd, '..');
  const buildDir = join(pkgRoot, 'build');
  const outIco = join(buildDir, 'icon.ico');

  if (existsSync(outIco)) return; // Nothing to do

  // Candidate PNGs
  const repoRoot = resolve(pkgRoot, '..', '..', '..');
  const candidates = [
    join(pkgRoot, 'resources', 'icon.png'),
    join(repoRoot, 'media', 'icon.png'),
    join(repoRoot, 'rounded_mask_v2.png'),
  ].filter(p => existsSync(p));

  if (!candidates.length){
    console.log('[generate-icon] No PNG source found; skipping icon generation.');
    return;
  }

  const srcPng = candidates[0];
  await import('png-to-ico').then(async ({ default: pngToIco }) => {
    const buf = readFileSync(srcPng);
    const ico = await pngToIco(buf);
    if (!existsSync(buildDir)) mkdirSync(buildDir, { recursive: true });
    writeFileSync(outIco, ico);
    console.log('[generate-icon] Wrote', outIco, 'from', srcPng);
  }).catch((err)=>{
    console.warn('[generate-icon] Failed to generate icon.ico:', err?.message || err);
  });
}

main();
