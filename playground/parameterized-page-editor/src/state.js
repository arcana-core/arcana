export const DEFAULT_OPEN_INSPECTOR_SECTIONS = ['curated', 'content', 'layout', 'style'];
const SAVED_STATE_KIND = 'parameterized-page-editor-state';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeStringRecord(record) {
  if (!isPlainObject(record)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter(([, value]) => typeof value === 'string')
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  );
}

function normalizeSectionKeys(sectionKeys) {
  if (!Array.isArray(sectionKeys)) {
    return [...DEFAULT_OPEN_INSPECTOR_SECTIONS];
  }

  return Array.from(new Set(sectionKeys.filter((value) => typeof value === 'string')));
}

export function createSavedEditorStateSnapshot({
  selectedElement,
  selectedInspectorSections,
  inspectorValues,
  curatedValues,
}) {
  return {
    kind: SAVED_STATE_KIND,
    selection: {
      label: selectedElement?.label || '',
    },
    selectedInspectorSections: normalizeSectionKeys(selectedInspectorSections),
    defaultValues: normalizeStringRecord(inspectorValues),
    curatedValues: normalizeStringRecord(curatedValues),
  };
}

export function serializeSavedEditorState(snapshot) {
  return JSON.stringify(snapshot, null, 2);
}

export function parseSavedEditorState(text) {
  const parsed = JSON.parse(text);

  if (!isPlainObject(parsed)) {
    throw new Error('Saved editor state must be a JSON object.');
  }

  if (parsed.kind !== SAVED_STATE_KIND) {
    throw new Error('Saved editor state must include kind "parameterized-page-editor-state".');
  }

  const selection = isPlainObject(parsed.selection) ? parsed.selection : {};

  return {
    kind: SAVED_STATE_KIND,
    selection: {
      label: typeof selection.label === 'string' ? selection.label : '',
    },
    selectedInspectorSections: normalizeSectionKeys(parsed.selectedInspectorSections),
    defaultValues: normalizeStringRecord(parsed.defaultValues),
    curatedValues: normalizeStringRecord(parsed.curatedValues),
  };
}

export function createEditorState() {
  return {
    htmlText: '',
    manifest: null,
    selectedPreviewElement: null,
    selectedElement: null,
    curatedInspector: { fields: [], values: {} },
    curatedValues: {},
    inspectorValues: {},
    selectedInspectorSections: [...DEFAULT_OPEN_INSPECTOR_SECTIONS],
    errors: [],
  };
}
