# Parameterized Page Editor Design

This document defines the updated architecture direction for a zero-integration web editor that loads an imported HTML text file, lets the user click elements directly in a preview canvas, and exposes a two-layer inspector:

- a built-in default inspector for direct element editing
- an optional manifest overlay that narrows or enhances editable properties

The design intentionally moves away from a manifest-first workflow. A manifest is no longer required to begin editing.

## Goal

Support this workflow:

1. Load a local HTML text file.
2. Render the document in an isolated preview `iframe`.
3. Let the user hover and click elements directly in the preview, similar to a lightweight editable DevTools experience.
4. Show a default inspector with common editable properties immediately.
5. Allow the user to expand into broader attribute and style editing when needed.
6. Optionally load a JSON manifest from an external analyzer to provide a curated subset, safer labels, or richer controls for selected properties.

This system is a click-to-edit DOM inspector with optional parameterization, not a manifest-gated form renderer.

## Core Boundary

The boundary is strict:

- The imported page remains the rendering truth.
- The editor always supports direct element selection and default property editing without a manifest.
- The manifest is optional and acts as an enhancement layer, not an access gate.
- The editor applies only built-in operations in v1.
- The editor does not execute arbitrary user scripts in v1.

## Product Model

The editor has two editing layers.

### 1. Default Inspector Layer

This layer is always available.

When the user clicks an element, the editor derives editable properties from the current DOM node and shows them in collapsible groups.

Recommended group order:

1. `Content`
2. `Layout`
3. `Style`
4. `Attributes`
5. `Advanced`

Expected behavior:

- common properties are visible by default
- broader or lower-level properties are behind expanders
- editing is element-centric, not manifest-centric

### 2. Manifest Overlay Layer

This layer is optional.

If a manifest is present, it can:

- limit which properties are editable for some elements
- add curated labels or widget hints
- define recommended controls for a subset of properties
- express selector-based bindings that map a higher-level field to a lower-level DOM mutation

The manifest does not replace the default inspector. It adds a curated subset on top of it.

## Non-Goals

The first version does not attempt to support:

- arbitrary JavaScript execution in bindings
- expression evaluation or multi-step programmable transforms
- behavior logic editing or event handler authoring
- a full DevTools clone
- cross-origin loading concerns

The imported page is a local text file, so cross-origin and remote embedding constraints remain out of scope.

## Runtime Architecture

The runtime is split into six layers.

### 1. Document Layer

Responsibilities:

- accept imported HTML text
- create the preview `iframe`
- sandbox the preview so imported scripts cannot mutate the editor shell
- write the imported document into the `iframe`

The preview document remains the rendering truth.

### 2. Selection Layer

Responsibilities:

- track hover and selected element
- compute target element from pointer events inside the preview
- draw selection affordances around the active node

This is the default entry point to editing. No manifest is required.

### 3. Inspector Derivation Layer

Responsibilities:

- inspect the selected DOM node
- derive a common editable property set by element type
- organize those properties into collapsible inspector sections

Element-specific examples:

- text nodes or headings: text content, color, font size, line height
- links: text, href, target
- images: src, alt, width, height, object-fit
- containers: display, visibility, margin, padding, background, border

### 4. Manifest Layer

Responsibilities:

- load and validate optional external manifest JSON
- expose normalized `schema`, `ui`, and `bindings`
- provide curated controls that can appear alongside default inspector fields

Manifest validation still happens at load time, but manifest absence is not an error.

### 5. Apply Engine

Responsibilities:

- apply default inspector edits directly to the selected element
- apply optional manifest-driven bindings through built-in operations
- validate selector-driven manifest operations before committing
- keep mutation behavior deterministic and explicit

### 6. Session State Layer

Responsibilities:

- store current HTML text
- store current selected element metadata
- store optional manifest
- store current inspector values and manifest values
- store apply errors and field errors

The session source of truth is current DOM state plus editor state, not a manifest alone.

## Default Inspector

### Section Structure

The default inspector should be grouped like this:

#### `Content`

Shown by default.

Typical fields:

- text content
- inner HTML when allowed
- image source
- link text

#### `Layout`

Shown by default for layout-capable elements.

Typical fields:

- width
- height
- margin
- padding
- display
- visibility

#### `Style`

Shown by default with a compact subset.

Typical fields:

- color
- background
- border
- font size
- font weight

#### `Attributes`

Collapsed by default.

Typical fields:

- `id`
- `class`
- `href`
- `src`
- `alt`
- arbitrary attributes the user wants to edit

#### `Advanced`

Collapsed by default.

Typical fields:

- raw inline style entries
- lower-level properties that are not part of the common subset

### Default vs Expanded Editing

The inspector should follow this rule:

- default view shows the common safe subset
- expanded view allows broader editing of attributes and styles

That keeps the UI approachable while still allowing power-user control.

## Manifest Overlay

### Purpose

The manifest is optional and should be understood as a curated subset layer.

It is useful when an external analyzer wants to say:

- “these are the most meaningful fields on this page”
- “show a friendlier label for this property”
- “this specific selector should be edited with a color picker / boolean toggle / text field”

### Manifest Shape

Recommended top-level shape remains:

```json
{
  "version": 1,
  "title": "Landing Page Controls",
  "description": "Curated controls for a local imported page",
  "schema": {},
  "ui": {},
  "bindings": []
}
```

The existing `schema` / `ui` / `bindings` split still applies, but now it only defines the optional curated layer.

### How Manifest Interacts With The Inspector

Manifest controls can:

- appear in a dedicated `Curated` or `Suggested` section above the default inspector groups
- override labels or widgets for a known property
- restrict editing when the editor is operating in a curated mode

The default behavior should still allow selection and common property editing when no manifest exists.

## Built-In Operations

The first version should still support built-in operations only.

### Direct Inspector Operations

These are applied against the currently selected element:

- set text content
- set inline style property
- set or remove common attributes
- toggle visibility or class names

### Manifest Binding Operations

These remain selector-based:

- `setText`
- `setHtml`
- `setImageSrc`
- `setStyle`
- `toggleClass`
- `setAttribute`
- `insertNode`
- `removeNode`

No scripting escape hatch should exist in v1.

## Error Handling

### Default Inspector Errors

These should be local to the selected element and field:

- invalid style value
- incompatible edit for the selected element type
- blocked raw HTML edit when unsafe

### Manifest Errors

These remain explicit and field-addressable:

- selector not matched
- selector matched multiple nodes
- unsupported binding operation
- unknown manifest field

Manifest errors must not disable the entire default inspector.

## Persistence Direction

Recommended persisted artifacts:

- original imported HTML file
- current editor state snapshot
- optional manifest JSON
- optional manifest-derived parameter values

The manifest is an enhancement input, not the only persisted model.

## v1 Acceptance Criteria

The first version is successful when all of the following hold:

- the editor can load a local HTML text file without requiring a manifest
- the user can click an element and see a default inspector
- the default inspector shows common fields immediately and advanced fields behind expanders
- the editor can apply common property edits directly to the selected element
- the editor can optionally load a manifest and surface curated controls as a subset overlay
- manifest failures surface clearly without disabling default inspector editing

## Open Questions Deferred

These are intentionally deferred beyond this design:

- how broad the default advanced attribute/style editor should be
- whether the editor should support drag handles or box-model overlays in v1
- whether manifest overlay can hide default controls for some modes
- whether selector targeting needs bulk-match or nth-match modes
- whether the editor should support authoring manifests from direct inspector interactions

## Recommended Implementation Sequence

1. Build the standalone shell and sandboxed preview.
2. Build element selection and inspector section scaffolding.
3. Build default inspector derivation for common properties.
4. Build direct inspector apply behavior.
5. Keep manifest validation and normalization as an optional overlay input.
6. Build curated manifest rendering and binding execution.

This order makes the default click-to-edit experience the primary workflow and keeps the manifest layer additive.
