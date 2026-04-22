export const DEFAULT_OPEN_INSPECTOR_SECTIONS = ['content', 'layout', 'style'];

export function createEditorState() {
  return {
    htmlText: '',
    manifest: null,
    values: {},
    lastAppliedValues: {},
    selectedElement: null,
    selectedInspectorSections: [...DEFAULT_OPEN_INSPECTOR_SECTIONS],
    errors: [],
  };
}
