export const DEFAULT_OPEN_INSPECTOR_SECTIONS = ['content', 'layout', 'style'];

export function createEditorState() {
  return {
    htmlText: '',
    manifest: null,
    selectedPreviewElement: null,
    selectedElement: null,
    inspectorValues: {},
    selectedInspectorSections: [...DEFAULT_OPEN_INSPECTOR_SECTIONS],
    errors: [],
  };
}
