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
const DISPLAY_OPTIONS = ['', 'block', 'inline', 'inline-block', 'flex', 'grid', 'none'];
const VISIBILITY_OPTIONS = ['', 'visible', 'hidden', 'collapse'];
const COMMON_ATTRIBUTE_NAMES = new Set([
  'class',
  'style',
  'href',
  'target',
  'src',
  'alt',
  'width',
  'height',
]);
const SAFE_ATTRIBUTE_FIELDS = [
  { name: 'id', label: 'Id' },
  { name: 'title', label: 'Title' },
  { name: 'role', label: 'Role' },
];
const SAFE_ATTRIBUTE_NAMES = new Set(SAFE_ATTRIBUTE_FIELDS.map((field) => field.name));
const ADVANCED_STYLE_FIELDS = [
  { name: 'margin', label: 'Margin' },
  { name: 'padding', label: 'Padding' },
  { name: 'border', label: 'Border' },
  { name: 'border-radius', label: 'Border radius' },
  { name: 'opacity', label: 'Opacity' },
  { name: 'font-size', label: 'Font size' },
  { name: 'line-height', label: 'Line height' },
  { name: 'letter-spacing', label: 'Letter spacing' },
];
const ADVANCED_STYLE_NAMES = new Set(ADVANCED_STYLE_FIELDS.map((field) => field.name));

function createField({
  key = '',
  label,
  value,
  muted = false,
  editable = false,
  control = 'text',
  placeholder = '',
  options = [],
}) {
  return {
    key,
    label,
    value,
    muted,
    editable,
    control,
    placeholder,
    options,
  };
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
    return createField({
      label: 'Spacing',
      value: 'Spacing values are not explicitly set on this element.',
      muted: true,
    });
  }

  return createField({ label: 'Spacing', value: parts.join('; ') });
}

function formatDimension(label, key, attributeValue) {
  return createField({
    key,
    label,
    value: attributeValue,
    muted: !attributeValue,
    editable: true,
    placeholder: `${label} attribute is not set.`,
  });
}

function collectRawAttributes(element) {
  return Array.from(element.attributes ?? [])
    .filter((attribute) => attribute.name !== INTERNAL_SELECTION_ATTRIBUTE)
    .map((attribute) => ({
      name: attribute.name,
      value: attribute.value,
    }));
}

function createEditableTextField(key, label, value, placeholder, control = 'text') {
  return createField({
    key,
    label,
    value,
    muted: !value,
    editable: true,
    control,
    placeholder,
  });
}

function isEditableRawAttribute(name) {
  return SAFE_ATTRIBUTE_NAMES.has(name) || name.startsWith('aria-') || name.startsWith('data-');
}

function deriveContentFields(element, tagName) {
  if (isLinkElement(tagName)) {
    const text = getTextContent(element);
    const href = getAttributeValue(element, 'href');
    const target = getAttributeValue(element, 'target');

    return [
      createEditableTextField('text', 'Text', text, 'No link text set.', 'textarea'),
      createEditableTextField('href', 'Href', href, 'No href set.'),
      createEditableTextField('target', 'Target', target, 'No target set.'),
    ];
  }

  if (isImageElement(tagName)) {
    const src = getAttributeValue(element, 'src');
    const alt = getAttributeValue(element, 'alt');

    return [
      createEditableTextField('src', 'Src', src, 'No image source set.'),
      createEditableTextField('alt', 'Alt', alt, 'No alt text set.'),
    ];
  }

  if (isTextLikeElement(tagName)) {
    const text = getTextContent(element);
    return [createEditableTextField('text', 'Text', text, 'No text content detected.', 'textarea')];
  }

  return [createField({
    label: 'Content',
    value: 'No common content fields for this element type.',
    muted: true,
  })];
}

function deriveLayoutFields(element, tagName, inlineStyle) {
  const displayValue = inlineStyle.get('display') || '';
  const visibilityValue = inlineStyle.get('visibility') || '';
  const display = formatStyleValue(displayValue, 'Display is not explicitly set on this element.');
  const visibility = formatStyleValue(visibilityValue, 'Visibility is not explicitly set on this element.');
  const rows = [
    createField({
      key: 'display',
      label: 'Display',
      value: displayValue,
      muted: display.muted,
      editable: true,
      control: 'select',
      placeholder: display.value,
      options: DISPLAY_OPTIONS,
    }),
    createField({
      key: 'visibility',
      label: 'Visibility',
      value: visibilityValue,
      muted: visibility.muted,
      editable: true,
      control: 'select',
      placeholder: visibility.value,
      options: VISIBILITY_OPTIONS,
    }),
    formatSpacing(inlineStyle),
  ];

  if (isImageElement(tagName)) {
    rows.push(
      formatDimension('Width', 'width', getAttributeValue(element, 'width')),
      formatDimension('Height', 'height', getAttributeValue(element, 'height')),
    );
  }

  return rows;
}

function deriveStyleFields(element, tagName, inlineStyle) {
  const rows = [];
  const classNames = getClassNames(element);
  const backgroundValue = inlineStyle.get('background') || inlineStyle.get('background-color') || '';
  const background = formatStyleValue(backgroundValue, 'Background is not explicitly set on this element.');

  if (isLinkElement(tagName) || isTextLikeElement(tagName)) {
    const colorValue = inlineStyle.get('color') || '';
    const color = formatStyleValue(colorValue, 'Text color is not explicitly set on this element.');
    rows.push(createField({
      key: 'textColor',
      label: 'Text color',
      value: colorValue,
      muted: color.muted,
      editable: true,
      placeholder: color.value,
    }));
  }

  rows.push(createField({
    key: 'background',
    label: 'Background',
    value: backgroundValue,
    muted: background.muted,
    editable: true,
    placeholder: background.value,
  }));

  if (!isImageElement(tagName)) {
    const inlineStyleText = getAttributeValue(element, 'style');
    rows.push(createField({
      label: 'Inline style',
      value: inlineStyleText || 'No inline styles present.',
      muted: !inlineStyleText,
    }));
  }

  rows.push(createField({
    key: 'classNames',
    label: 'Class names',
    value: classNames,
    muted: !classNames,
    editable: true,
    placeholder: 'No class names set.',
  }));

  return rows;
}

function deriveAttributeFields(attributes) {
  const attributeMap = new Map(attributes.map((attribute) => [attribute.name, attribute.value]));
  const additionalAttributeNames = attributes
    .map((attribute) => attribute.name)
    .filter((name) => (
      !SAFE_ATTRIBUTE_NAMES.has(name)
      && !COMMON_ATTRIBUTE_NAMES.has(name)
      && isEditableRawAttribute(name)
    ));
  const orderedAttributeNames = [
    ...SAFE_ATTRIBUTE_FIELDS.map((field) => field.name),
    ...additionalAttributeNames,
  ];

  return orderedAttributeNames.map((name) => {
    const label = SAFE_ATTRIBUTE_FIELDS.find((field) => field.name === name)?.label || name;
    const value = attributeMap.get(name) || '';

    return createField({
      key: `attr:${name}`,
      label,
      value,
      muted: !value,
      editable: true,
      placeholder: `${label} is not set.`,
    });
  });
}

function deriveAdvancedFields(element, inlineStyle) {
  void element;

  return ADVANCED_STYLE_FIELDS.map((field) => {
    const value = inlineStyle.get(field.name) || '';

    return createField({
      key: `style:${field.name}`,
      label: field.label,
      value,
      muted: !value,
      editable: true,
      placeholder: `${field.label} inline style is not set.`,
    });
  });
}

function setAttributeValue(element, name, value) {
  const nextValue = value.trim();

  if (!nextValue) {
    element.removeAttribute(name);
    return;
  }

  element.setAttribute(name, nextValue);
}

function setClassNames(element, value) {
  const nextValue = value.trim();

  if (!nextValue) {
    element.removeAttribute('class');
    return;
  }

  element.setAttribute('class', nextValue);
}

function setTextContent(element, value) {
  element.textContent = value;
}

function removeStyleProperty(style, name) {
  style.removeProperty(name);
}

function cleanupEmptyStyleAttribute(element) {
  const inlineStyle = getAttributeValue(element, 'style');

  if (!inlineStyle.trim()) {
    element.removeAttribute('style');
  }
}

function setStyleValue(element, name, value) {
  const nextValue = value.trim();

  if (!nextValue) {
    removeStyleProperty(element.style, name);
    cleanupEmptyStyleAttribute(element);
    return;
  }

  element.style.setProperty(name, nextValue);
  cleanupEmptyStyleAttribute(element);
}

function setBackgroundValue(element, value) {
  const nextValue = value.trim();

  if (!nextValue) {
    removeStyleProperty(element.style, 'background');
    removeStyleProperty(element.style, 'background-color');
    cleanupEmptyStyleAttribute(element);
    return;
  }

  element.style.setProperty('background', nextValue);
  cleanupEmptyStyleAttribute(element);
}

function setDimensionValue(element, name, value, errors, label) {
  const nextValue = value.trim();

  if (!nextValue) {
    element.removeAttribute(name);
    return;
  }

  if (!/^\d+$/.test(nextValue)) {
    errors.push(`${label} must be a whole number.`);
    return;
  }

  element.setAttribute(name, nextValue);
}

function collectEditableValues(sections) {
  return Object.fromEntries(
    Object.values(sections)
      .flat()
      .filter((field) => field.editable && field.key)
      .map((field) => [field.key, field.value]),
  );
}

export function deriveInspectorModel(element, view = element?.ownerDocument?.defaultView) {
  const tagName = getTagName(element);
  const attributes = collectRawAttributes(element);
  const inlineStyle = parseInlineStyle(element);

  void view;

  const sections = {
    content: deriveContentFields(element, tagName),
    layout: deriveLayoutFields(element, tagName, inlineStyle),
    style: deriveStyleFields(element, tagName, inlineStyle),
    attributes: deriveAttributeFields(attributes),
    advanced: deriveAdvancedFields(element, inlineStyle),
  };

  return {
    label: describeElement(element),
    tagName,
    attributeCount: attributes.length,
    sections,
    values: collectEditableValues(sections),
  };
}

export function applyInspectorValues(element, values) {
  const tagName = getTagName(element);
  const errors = [];

  if (typeof values.text === 'string' && (isLinkElement(tagName) || isTextLikeElement(tagName))) {
    setTextContent(element, values.text);
  }

  if (typeof values.href === 'string' && isLinkElement(tagName)) {
    setAttributeValue(element, 'href', values.href);
  }

  if (typeof values.target === 'string' && isLinkElement(tagName)) {
    setAttributeValue(element, 'target', values.target);
  }

  if (typeof values.src === 'string' && isImageElement(tagName)) {
    setAttributeValue(element, 'src', values.src);
  }

  if (typeof values.alt === 'string' && isImageElement(tagName)) {
    setAttributeValue(element, 'alt', values.alt);
  }

  if (typeof values.classNames === 'string') {
    setClassNames(element, values.classNames);
  }

  if (typeof values.textColor === 'string' && (isLinkElement(tagName) || isTextLikeElement(tagName))) {
    setStyleValue(element, 'color', values.textColor);
  }

  if (typeof values.background === 'string') {
    setBackgroundValue(element, values.background);
  }

  if (typeof values.display === 'string') {
    setStyleValue(element, 'display', values.display);
  }

  if (typeof values.visibility === 'string') {
    setStyleValue(element, 'visibility', values.visibility);
  }

  if (typeof values.width === 'string' && isImageElement(tagName)) {
    setDimensionValue(element, 'width', values.width, errors, 'Width');
  }

  if (typeof values.height === 'string' && isImageElement(tagName)) {
    setDimensionValue(element, 'height', values.height, errors, 'Height');
  }

  Object.entries(values).forEach(([key, value]) => {
    if (typeof value !== 'string') {
      return;
    }

    if (key.startsWith('attr:')) {
      const attributeName = key.slice(5);

      if (attributeName !== INTERNAL_SELECTION_ATTRIBUTE && !COMMON_ATTRIBUTE_NAMES.has(attributeName) && isEditableRawAttribute(attributeName)) {
        setAttributeValue(element, attributeName, value);
      }

      return;
    }

    if (key.startsWith('style:')) {
      const styleName = key.slice(6);

      if (ADVANCED_STYLE_NAMES.has(styleName)) {
        setStyleValue(element, styleName, value);
      }
    }
  });

  return { errors };
}
