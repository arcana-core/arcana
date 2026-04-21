export function createEditorState() {
  return {
    htmlText: '',
    manifest: null,
    values: {},
    lastAppliedValues: {},
    errors: [],
  };
}
