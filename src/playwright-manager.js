// Compatibility layer: prefer using ./pw-runtime.js
// This file provides a minimal, stable API that maps to pw-runtime,
// which is the canonical Playwright implementation in Arcana.

import * as pw from "./pw-runtime.js";

let running = false;

export async function ensurePlaywright() {
  return pw.ensure();
}

export async function startBrowser() {
  await pw.start();
  running = true;
  return { running };
}

export async function stopBrowser() {
  await pw.close();
  running = false;
  return { running };
}

export async function navigate({ targetUrl, waitUntil = "networkidle", timeoutMs = 30000 }) {
  return pw.navigate(targetUrl, { waitUntil, timeoutMs });
}

export async function extract({ maxChars, autoScroll } = {}) {
  return pw.extract({ maxChars, autoScroll });
}

export function status() {
  return { running };
}

// Not supported in this shim without exposing the underlying Page.
export async function openTab() { throw new Error("not_supported"); }
export async function screenshot() { throw new Error("not_supported"); }
export async function scroll() { throw new Error("not_supported"); }

export default {
  ensurePlaywright,
  startBrowser,
  stopBrowser,
  navigate,
  extract,
  status,
  openTab,
  screenshot,
  scroll,
};
