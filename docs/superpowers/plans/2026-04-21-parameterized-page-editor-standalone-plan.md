# Parameterized Page Editor Standalone Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone browser prototype that loads a local HTML file, lets the user click elements directly in a sandboxed preview, and shows a collapsible inspector with default editable properties plus an optional manifest-curated subset.

**Architecture:** Keep the prototype self-contained under `playground/parameterized-page-editor/` with no coupling to the existing Arcana chat UI. Make click-to-edit the primary workflow. Treat manifest validation and bindings as an optional overlay layer rather than a required prerequisite. Use plain HTML/CSS/ES modules, a small DOM-selection layer, a default inspector derivation layer, and Playwright coverage for selection and editing flows.

**Tech Stack:** Static HTML/CSS/JavaScript (ES modules), Node `node:test`, Playwright, built-in Node HTTP server utilities for local fixture serving

---

## File Structure

- `playground/parameterized-page-editor/index.html`
  - App shell with HTML import, optional manifest import, preview iframe, inspector mount point, and status region.
- `playground/parameterized-page-editor/styles.css`
  - Standalone layout, inspector styling, selection affordances, and collapsible sections.
- `playground/parameterized-page-editor/app.js`
  - App bootstrap and event wiring across preview loading, selection, inspector rendering, and apply behavior.
- `playground/parameterized-page-editor/src/state.js`
  - Session state for document text, selected element metadata, optional manifest, inspector values, and errors.
- `playground/parameterized-page-editor/src/manifest.js`
  - Optional manifest validation and normalization.
- `playground/parameterized-page-editor/src/selection.js`
  - Preview click/hover handling and selected element bookkeeping.
- `playground/parameterized-page-editor/src/default-inspector.js`
  - Common property derivation grouped into `Content`, `Layout`, `Style`, `Attributes`, and `Advanced`.
- `playground/parameterized-page-editor/src/apply-engine.js`
  - Direct selected-element edits and optional manifest binding execution.
- `playground/parameterized-page-editor/src/panel.js`
  - Collapsible inspector rendering for default and curated sections.
- `playground/parameterized-page-editor/test/manifest.test.js`
  - Unit tests for manifest validation and normalization.
- `playground/parameterized-page-editor/test/apply-engine.test.js`
  - Unit tests for apply helpers that do not need a browser.
- `playground/parameterized-page-editor/test/e2e.spec.js`
  - Playwright tests for shell, selection, default inspector editing, and optional manifest overlay.

## Task 1: Shell And Sandbox

Keep the existing Task 1 work. The shell is accepted once:

- preview iframe is sandboxed
- shell test uploads HTML and manifest files
- shell test verifies bootstrap logic instead of only static markup

Accepted commits already on branch:

- `e000757 feat: scaffold standalone parameterized page editor`
- `5bed2d7 fix: harden standalone editor shell scaffold`

No new work is required here unless later tasks expose a shell regression.

## Task 2: Optional Manifest Normalization

Keep manifest validation as an optional overlay input, not a gate.

This task is complete when:

- manifest upload is optional
- `normalizeManifest()` supports nested field paths robustly
- normalized `ui` always contains `order` and `sections`
- invalid manifests surface errors without blocking HTML-only editing

Currently in progress on this branch. It should remain focused on normalization only.

## Task 3: Element Selection And Inspector Scaffolding

**Files:**
- Create: `playground/parameterized-page-editor/src/selection.js`
- Modify: `playground/parameterized-page-editor/app.js`
- Modify: `playground/parameterized-page-editor/src/state.js`
- Modify: `playground/parameterized-page-editor/index.html`
- Modify: `playground/parameterized-page-editor/styles.css`
- Test: `playground/parameterized-page-editor/test/e2e.spec.js`

- [ ] Add preview click handling so the user can select an element without any manifest loaded.
- [ ] Store selected element metadata in state, including tag name, a stable descriptive label, and current editable values.
- [ ] Render an inspector shell with collapsible sections named:
  - `Content`
  - `Layout`
  - `Style`
  - `Attributes`
  - `Advanced`
- [ ] Make `Content`, `Layout`, and `Style` expanded by default.
- [ ] Make `Attributes` and `Advanced` collapsed by default.
- [ ] Add a Playwright test that loads HTML, clicks a visible element in the preview, and verifies the inspector becomes populated.

## Task 4: Default Inspector Derivation

**Files:**
- Create: `playground/parameterized-page-editor/src/default-inspector.js`
- Modify: `playground/parameterized-page-editor/src/state.js`
- Modify: `playground/parameterized-page-editor/src/panel.js`
- Test: `playground/parameterized-page-editor/test/apply-engine.test.js`
- Test: `playground/parameterized-page-editor/test/e2e.spec.js`

- [ ] Derive common editable fields from the selected DOM element type.
- [ ] Support a default common subset for:
  - text-like elements
  - links
  - images
  - generic containers
- [ ] Ensure default visible fields are limited to common properties such as text, href, src, display, visibility, spacing, color, background, and class names.
- [ ] Ensure lower-level raw attributes and broader style editing stay inside collapsed sections.
- [ ] Add tests that verify different element types produce the expected inspector groups and default visible fields.

## Task 5: Direct Inspector Apply Behavior

**Files:**
- Modify: `playground/parameterized-page-editor/src/apply-engine.js`
- Modify: `playground/parameterized-page-editor/app.js`
- Modify: `playground/parameterized-page-editor/src/panel.js`
- Test: `playground/parameterized-page-editor/test/apply-engine.test.js`
- Test: `playground/parameterized-page-editor/test/e2e.spec.js`

- [ ] Allow the default inspector to apply edits directly to the currently selected element without any manifest.
- [ ] Support direct built-in edits for:
  - text content
  - inline style properties
  - common attributes
  - class toggles
- [ ] Keep validation local and field-addressable.
- [ ] Add browser tests that click an element, edit a common field, apply it, and verify the preview updates.

## Task 6: Optional Curated Manifest Overlay

**Files:**
- Modify: `playground/parameterized-page-editor/src/manifest.js`
- Modify: `playground/parameterized-page-editor/src/panel.js`
- Modify: `playground/parameterized-page-editor/src/apply-engine.js`
- Modify: `playground/parameterized-page-editor/app.js`
- Test: `playground/parameterized-page-editor/test/e2e.spec.js`

- [ ] Treat manifest upload as optional.
- [ ] When present, render manifest-defined controls in a dedicated curated section above the default inspector groups.
- [ ] Keep default inspector editing available even if no manifest is loaded.
- [ ] Ensure manifest validation errors do not disable default direct editing.
- [ ] Add browser tests that verify:
  - HTML-only editing works without a manifest
  - manifest upload adds curated controls
  - curated controls act as a subset overlay rather than replacing the default inspector

## Task 7: Expanded Attribute And Advanced Editing

**Files:**
- Modify: `playground/parameterized-page-editor/src/default-inspector.js`
- Modify: `playground/parameterized-page-editor/src/panel.js`
- Modify: `playground/parameterized-page-editor/src/apply-engine.js`
- Test: `playground/parameterized-page-editor/test/e2e.spec.js`

- [ ] Add expanded editing for broader attributes and advanced style entries.
- [ ] Keep it behind collapsed sections by default.
- [ ] Preserve the simpler common-property workflow for first-time users.
- [ ] Add coverage that verifies an advanced field can be expanded, edited, and applied.

## Task 8: Save And Reload Editor State

**Files:**
- Modify: `playground/parameterized-page-editor/index.html`
- Modify: `playground/parameterized-page-editor/app.js`
- Modify: `playground/parameterized-page-editor/src/state.js`
- Test: `playground/parameterized-page-editor/test/e2e.spec.js`

- [ ] Export current editor state in a reusable form.
- [ ] Include optional manifest values when present.
- [ ] Reload saved values without making manifest mandatory.
- [ ] Verify reloaded state restores the inspector view and the resulting preview mutations.

## Acceptance Focus

The prototype is ready for the next design checkpoint when:

- the user can load an HTML file and immediately click elements without a manifest
- the inspector shows common properties by default and broader properties behind expanders
- the optional manifest adds curated controls as a subset overlay
- direct editing keeps working whether or not a manifest is present

## Self-Review

- The old manifest-first plan is intentionally superseded by this click-to-edit-first plan.
- Existing Task 1 work remains valid.
- Existing manifest normalization work is still useful, but only as an optional overlay layer.
- Future implementation must not regress into “manifest required before editing”.

## Execution Handoff

Plan updated in place at `docs/superpowers/plans/2026-04-21-parameterized-page-editor-standalone-plan.md`.

If we continue implementation from here, the next correct work item after Task 2 is:

- build element selection and inspector scaffolding before adding more manifest-driven behavior
