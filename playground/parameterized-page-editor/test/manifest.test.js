import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManifest } from '../src/manifest.js';

test('normalizeManifest accepts a valid manifest and fills missing ui defaults', () => {
  const manifest = normalizeManifest({
    version: 1,
    title: 'Landing Page Controls',
    schema: {
      type: 'object',
      properties: {
        heroTitle: { type: 'string', title: 'Hero Title', default: 'Build faster' }
      }
    },
    bindings: [
      { field: 'heroTitle', selector: '.hero-title', op: 'setText' }
    ]
  });

  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.ui, { order: ['heroTitle'], sections: [] });
  assert.equal(manifest.bindings[0].field, 'heroTitle');
});

test('normalizeManifest rejects bindings that reference an unknown field', () => {
  assert.throws(
    () => normalizeManifest({
      version: 1,
      title: 'Broken',
      schema: { type: 'object', properties: {} },
      bindings: [{ field: 'missing', selector: '.hero-title', op: 'setText' }]
    }),
    /Unknown field "missing"/
  );
});

test('normalizeManifest rejects unsupported operation names', () => {
  assert.throws(
    () => normalizeManifest({
      version: 1,
      title: 'Broken',
      schema: {
        type: 'object',
        properties: { heroTitle: { type: 'string' } }
      },
      bindings: [{ field: 'heroTitle', selector: '.hero-title', op: 'runScript' }]
    }),
    /Unsupported operation "runScript"/
  );
});
