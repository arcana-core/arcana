import { createEditorState } from './src/state.js';
import { normalizeManifest } from './src/manifest.js';
import { attachPreviewSelection, clearSelectedElement } from './src/selection.js';
import { deriveInspectorModel } from './src/default-inspector.js';

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
      `Tag: ${state.selectedElement.tagName} · ${state.selectedElement.attributeCount} captured attributes`,
    );

    header.append(eyebrow, title, meta);
    panelRoot.append(header);

    const sections = INSPECTOR_SECTIONS.map((section) => {
      const rows = (state.selectedElement.sections[section.key] || [])
        .map((field) => createInspectorRow(field.label, field.value, field.muted));

      return createInspectorSection(section, rows);
    });

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

function renderPreview() {
  const nextMarkup = state.htmlText || "<p class='preview-empty'>Preview not loaded yet.</p>";

  if (nextMarkup === lastRenderedPreviewMarkup) {
    if (previewFrame.contentDocument) {
      clearSelectedElement(previewFrame.contentDocument);
    }

    return;
  }

  lastRenderedPreviewMarkup = nextMarkup;
  previewFrame.srcdoc = nextMarkup;
}

function syncControls() {
  const enabled = canApply();
  applyButton.disabled = !enabled;
  resetButton.disabled = !enabled;

  if (state.errors.length > 0) {
    setStatus(state.errors[state.errors.length - 1]);
  } else if (state.selectedElement) {
    setStatus(`Selected: ${state.selectedElement.label}`);
  } else if (enabled) {
    setStatus('HTML and manifest loaded. Apply is ready.');
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
    state.selectedElement = deriveInspectorModel(element, previewFrame.contentWindow);
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
