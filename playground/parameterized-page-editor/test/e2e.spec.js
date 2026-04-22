import { test, expect } from '@playwright/test';
import { createStaticServer } from './helpers/static-server.js';

let server;
const HERO_HTML = '<!doctype html><html lang="en"><body><section class="hero"><h1 class="hero-title">Arcana Editor</h1><p>Selection scaffold</p></section></body></html>';
const INSPECTOR_HTML = `
<!doctype html>
<html lang="en">
  <body>
    <section class="hero" style="background-color: rgb(250, 240, 230); margin: 12px; padding: 8px;">
      <h1 class="hero-title">Arcana Editor</h1>
      <a class="hero-link" href="/pricing" target="_blank">See pricing</a>
      <img class="hero-image" src="/hero.png" alt="Hero image" width="640" height="360">
      <div class="hero-shell"><span>Nested content</span></div>
    </section>
  </body>
</html>
`;

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
  const resetButton = page.getByRole('button', { name: 'Reset' });

  await expect(page.getByRole('heading', { name: 'Parameterized Page Editor' })).toBeVisible();
  await expect(htmlFileInput).toBeVisible();
  await expect(manifestFileInput).toBeVisible();
  await expect(page.getByTitle('Preview canvas')).toBeVisible();
  await expect(applyButton).toBeDisabled();
  await expect(resetButton).toBeDisabled();
  await expect(page.locator('#preview-frame')).toHaveAttribute('sandbox', 'allow-same-origin');

  await htmlFileInput.setInputFiles({
    name: 'sample.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<!doctype html><html lang="en"><body><h2>Loaded Preview</h2></body></html>'),
  });

  await expect(applyButton).toBeDisabled();
  await expect(resetButton).toBeDisabled();
  await expect(page.locator('#status-output')).toContainText('HTML loaded. Click a preview element to inspect it and edit its common properties.');

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

  await expect(applyButton).toBeDisabled();
  await expect(resetButton).toBeDisabled();
  await expect(page.locator('#status-output')).toContainText('Manifest loaded. Click a preview element to edit it.');
});

test('selects an element and shows inspector sections', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'hero.html',
    mimeType: 'text/html',
    buffer: Buffer.from(HERO_HTML),
  });

  const previewFrame = page.frameLocator('#preview-frame');
  const contentSection = page.locator('#panel-root details[data-section-key="content"][open]');
  const layoutSection = page.locator('#panel-root details[data-section-key="layout"][open]');
  const styleSection = page.locator('#panel-root details[data-section-key="style"][open]');

  await previewFrame.locator('h1.hero-title').click();

  await expect(page.locator('#status-output')).toContainText('Selected: h1.hero-title');
  await expect(page.locator('#panel-root')).toContainText('h1.hero-title');
  await expect(page.locator('#panel-root')).toContainText('Tag: h1 · 1 captured attributes');
  await expect(page.locator('#panel-root')).toContainText('Content');
  await expect(page.locator('#panel-root')).toContainText('Layout');
  await expect(page.locator('#panel-root')).toContainText('Style');
  await expect(page.locator('#panel-root')).toContainText('Attributes');
  await expect(page.locator('#panel-root')).toContainText('Advanced');
  await expect(page.locator('#panel-root details[open] summary')).toHaveText(['Content', 'Layout', 'Style']);
  await expect(page.locator('#panel-root summary')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Apply' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Reset' })).toBeEnabled();
  await expect(contentSection.locator('[data-field-key="text"]')).toHaveValue('Arcana Editor');
  await expect(layoutSection.locator('[data-field-key="display"]')).toHaveValue('');
  await expect(layoutSection.locator('[data-field-key="visibility"]')).toHaveValue('');
  await expect(layoutSection).toContainText('Spacing');
  await expect(styleSection.locator('[data-field-key="textColor"]')).toHaveValue('');
  await expect(styleSection.locator('[data-field-key="background"]')).toHaveValue('');
  await expect(styleSection.locator('[data-field-key="classNames"]')).toHaveValue('hero-title');
  await expect(page.locator('#panel-root')).toContainText('class');
  await expect(page.locator('#panel-root')).not.toContainText('data-arcana-selected-element');
});

test('derives link fields', async ({ page }) => {
  await page.goto(server.url + '/index.html');
  const contentSection = page.locator('#panel-root details[data-section-key="content"][open]');
  const styleSection = page.locator('#panel-root details[data-section-key="style"][open]');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });

  await page.frameLocator('#preview-frame').locator('a.hero-link').click();

  await expect(page.locator('#status-output')).toContainText('Selected: a.hero-link');
  await expect(page.locator('#panel-root')).toContainText('Tag: a · 3 captured attributes');
  await expect(contentSection.locator('[data-field-key="text"]')).toHaveValue('See pricing');
  await expect(contentSection.locator('[data-field-key="href"]')).toHaveValue('/pricing');
  await expect(contentSection.locator('[data-field-key="target"]')).toHaveValue('_blank');
  await expect(styleSection.locator('[data-field-key="classNames"]')).toHaveValue('hero-link');
});

test('derives image fields', async ({ page }) => {
  await page.goto(server.url + '/index.html');
  const contentSection = page.locator('#panel-root details[data-section-key="content"][open]');
  const layoutSection = page.locator('#panel-root details[data-section-key="layout"][open]');
  const styleSection = page.locator('#panel-root details[data-section-key="style"][open]');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });

  await page.frameLocator('#preview-frame').locator('img.hero-image').click();

  await expect(page.locator('#status-output')).toContainText('Selected: img.hero-image');
  await expect(page.locator('#panel-root')).toContainText('Tag: img · 5 captured attributes');
  await expect(contentSection.locator('[data-field-key="src"]')).toHaveValue('/hero.png');
  await expect(contentSection.locator('[data-field-key="alt"]')).toHaveValue('Hero image');
  await expect(layoutSection.locator('[data-field-key="width"]')).toHaveValue('640');
  await expect(layoutSection.locator('[data-field-key="height"]')).toHaveValue('360');
  await expect(styleSection.locator('[data-field-key="classNames"]')).toHaveValue('hero-image');
});

test('derives container fields', async ({ page }) => {
  await page.goto(server.url + '/index.html');
  const contentSection = page.locator('#panel-root details[data-section-key="content"][open]');
  const layoutSection = page.locator('#panel-root details[data-section-key="layout"][open]');
  const styleSection = page.locator('#panel-root details[data-section-key="style"][open]');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });

  await page.frameLocator('#preview-frame').locator('div.hero-shell').click();

  await expect(page.locator('#status-output')).toContainText('Selected: div.hero-shell');
  await expect(page.locator('#panel-root')).toContainText('Tag: div · 1 captured attributes');
  await expect(contentSection).toContainText('No common content fields for this element type.');
  await expect(layoutSection.locator('[data-field-key="display"]')).toHaveValue('');
  await expect(layoutSection.locator('[data-field-key="visibility"]')).toHaveValue('');
  await expect(layoutSection).toContainText('Spacing');
  await expect(styleSection.locator('[data-field-key="background"]')).toHaveValue('');
  await expect(styleSection.locator('[data-field-key="classNames"]')).toHaveValue('hero-shell');
  await expect(contentSection).not.toContainText('Href');
  await expect(contentSection).not.toContainText('Src');
  await expect(contentSection).not.toContainText('Alt');
  await expect(styleSection).not.toContainText('Href');
  await expect(styleSection).not.toContainText('Src');
  await expect(styleSection).not.toContainText('Alt');
});

test('surfaces manifest errors after selection', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'hero.html',
    mimeType: 'text/html',
    buffer: Buffer.from(HERO_HTML),
  });

  await page.frameLocator('#preview-frame').locator('h1.hero-title').click();
  await expect(page.locator('#status-output')).toContainText('Selected: h1.hero-title');

  await page.getByLabel('Manifest file (optional)').setInputFiles({
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ invalid json'),
  });

  await expect(page.locator('#status-output')).toContainText('Manifest file must contain valid JSON.');
});

test('clears selection when reloading the same html', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  const htmlFileInput = page.getByLabel('HTML file');
  const previewHeading = page.frameLocator('#preview-frame').locator('h1.hero-title');

  await htmlFileInput.setInputFiles({
    name: 'hero.html',
    mimeType: 'text/html',
    buffer: Buffer.from(HERO_HTML),
  });

  await previewHeading.click();
  await expect(previewHeading).toHaveAttribute('data-arcana-selected-element', 'true');
  await expect(page.locator('#status-output')).toContainText('Selected: h1.hero-title');

  await htmlFileInput.setInputFiles({
    name: 'hero.html',
    mimeType: 'text/html',
    buffer: Buffer.from(HERO_HTML),
  });

  await expect(previewHeading).not.toHaveAttribute('data-arcana-selected-element', 'true');
  await expect(page.locator('#status-output')).toContainText('HTML loaded. Click a preview element to inspect it and edit its common properties.');
  await expect(page.locator('#panel-root')).not.toContainText('h1.hero-title');
});

test('applies heading text edits without a manifest and reset reloads live dom values', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });

  await page.frameLocator('#preview-frame').locator('h1.hero-title').click();
  await page.locator('[data-field-key="text"]').fill('Arcana Launch');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.frameLocator('#preview-frame').locator('h1.hero-title')).toHaveText('Arcana Launch');
  await expect(page.locator('[data-field-key="text"]')).toHaveValue('Arcana Launch');

  await page.locator('[data-field-key="text"]').fill('Unsaved text');
  await page.getByRole('button', { name: 'Reset' }).click();

  await expect(page.locator('[data-field-key="text"]')).toHaveValue('Arcana Launch');
});

test('applies link href, image alt, and class name edits directly to the preview dom', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });

  await page.frameLocator('#preview-frame').locator('a.hero-link').click();
  await page.locator('[data-field-key="href"]').fill('/docs');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.frameLocator('#preview-frame').locator('a.hero-link')).toHaveAttribute('href', '/docs');

  await page.frameLocator('#preview-frame').locator('img.hero-image').click();
  await page.locator('[data-field-key="alt"]').fill('Updated alt');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.frameLocator('#preview-frame').locator('img.hero-image')).toHaveAttribute('alt', 'Updated alt');

  await page.frameLocator('#preview-frame').locator('div.hero-shell').click();
  await page.locator('[data-field-key="classNames"]').fill('hero-shell shell-updated');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.frameLocator('#preview-frame').locator('div.hero-shell')).toHaveAttribute('class', 'hero-shell shell-updated');
});
