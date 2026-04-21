import { createEditorState } from './src/state.js';

const state = createEditorState();

const htmlInput = document.querySelector('#html-file');
const manifestInput = document.querySelector('#manifest-file');
const applyButton = document.querySelector('#apply-button');
const resetButton = document.querySelector('#reset-button');
const panelRoot = document.querySelector('#panel-root');
const statusOutput = document.querySelector('#status-output');
const previewFrame = document.querySelector('#preview-frame');

function canApply() {
  return Boolean(state.htmlText && state.manifest);
}

function setStatus(message) {
  statusOutput.value = message;
  statusOutput.textContent = message;
}

function renderPanelPlaceholder() {
  if (state.manifest) {
    const manifestTitle = state.manifest.title || state.manifest.name || 'Manifest loaded';
    panelRoot.textContent = `${manifestTitle} loaded. Parameter controls will be scaffolded here next.`;
    return;
  }

  panelRoot.textContent = 'Waiting for source files.';
}

function renderPreview() {
  previewFrame.srcdoc = state.htmlText || "<p class='preview-empty'>Preview not loaded yet.</p>";
}

function syncControls() {
  const enabled = canApply();
  applyButton.disabled = !enabled;
  resetButton.disabled = !enabled;

  if (enabled) {
    setStatus('HTML and manifest loaded. Apply is ready.');
  } else if (state.errors.length > 0) {
    setStatus(state.errors[state.errors.length - 1]);
  } else if (state.htmlText) {
    setStatus('HTML loaded. Add a manifest file to enable editing.');
  } else if (state.manifest) {
    setStatus('Manifest loaded. Add an HTML file to enable editing.');
  } else {
    setStatus('Load an HTML file and a manifest file to enable preview actions.');
  }

  renderPanelPlaceholder();
  renderPreview();
}

async function readSelectedFile(input) {
  const [file] = input.files ?? [];
  return file ? file.text() : '';
}

htmlInput.addEventListener('change', async () => {
  state.errors = [];
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
    state.manifest = JSON.parse(manifestText);
  } catch {
    state.errors.push('Manifest file must contain valid JSON.');
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
