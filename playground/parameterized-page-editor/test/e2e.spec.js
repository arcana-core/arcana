import { test, expect } from '@playwright/test';
import { createStaticServer } from './helpers/static-server.js';

let server;

test.beforeAll(async () => {
  server = await createStaticServer(new URL('..', import.meta.url));
});

test.afterAll(async () => {
  await server?.close();
});

test('renders the standalone editor shell', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  const htmlFileInput = page.getByLabel('HTML file');
  const manifestFileInput = page.getByLabel('Manifest file');
  const applyButton = page.getByRole('button', { name: 'Apply' });

  await expect(page.getByRole('heading', { name: 'Parameterized Page Editor' })).toBeVisible();
  await expect(htmlFileInput).toBeVisible();
  await expect(manifestFileInput).toBeVisible();
  await expect(page.getByTitle('Preview canvas')).toBeVisible();
  await expect(applyButton).toBeDisabled();
  await expect(page.locator('#preview-frame')).toHaveAttribute('sandbox', '');

  await htmlFileInput.setInputFiles({
    name: 'sample.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<!doctype html><html lang="en"><body><h2>Loaded Preview</h2></body></html>'),
  });

  await manifestFileInput.setInputFiles({
    name: 'sample.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ title: 'Sample Manifest', fields: [] })),
  });

  await expect(applyButton).toBeEnabled();
  await expect(page.locator('#status-output')).toContainText('HTML and manifest loaded. Apply is ready.');
});
