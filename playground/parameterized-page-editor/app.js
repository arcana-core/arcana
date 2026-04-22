import { createEditorState } from './src/state.js';
import { normalizeManifest } from './src/manifest.js';
import { attachPreviewSelection, describeElement } from './src/selection.js';

const state = createEditorState();
const INSPECTOR_SECTIONS = [
  { key: 'content', title: 'Content' },
  { key: 'layout', title: 'Layout' },
  { key: 'style', title: 'Style' },
  { key: 'attributes', title: 'Attributes' },
  { key: 'advanced', title: 'Advanced' },
];

const htmlInput = document.querySelector('#html-file');
const manifestInput = document.querySelector('#manifest-file');
const applyButton = document.querySelector('#apply-button');
const resetButton = document.querySelector('#reset-button');
const panelRoot = document.querySelector('#panel-root');
const statusOutput = document.querySelector('#status-output');
const previewFrame = document.querySelector('#preview-frame');
let detachPreviewSelection = () => {};
let lastRenderedPreviewMarkup = previewFrame.getAttribute('srcdoc') || '';

function canApply() {
  return Boolean(state.htmlText && state.manifest);
}

function createElement(name, className, textContent) {
  const element = document.createElement(name);

  if (className) {
    element.className = className;
  }

  if (textContent !== undefined) {
    element.textContent = textContent;
  }

  return element;
}

function setStatus(message) {
  statusOutput.value = message;
  statusOutput.textContent = message;
}

function createInspectorRow(label, value, muted = false) {
  const row = createElement('div', 'inspector-row');
  const term = createElement('dt', 'inspector-term', label);
  const description = createElement('dd', muted ? 'inspector-value inspector-value-muted' : 'inspector-value', value);

  row.append(term, description);
  return row;
}

function createInspectorSection(section, contentRows) {
  const details = createElement('details', 'inspector-section');
  details.dataset.sectionKey = section.key;

  if (state.selectedInspectorSections.includes(section.key)) {
    details.open = true;
  }

  details.addEventListener('toggle', () => {
    const openSections = new Set(state.selectedInspectorSections);

    if (details.open) {
      openSections.add(section.key);
    } else {
      openSections.delete(section.key);
    }

    state.selectedInspectorSections = INSPECTOR_SECTIONS
      .map(({ key }) => key)
      .filter((key) => openSections.has(key));
  });

  const summary = createElement('summary', 'inspector-summary', section.title);
  const content = createElement('dl', 'inspector-grid');

  contentRows.forEach((row) => {
    content.append(row);
  });

  details.append(summary, content);
  return details;
}

function renderPanel() {
  panelRoot.replaceChildren();

  if (state.selectedElement) {
    const header = createElement('div', 'inspector-selection');
    const eyebrow = createElement('p', 'inspector-eyebrow', 'Selected element');
    const title = createElement('h3', 'inspector-title', state.selectedElement.label);
    const meta = createElement(
      'p',
      'inspector-copy',
      `Tag: ${state.selectedElement.tagName} · ${state.selectedElement.editable.attributes.length} captured attributes`,
    );

    header.append(eyebrow, title, meta);
    panelRoot.append(header);

    const sections = [
      createInspectorSection(INSPECTOR_SECTIONS[0], [
        createInspectorRow('Text content', state.selectedElement.editable.content.textContent || 'No text content detected.', !state.selectedElement.editable.content.textContent),
        createInspectorRow('HTML', state.selectedElement.editable.content.htmlPlaceholder, true),
      ]),
      createInspectorSection(INSPECTOR_SECTIONS[1], [
        createInspectorRow('Box model', state.selectedElement.editable.layout.boxModelPlaceholder, true),
        createInspectorRow('Positioning', state.selectedElement.editable.layout.positionPlaceholder, true),
      ]),
      createInspectorSection(INSPECTOR_SECTIONS[2], [
        createInspectorRow('Inline style', state.selectedElement.editable.style.inlineStyle || 'No inline styles present.', !state.selectedElement.editable.style.inlineStyle),
        createInspectorRow('Computed styles', state.selectedElement.editable.style.computedPlaceholder, true),
      ]),
      createInspectorSection(
        INSPECTOR_SECTIONS[3],
        state.selectedElement.editable.attributes.length > 0
          ? state.selectedElement.editable.attributes.map((attribute) => createInspectorRow(attribute.name, attribute.value || '(empty)'))
          : [createInspectorRow('Attributes', 'No attributes captured.', true)],
      ),
      createInspectorSection(INSPECTOR_SECTIONS[4], [
        createInspectorRow('Selector target', state.selectedElement.editable.advanced.selectorHint),
        createInspectorRow('Mutation bindings', state.selectedElement.editable.advanced.bindingPlaceholder, true),
      ]),
    ];

    panelRoot.append(...sections);
    return;
  }

  const emptyState = createElement('div', 'panel-empty-state');
  const title = createElement('h3', 'inspector-title', 'Inspector scaffold');
  let message = 'Load an HTML file to start selecting elements.';

  if (state.htmlText && state.manifest) {
    const manifestTitle = state.manifest.title || state.manifest.name || 'Manifest loaded';
    message = `${manifestTitle} is ready. Select a preview element to inspect it before binding controls.`;
  } else if (state.htmlText) {
    message = 'HTML loaded. Select any visible preview element. A manifest is optional for this scaffold.';
  } else if (state.manifest) {
    const manifestTitle = state.manifest.title || state.manifest.name || 'Manifest loaded';
    message = `${manifestTitle} is loaded. Add an HTML file to inspect the preview.`;
  }

  emptyState.append(title, createElement('p', 'inspector-copy', message));
  panelRoot.append(emptyState);
}

function buildSelectedElementMetadata(element) {
  return {
    tagName: element.tagName.toLowerCase(),
    label: describeElement(element),
    editable: {
      content: {
        textContent: element.textContent?.trim() || '',
        htmlPlaceholder: 'Rich content editing will be added in a later task.',
      },
      layout: {
        boxModelPlaceholder: 'Spacing and sizing controls will land in a later task.',
        positionPlaceholder: 'Position controls will be scaffolded in a later task.',
      },
      style: {
        inlineStyle: element.getAttribute('style') || '',
        computedPlaceholder: 'Color and typography controls will be wired in a later task.',
      },
      attributes: Array.from(element.attributes).map((attribute) => ({
        name: attribute.name,
        value: attribute.value,
      })),
      advanced: {
        selectorHint: describeElement(element),
        bindingPlaceholder: 'Manifest-backed mutation bindings will appear here later.',
      },
    },
  };
}

function renderPreview() {
  const nextMarkup = state.htmlText || "<p class='preview-empty'>Preview not loaded yet.</p>";

  if (nextMarkup === lastRenderedPreviewMarkup) {
    return;
  }

  lastRenderedPreviewMarkup = nextMarkup;
  previewFrame.srcdoc = nextMarkup;
}

function syncControls() {
  const enabled = canApply();
  applyButton.disabled = !enabled;
  resetButton.disabled = !enabled;

  if (state.selectedElement) {
    setStatus(`Selected: ${state.selectedElement.label}`);
  } else if (enabled) {
    setStatus('HTML and manifest loaded. Apply is ready.');
  } else if (state.errors.length > 0) {
    setStatus(state.errors[state.errors.length - 1]);
  } else if (state.htmlText) {
    setStatus('HTML loaded. Click a preview element to inspect it, or add a manifest file to enable editing.');
  } else if (state.manifest) {
    setStatus('Manifest loaded. Add an HTML file to enable editing.');
  } else {
    setStatus('Load an HTML file to inspect the preview. Manifest is optional for selection scaffolding.');
  }

  renderPanel();
  renderPreview();
}

async function readSelectedFile(input) {
  const [file] = input.files ?? [];
  return file ? file.text() : '';
}

function handlePreviewLoad() {
  detachPreviewSelection();
  detachPreviewSelection = () => {};

  if (!state.htmlText) {
    return;
  }

  detachPreviewSelection = attachPreviewSelection(previewFrame, (element) => {
    state.selectedElement = buildSelectedElementMetadata(element);
    renderPanel();
    setStatus(`Selected: ${state.selectedElement.label}`);
  });
}

previewFrame.addEventListener('load', handlePreviewLoad);

htmlInput.addEventListener('change', async () => {
  state.errors = [];
  state.selectedElement = null;
  state.htmlText = await readSelectedFile(htmlInput);
  syncControls();
});

manifestInput.addEventListener('change', async () => {
  state.errors = [];
  state.manifest = null;

  const manifestText = await readSelectedFile(manifestInput);

  if (!manifestText) {
    syncControls();
    return;
  }

  try {
    state.manifest = normalizeManifest(JSON.parse(manifestText));
  } catch (error) {
    if (error instanceof SyntaxError) {
      state.errors.push('Manifest file must contain valid JSON.');
    } else {
      state.errors.push(error instanceof Error ? error.message : 'Manifest file is invalid.');
    }
  }

  syncControls();
});

applyButton.addEventListener('click', () => {
  state.lastAppliedValues = { ...state.values };
  setStatus('Apply is scaffolded. Parameter mutations will be wired in a later task.');
});

resetButton.addEventListener('click', () => {
  state.values = { ...state.lastAppliedValues };
  setStatus('Reset is scaffolded. Parameter reset behavior will be wired in a later task.');
});

syncControls();
