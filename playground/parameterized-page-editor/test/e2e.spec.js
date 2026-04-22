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
  const manifestFileInput = page.getByLabel('Manifest file (optional)');
  const applyButton = page.getByRole('button', { name: 'Apply' });

  await expect(page.getByRole('heading', { name: 'Parameterized Page Editor' })).toBeVisible();
  await expect(htmlFileInput).toBeVisible();
  await expect(manifestFileInput).toBeVisible();
  await expect(page.getByTitle('Preview canvas')).toBeVisible();
  await expect(applyButton).toBeDisabled();
  await expect(page.locator('#preview-frame')).toHaveAttribute('sandbox', 'allow-same-origin');

  await htmlFileInput.setInputFiles({
    name: 'sample.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<!doctype html><html lang="en"><body><h2>Loaded Preview</h2></body></html>'),
  });

  await manifestFileInput.setInputFiles({
    name: 'sample.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      title: 'Sample Manifest',
      schema: {
        type: 'object',
        properties: {
          headline: {
            type: 'string',
          },
        },
      },
      bindings: [
        {
          field: 'headline',
          selector: '.hero-title',
          op: 'setText',
        },
      ],
    })),
  });

  await expect(applyButton).toBeEnabled();
  await expect(page.locator('#status-output')).toContainText('HTML and manifest loaded. Apply is ready.');
});

test('selects an element and shows inspector sections', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'hero.html',
    mimeType: 'text/html',
    buffer: Buffer.from(
      '<!doctype html><html lang="en"><body><section class="hero"><h1 class="hero-title">Arcana Editor</h1><p>Selection scaffold</p></section></body></html>',
    ),
  });

  const previewFrame = page.frameLocator('#preview-frame');

  await previewFrame.locator('h1.hero-title').click();

  await expect(page.locator('#status-output')).toContainText('Selected: h1.hero-title');
  await expect(page.locator('#panel-root')).toContainText('h1.hero-title');
  await expect(page.locator('#panel-root')).toContainText('Content');
  await expect(page.locator('#panel-root')).toContainText('Layout');
  await expect(page.locator('#panel-root')).toContainText('Style');
  await expect(page.locator('#panel-root')).toContainText('Attributes');
  await expect(page.locator('#panel-root')).toContainText('Advanced');
  await expect(page.locator('#panel-root details[open]')).toHaveCount(3);
  await expect(page.locator('#panel-root summary')).toHaveCount(5);
});
