export const DEFAULT_OPEN_INSPECTOR_SECTIONS = ['curated', 'content', 'layout', 'style'];

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
