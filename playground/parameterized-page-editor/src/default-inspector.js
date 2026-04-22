import { describeElement } from './selection.js';

const INTERNAL_SELECTION_ATTRIBUTE = 'data-arcana-selected-element';
const TEXT_LIKE_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'span',
  'strong',
  'em',
  'small',
  'label',
  'button',
  'li',
  'dt',
  'dd',
  'blockquote',
  'figcaption',
  'legend',
]);

function createField(label, value, muted = false) {
  return { label, value, muted };
}

function getTagName(element) {
  return element.tagName.toLowerCase();
}

function getAttributeValue(element, name) {
  const value = element.getAttribute?.(name);
  return typeof value === 'string' ? value : '';
}

function getClassNames(element) {
  if (typeof element.className === 'string') {
    return element.className.trim();
  }

  return Array.from(element.classList ?? []).join(' ').trim();
}

function getTextContent(element) {
  return typeof element.textContent === 'string' ? element.textContent.trim() : '';
}

function parseInlineStyle(element) {
  const inlineStyle = getAttributeValue(element, 'style');
  const declarations = new Map();

  inlineStyle
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const separatorIndex = part.indexOf(':');

      if (separatorIndex === -1) {
        return;
      }

      const name = part.slice(0, separatorIndex).trim().toLowerCase();
      const value = part.slice(separatorIndex + 1).trim();

      if (name && value) {
        declarations.set(name, value);
      }
    });

  return declarations;
}

function isLinkElement(tagName) {
  return tagName === 'a';
}

function isImageElement(tagName) {
  return tagName === 'img';
}

function isTextLikeElement(tagName) {
  return TEXT_LIKE_TAGS.has(tagName);
}

function formatStyleValue(value, emptyFallback) {
  if (!value) {
    return { value: emptyFallback, muted: true };
  }

  if (value === 'rgba(0, 0, 0, 0)') {
    return { value: 'Transparent', muted: false };
  }

  return { value, muted: false };
}

function formatSpacing(inlineStyle) {
  const margin = inlineStyle.get('margin');
  const padding = inlineStyle.get('padding');
  const parts = [];

  if (margin) {
    parts.push(`Margin ${margin}`);
  }

  if (padding) {
    parts.push(`Padding ${padding}`);
  }

  if (parts.length === 0) {
    return createField('Spacing', 'Spacing values are not explicitly set on this element.', true);
  }

  return createField('Spacing', parts.join('; '));
}

function formatDimension(label, attributeValue) {
  const value = attributeValue;
  return createField(label, value || 'Not set', !value);
}

function collectRawAttributes(element) {
  return Array.from(element.attributes ?? [])
    .filter((attribute) => attribute.name !== INTERNAL_SELECTION_ATTRIBUTE)
    .map((attribute) => ({
      name: attribute.name,
      value: attribute.value,
    }));
}

function deriveContentFields(element, tagName) {
  if (isLinkElement(tagName)) {
    const text = getTextContent(element);
    const href = getAttributeValue(element, 'href');
    const target = getAttributeValue(element, 'target');

    return [
      createField('Text', text || 'No link text set.', !text),
      createField('Href', href || 'No href set.', !href),
      createField('Target', target || 'No target set.', !target),
    ];
  }

  if (isImageElement(tagName)) {
    const src = getAttributeValue(element, 'src');
    const alt = getAttributeValue(element, 'alt');

    return [
      createField('Src', src || 'No image source set.', !src),
      createField('Alt', alt || 'No alt text set.', !alt),
    ];
  }

  if (isTextLikeElement(tagName)) {
    const text = getTextContent(element);
    return [createField('Text', text || 'No text content detected.', !text)];
  }

  return [createField('Content', 'No common content fields for this element type.', true)];
}

function deriveLayoutFields(element, tagName, inlineStyle) {
  const display = formatStyleValue(inlineStyle.get('display') || '', 'Display is not explicitly set on this element.');
  const visibility = formatStyleValue(inlineStyle.get('visibility') || '', 'Visibility is not explicitly set on this element.');
  const rows = [
    createField('Display', display.value, display.muted),
    createField('Visibility', visibility.value, visibility.muted),
    formatSpacing(inlineStyle),
  ];

  if (isImageElement(tagName)) {
    rows.push(
      formatDimension('Width', getAttributeValue(element, 'width')),
      formatDimension('Height', getAttributeValue(element, 'height')),
    );
  }

  return rows;
}

function deriveStyleFields(element, tagName, inlineStyle) {
  const rows = [];
  const classNames = getClassNames(element);

  if (isLinkElement(tagName) || isTextLikeElement(tagName)) {
    const color = formatStyleValue(inlineStyle.get('color') || '', 'Text color is not explicitly set on this element.');
    rows.push(createField('Text color', color.value, color.muted));
  }

  const background = formatStyleValue(inlineStyle.get('background') || inlineStyle.get('background-color') || '', 'Background is not explicitly set on this element.');
  rows.push(createField('Background', background.value, background.muted));

  if (!isImageElement(tagName)) {
    const inlineStyleText = getAttributeValue(element, 'style');
    rows.push(createField('Inline style', inlineStyleText || 'No inline styles present.', !inlineStyleText));
  }

  rows.push(
    createField('Class names', classNames || 'No class names set.', !classNames),
  );

  return rows;
}

function deriveAttributeFields(attributes) {
  if (attributes.length === 0) {
    return [createField('Attributes', 'No raw attributes captured.', true)];
  }

  return attributes.map((attribute) => createField(attribute.name, attribute.value || '(empty)'));
}

function deriveAdvancedFields(element) {
  return [
    createField('Selector target', describeElement(element)),
    createField('Style controls', 'Expanded style editing will be added in a later task.', true),
  ];
}

export function deriveInspectorModel(element, view = element?.ownerDocument?.defaultView) {
  const tagName = getTagName(element);
  const attributes = collectRawAttributes(element);
  const inlineStyle = parseInlineStyle(element);

  void view;

  return {
    label: describeElement(element),
    tagName,
    attributeCount: attributes.length,
    sections: {
      content: deriveContentFields(element, tagName),
      layout: deriveLayoutFields(element, tagName, inlineStyle),
      style: deriveStyleFields(element, tagName, inlineStyle),
      attributes: deriveAttributeFields(attributes),
      advanced: deriveAdvancedFields(element),
    },
  };
}
