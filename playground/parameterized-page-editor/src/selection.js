const SELECTED_ELEMENT_ATTRIBUTE = 'data-arcana-selected-element';
const SELECTION_STYLE_ATTRIBUTE = 'data-arcana-selection-style';
const SELECTION_STYLE_TEXT = `
  [data-arcana-selected-element="true"] {
    outline: 3px solid #b24a2f !important;
    outline-offset: 3px !important;
    box-shadow: 0 0 0 6px rgba(178, 74, 47, 0.18) !important;
  }
`;

export function describeElement(element) {
  const tagName = element.tagName.toLowerCase();
  const idPart = element.id ? `#${element.id}` : '';
  const classPart = Array.from(element.classList)
    .filter(Boolean)
    .map((className) => `.${className}`)
    .join('');

  return `${tagName}${idPart}${classPart}`;
}

export function clearSelectedElement(document) {
  const currentSelection = document.querySelector(`[${SELECTED_ELEMENT_ATTRIBUTE}="true"]`);

  if (currentSelection) {
    currentSelection.removeAttribute(SELECTED_ELEMENT_ATTRIBUTE);
  }
}

export function markSelectedElement(element) {
  clearSelectedElement(element.ownerDocument);
  element.setAttribute(SELECTED_ELEMENT_ATTRIBUTE, 'true');
}

function ensureSelectionStyle(document) {
  if (document.head.querySelector(`[${SELECTION_STYLE_ATTRIBUTE}="true"]`)) {
    return;
  }

  const style = document.createElement('style');
  style.setAttribute(SELECTION_STYLE_ATTRIBUTE, 'true');
  style.textContent = SELECTION_STYLE_TEXT;
  document.head.append(style);
}

export function attachPreviewSelection(frame, onSelect) {
  const { contentDocument } = frame;

  if (!contentDocument?.body) {
    return () => {};
  }

  ensureSelectionStyle(contentDocument);

  const handleClick = (event) => {
    const previewWindow = contentDocument.defaultView;
    const target = event.target instanceof previewWindow?.Element
      ? event.target.closest('body *')
      : null;

    if (!target) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    markSelectedElement(target);
    onSelect(target);
  };

  contentDocument.addEventListener('click', handleClick);

  return () => {
    contentDocument.removeEventListener('click', handleClick);
    clearSelectedElement(contentDocument);
  };
}
