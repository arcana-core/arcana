import { test, expect } from '@playwright/test';
import { createStaticServer } from './helpers/static-server.js';

let server;
const HERO_HTML = '<!doctype html><html lang="en"><body><section class="hero"><h1 class="hero-title">Arcana Editor</h1><p>Selection scaffold</p></section></body></html>';
const INSPECTOR_HTML = `
<!doctype html>
<html lang="en">
  <head>
    <style>
      .start-subtitle {
        font-size: 14px;
        opacity: 0.85;
        font-family: Georgia, serif;
        font-weight: 700;
        text-align: center;
        line-height: 1.6;
        letter-spacing: 0.18em;
      }
    </style>
  </head>
  <body>
    <section class="hero" style="background-color: rgb(250, 240, 230); margin: 12px; padding: 8px;">
      <h1 class="hero-title">Arcana Editor</h1>
      <a class="hero-link" href="/pricing" target="_blank">See pricing</a>
      <img class="hero-image" src="/hero.png" alt="Hero image" width="640" height="360">
      <div class="start-subtitle">明宫残卷</div>
      <div class="hero-shell"><span>Nested content</span></div>
    </section>
  </body>
</html>
`;
const CURATED_MANIFEST = {
  title: 'Curated Overlay',
  schema: {
    type: 'object',
    properties: {
      headline: {
        type: 'string',
        title: 'Hero Headline',
      },
      tone: {
        type: 'string',
        title: 'Tone',
      },
      accent: {
        type: 'string',
        title: 'Accent Color',
      },
    },
  },
  ui: {
    order: ['tone', 'headline', 'accent'],
  },
  bindings: [
    {
      field: 'headline',
      selector: '.hero-title',
      op: 'setText',
    },
    {
      field: 'headline',
      selector: '.hero-title',
      op: 'setAttribute',
      target: 'aria-label',
    },
    {
      field: 'tone',
      selector: '.hero-title',
      op: 'setAttribute',
      target: 'data-tone',
    },
    {
      field: 'accent',
      selector: '.hero-title',
      op: 'setStyle',
      target: 'color',
    },
  ],
};

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

test('derives editable text for plain-text div containers', async ({ page }) => {
  await page.goto(server.url + '/index.html');
  const contentSection = page.locator('#panel-root details[data-section-key="content"][open]');
  const advancedSection = page.locator('#panel-root details[data-section-key="advanced"]');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });

  await page.frameLocator('#preview-frame').locator('div.start-subtitle').click();

  await expect(page.locator('#status-output')).toContainText('Selected: div.start-subtitle');
  await expect(contentSection.locator('[data-field-key="text"]')).toHaveValue('明宫残卷');
  await advancedSection.locator('summary').click();
  await expect(advancedSection.locator('[data-field-key="style:font-size"]')).toHaveAttribute('placeholder', 'Current: 14px');
  await expect(advancedSection.locator('[data-field-key="style:opacity"]')).toHaveAttribute('placeholder', 'Current: 0.85');
  await expect(advancedSection.locator('[data-field-key="style:font-family"]')).toHaveAttribute('placeholder', 'Current: Georgia, serif');
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

test('applies text edits to plain-text div containers', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });

  await page.frameLocator('#preview-frame').locator('div.start-subtitle').click();
  await page.locator('[data-field-key="text"]').fill('紫禁疑云');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.frameLocator('#preview-frame').locator('div.start-subtitle')).toHaveText('紫禁疑云');
});

test('expands advanced editing, applies advanced and attribute fields, and reset reloads live dom values', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });

  await page.frameLocator('#preview-frame').locator('h1.hero-title').click();

  const attributesSection = page.locator('#panel-root details[data-section-key="attributes"]');
  const advancedSection = page.locator('#panel-root details[data-section-key="advanced"]');
  const previewTitle = page.frameLocator('#preview-frame').locator('h1.hero-title');

  await expect(attributesSection).not.toHaveAttribute('open', '');
  await expect(advancedSection).not.toHaveAttribute('open', '');

  await attributesSection.locator('summary').click();
  await advancedSection.locator('summary').click();

  await expect(attributesSection).toHaveAttribute('open', '');
  await expect(advancedSection).toHaveAttribute('open', '');

  await attributesSection.locator('[data-field-key="attr:title"]').fill('Launch title');
  await advancedSection.locator('[data-field-key="style:font-size"]').fill('3rem');
  await advancedSection.locator('[data-field-key="style:font-family"]').fill('KaiTi, serif');
  await advancedSection.locator('[data-field-key="style:opacity"]').fill('0.92');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(previewTitle).toHaveAttribute('title', 'Launch title');
  await expect(previewTitle).toHaveCSS('font-size', '48px');
  await expect(previewTitle).toHaveCSS('opacity', '0.92');
  await expect(previewTitle).toHaveAttribute('style', /font-family:\s*KaiTi,\s*serif/i);
  await expect(attributesSection.locator('[data-field-key="attr:title"]')).toHaveValue('Launch title');
  await expect(advancedSection.locator('[data-field-key="style:font-size"]')).toHaveValue('3rem');
  await expect(advancedSection.locator('[data-field-key="style:font-family"]')).toHaveValue('KaiTi, serif');
  await expect(advancedSection.locator('[data-field-key="style:opacity"]')).toHaveValue('0.92');

  await attributesSection.locator('[data-field-key="attr:title"]').fill('Unsaved title');
  await advancedSection.locator('[data-field-key="style:font-size"]').fill('1.5rem');
  await advancedSection.locator('[data-field-key="style:font-family"]').fill('FangSong, serif');
  await page.getByRole('button', { name: 'Reset' }).click();

  await expect(attributesSection.locator('[data-field-key="attr:title"]')).toHaveValue('Launch title');
  await expect(advancedSection.locator('[data-field-key="style:font-size"]')).toHaveValue('3rem');
  await expect(advancedSection.locator('[data-field-key="style:font-family"]')).toHaveValue('KaiTi, serif');
});

test('keeps html-only editing working when no manifest is loaded', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });

  await page.frameLocator('#preview-frame').locator('h1.hero-title').click();

  await expect(page.locator('#panel-root details[data-section-key="curated"]')).toHaveCount(0);
  await page.locator('#panel-root details[data-section-key="content"][open] [data-field-key="text"]').fill('HTML Only');
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.frameLocator('#preview-frame').locator('h1.hero-title')).toHaveText('HTML Only');
});

test('shows curated controls only for bound selections when a manifest is loaded', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });
  await page.getByLabel('Manifest file (optional)').setInputFiles({
    name: 'curated.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(CURATED_MANIFEST)),
  });

  await page.frameLocator('#preview-frame').locator('h1.hero-title').click();

  const curatedSection = page.locator('#panel-root details[data-section-key="curated"]');
  await expect(curatedSection).toBeVisible();
  await expect(curatedSection).toContainText('Curated');
  await expect(curatedSection.locator('[data-field-key="curated:tone"]')).toHaveValue('');
  await expect(curatedSection.locator('[data-field-key="curated:headline"]')).toHaveValue('Arcana Editor');
  await expect(curatedSection.locator('[data-field-key="curated:accent"]')).toHaveValue('');
  await expect(curatedSection.locator('.inspector-term')).toHaveText(['Tone', 'Hero Headline', 'Accent Color']);

  await page.frameLocator('#preview-frame').locator('div.hero-shell').click();
  await expect(page.locator('#panel-root details[data-section-key="curated"]')).toHaveCount(0);
});

test('clears curated controls when the manifest is removed', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });
  await page.getByLabel('Manifest file (optional)').setInputFiles({
    name: 'curated.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(CURATED_MANIFEST)),
  });

  await page.frameLocator('#preview-frame').locator('h1.hero-title').click();
  await expect(page.locator('#panel-root details[data-section-key="curated"]')).toBeVisible();

  await page.getByLabel('Manifest file (optional)').setInputFiles([]);

  await expect(page.locator('#panel-root details[data-section-key="curated"]')).toHaveCount(0);
  await expect(page.locator('#status-output')).toContainText('Selected: h1.hero-title');
});

test('applies curated text, attribute, and style values to the selected preview element', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });
  await page.getByLabel('Manifest file (optional)').setInputFiles({
    name: 'curated.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(CURATED_MANIFEST)),
  });

  await page.frameLocator('#preview-frame').locator('h1.hero-title').click();

  await page.locator('[data-field-key="curated:tone"]').fill('warm');
  await page.locator('[data-field-key="curated:headline"]').fill('Curated Launch');
  await page.locator('[data-field-key="curated:accent"]').fill('royalblue');
  await page.getByRole('button', { name: 'Apply' }).click();

  const previewTitle = page.frameLocator('#preview-frame').locator('h1.hero-title');
  await expect(previewTitle).toHaveText('Curated Launch');
  await expect(previewTitle).toHaveAttribute('aria-label', 'Curated Launch');
  await expect(previewTitle).toHaveAttribute('data-tone', 'warm');
  await expect(previewTitle).toHaveCSS('color', 'rgb(65, 105, 225)');
});

test('exports editor state and imports it with and without a manifest', async ({ page }) => {
  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });
  await page.getByLabel('Manifest file (optional)').setInputFiles({
    name: 'curated.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(CURATED_MANIFEST)),
  });

  await page.frameLocator('#preview-frame').locator('h1.hero-title').click();

  const attributesSection = page.locator('#panel-root details[data-section-key="attributes"]');
  const stateArea = page.getByLabel('Saved editor state JSON');

  await expect(attributesSection).not.toHaveAttribute('open', '');
  await attributesSection.locator('summary').click();
  await expect(attributesSection).toHaveAttribute('open', '');

  await page.locator('[data-field-key="attr:title"]').fill('Saved title');
  await page.locator('[data-field-key="curated:tone"]').fill('ember');
  await page.locator('[data-field-key="curated:headline"]').fill('Saved curated headline');
  await page.getByRole('button', { name: 'Apply' }).click();

  await page.getByRole('button', { name: 'Export state' }).click();
  await expect(stateArea).toHaveValue(/"defaultValues"/);
  await expect(stateArea).toHaveValue(/"curatedValues"/);
  await expect(stateArea).toHaveValue(/"selectedInspectorSections"/);
  const exportedState = await stateArea.inputValue();

  await page.getByRole('button', { name: 'Import state' }).click();

  const previewTitle = page.frameLocator('#preview-frame').locator('h1.hero-title');
  await expect(previewTitle).toHaveText('Saved curated headline');
  await expect(previewTitle).toHaveAttribute('aria-label', 'Saved curated headline');
  await expect(previewTitle).toHaveAttribute('data-tone', 'ember');
  await expect(previewTitle).toHaveAttribute('title', 'Saved title');
  await expect(page.locator('[data-field-key="attr:title"]')).toHaveValue('Saved title');
  await expect(attributesSection).toHaveAttribute('open', '');
  await expect(page.locator('#status-output')).toContainText('Imported saved state');

  await page.goto(server.url + '/index.html');

  await page.getByLabel('HTML file').setInputFiles({
    name: 'inspector.html',
    mimeType: 'text/html',
    buffer: Buffer.from(INSPECTOR_HTML),
  });
  await page.frameLocator('#preview-frame').locator('h1.hero-title').click();
  await page.locator('#panel-root details[data-section-key="attributes"] summary').click();
  await page.locator('[data-field-key="attr:title"]').fill('Temporary title');
  await page.getByRole('button', { name: 'Apply' }).click();

  await stateArea.fill(exportedState);
  await page.getByRole('button', { name: 'Import state' }).click();

  const htmlOnlyTitle = page.frameLocator('#preview-frame').locator('h1.hero-title');
  const htmlOnlyAttributesSection = page.locator('#panel-root details[data-section-key="attributes"]');
  await expect(page.locator('#panel-root details[data-section-key="curated"]')).toHaveCount(0);
  await expect(htmlOnlyTitle).toHaveText('Saved curated headline');
  await expect(htmlOnlyTitle).toHaveAttribute('title', 'Saved title');
  await expect(page.locator('[data-field-key="attr:title"]')).toHaveValue('Saved title');
  await expect(htmlOnlyAttributesSection).toHaveAttribute('open', '');
  await expect(page.locator('#status-output')).toContainText('Skipped curated values because no manifest is loaded.');
});
