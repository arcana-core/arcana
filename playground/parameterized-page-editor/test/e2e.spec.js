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

  await expect(page.getByRole('heading', { name: 'Parameterized Page Editor' })).toBeVisible();
  await expect(page.getByLabel('HTML file')).toBeVisible();
  await expect(page.getByLabel('Manifest file')).toBeVisible();
  await expect(page.getByTitle('Preview canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled();
});
