import { createEditorState } from './src/state.js';
import { normalizeManifest } from './src/manifest.js';
import { attachPreviewSelection, clearSelectedElement } from './src/selection.js';
import { deriveInspectorModel, applyInspectorValues } from './src/default-inspector.js';
import {
  deriveCuratedInspectorModel,
  applyCuratedInspectorValues,
} from './src/curated-inspector.js';

const state = createEditorState();
const INSPECTOR_SECTIONS = [
  { key: 'curated', title: 'Curated' },
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
  return Boolean(state.htmlText && state.selectedPreviewElement);
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

function clearSelectionState() {
  state.selectedPreviewElement = null;
  state.selectedElement = null;
  state.inspectorValues = {};
  state.curatedInspector = { fields: [], values: {} };
  state.curatedValues = {};
}

function refreshSelectedElementFromDom() {
  if (!state.selectedPreviewElement) {
    clearSelectionState();
    return;
  }

  state.selectedElement = deriveInspectorModel(
    state.selectedPreviewElement,
    previewFrame.contentWindow,
  );
  state.inspectorValues = { ...state.selectedElement.values };
  state.curatedInspector = deriveCuratedInspectorModel(state.manifest, state.selectedPreviewElement);
  state.curatedValues = { ...state.curatedInspector.values };
}

function handleInspectorValueInput(fieldKey, value) {
  state.inspectorValues = {
    ...state.inspectorValues,
    [fieldKey]: value,
  };
}

function handleCuratedValueInput(fieldKey, value) {
  state.curatedValues = {
    ...state.curatedValues,
    [fieldKey]: value,
  };
}

function createReadOnlyValue(field) {
  return createElement(
    'p',
    field.muted ? 'inspector-value inspector-value-muted' : 'inspector-value',
    field.value,
  );
}

function createEditableControl(field, value, onChange) {
  let control;

  if (field.control === 'textarea') {
    control = document.createElement('textarea');
    control.rows = 3;
  } else if (field.control === 'select') {
    control = document.createElement('select');

    field.options.forEach((optionValue) => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = optionValue || 'Not set';
      control.append(option);
    });
  } else {
    control = document.createElement('input');
    control.type = 'text';

    if (field.key === 'width' || field.key === 'height') {
      control.inputMode = 'numeric';
    }
  }

  control.className = 'inspector-control';
  control.dataset.fieldKey = field.inputKey || field.key;
  control.setAttribute('aria-label', field.label);
  control.value = value ?? '';

  if (field.placeholder) {
    control.placeholder = field.placeholder;
  }

  const eventName = field.control === 'select' ? 'change' : 'input';
  control.addEventListener(eventName, () => {
    onChange(field.key, control.value);
  });

  return control;
}

function createInspectorRow(field, value, onChange) {
  const row = createElement('div', 'inspector-row');
  const term = createElement('dt', 'inspector-term', field.label);
  const content = createElement('dd', 'inspector-field');

  if (field.editable && field.key) {
    content.append(createEditableControl(field, value, onChange));

    if (field.placeholder) {
      const hint = createElement('p', 'inspector-help', field.placeholder);
      content.append(hint);
    }
  } else {
    content.append(createReadOnlyValue(field));
  }

  row.append(term, content);
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

    const sections = [];
    const curatedRows = state.curatedInspector.fields
      .map((field) => createInspectorRow(
        field,
        state.curatedValues[field.key] ?? '',
        handleCuratedValueInput,
      ));

    if (curatedRows.length > 0) {
      sections.push(createInspectorSection(INSPECTOR_SECTIONS[0], curatedRows));
    }

    sections.push(
      ...INSPECTOR_SECTIONS
        .slice(1)
        .map((section) => {
          const rows = (state.selectedElement.sections[section.key] || [])
            .map((field) => createInspectorRow(
              field,
              state.inspectorValues[field.key] ?? '',
              handleInspectorValueInput,
            ));

          return createInspectorSection(section, rows);
        }),
    );

    panelRoot.append(...sections);
    return;
  }

  const emptyState = createElement('div', 'panel-empty-state');
  const title = createElement('h3', 'inspector-title', 'Inspector scaffold');
  let message = 'Load an HTML file to start selecting elements.';

  if (state.htmlText && state.manifest) {
    const manifestTitle = state.manifest.title || state.manifest.name || 'Manifest loaded';
    message = `${manifestTitle} is ready. Select a preview element to edit its common fields.`;
  } else if (state.htmlText) {
    message = 'HTML loaded. Select any visible preview element to edit its common properties.';
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
  } else if (state.htmlText && state.manifest) {
    setStatus('Manifest loaded. Click a preview element to edit it.');
  } else if (state.htmlText) {
    setStatus('HTML loaded. Click a preview element to inspect it and edit its common properties.');
  } else if (state.manifest) {
    setStatus('Manifest loaded. Add an HTML file to enable editing.');
  } else {
    setStatus('Load an HTML file to inspect the preview. Manifest is optional for selection and direct editing.');
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
    state.errors = [];
    state.selectedPreviewElement = element;
    refreshSelectedElementFromDom();
    renderPanel();
    applyButton.disabled = false;
    resetButton.disabled = false;
    setStatus(`Selected: ${state.selectedElement.label}`);
  });
}

previewFrame.addEventListener('load', handlePreviewLoad);

htmlInput.addEventListener('change', async () => {
  state.errors = [];
  clearSelectionState();
  state.htmlText = await readSelectedFile(htmlInput);
  syncControls();
});

manifestInput.addEventListener('change', async () => {
  state.errors = [];
  state.manifest = null;

  const manifestText = await readSelectedFile(manifestInput);

  if (!manifestText) {
    if (state.selectedPreviewElement) {
      refreshSelectedElementFromDom();
    }

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

  if (state.selectedPreviewElement) {
    refreshSelectedElementFromDom();
  }

  syncControls();
});

applyButton.addEventListener('click', () => {
  if (!state.selectedPreviewElement) {
    return;
  }

  const defaultResult = applyInspectorValues(state.selectedPreviewElement, state.inspectorValues);
  const curatedResult = applyCuratedInspectorValues(
    state.selectedPreviewElement,
    state.curatedValues,
    state.curatedInspector.fields,
  );
  state.errors = [...defaultResult.errors, ...curatedResult.errors];
  refreshSelectedElementFromDom();
  renderPanel();

  if (state.errors.length > 0) {
    setStatus(state.errors[0]);
    return;
  }

  setStatus(`Applied changes to ${state.selectedElement.label}.`);
});

resetButton.addEventListener('click', () => {
  if (!state.selectedPreviewElement) {
    return;
  }

  state.errors = [];
  refreshSelectedElementFromDom();
  renderPanel();
  setStatus(`Reset form values from ${state.selectedElement.label}.`);
});

syncControls();
