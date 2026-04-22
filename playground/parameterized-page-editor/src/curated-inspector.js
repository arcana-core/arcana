import { collectSchemaFields, getSchemaProperty } from './manifest.js';

export const SUPPORTED_CURATED_OPERATIONS = new Set([
  'setText',
  'setImageSrc',
  'setAttribute',
  'setStyle',
]);

export function createCuratedFieldKey(fieldPath) {
  return `curated:${fieldPath}`;
}

function getAttributeValue(element, name) {
  const value = element.getAttribute?.(name);
  return typeof value === 'string' ? value : '';
}

function setAttributeValue(element, name, value) {
  const nextValue = String(value ?? '').trim();

  if (!nextValue) {
    element.removeAttribute?.(name);
    return;
  }

  element.setAttribute?.(name, nextValue);
}

function cleanupEmptyStyleAttribute(element) {
  const inlineStyle = getAttributeValue(element, 'style');

  if (!inlineStyle.trim()) {
    element.removeAttribute?.('style');
  }
}

function setStyleValue(element, name, value) {
  const nextValue = String(value ?? '').trim();

  if (!nextValue) {
    element.style?.removeProperty?.(name);
    cleanupEmptyStyleAttribute(element);
    return;
  }

  element.style?.setProperty?.(name, nextValue);
  cleanupEmptyStyleAttribute(element);
}

function getStyleValue(element, name) {
  const styleValue = element.style?.getPropertyValue?.(name);

  if (typeof styleValue === 'string' && styleValue) {
    return styleValue;
  }

  return '';
}

function bindingMatchesElement(element, binding) {
  if (!element || typeof element.matches !== 'function') {
    return false;
  }

  try {
    return element.matches(binding.selector);
  } catch {
    return false;
  }
}

function readBindingValue(element, binding) {
  switch (binding.op) {
    case 'setText':
      return typeof element.textContent === 'string' ? element.textContent.trim() : '';
    case 'setImageSrc':
      return getAttributeValue(element, 'src');
    case 'setAttribute':
      return binding.target ? getAttributeValue(element, binding.target) : '';
    case 'setStyle':
      return binding.target ? getStyleValue(element, binding.target) : '';
    default:
      return '';
  }
}

function applyBindingValue(element, binding, value) {
  switch (binding.op) {
    case 'setText':
      element.textContent = value;
      break;
    case 'setImageSrc':
      setAttributeValue(element, 'src', value);
      break;
    case 'setAttribute':
      if (binding.target) {
        setAttributeValue(element, binding.target, value);
      }
      break;
    case 'setStyle':
      if (binding.target) {
        setStyleValue(element, binding.target, value);
      }
      break;
    default:
      break;
  }
}

function getOrderedFieldPaths(manifest) {
  const configuredOrder = Array.isArray(manifest?.ui?.order) ? manifest.ui.order : [];
  const knownFields = new Set(collectSchemaFields(manifest.schema));
  const orderedPaths = [];

  configuredOrder.forEach((fieldPath) => {
    if (knownFields.has(fieldPath) && !orderedPaths.includes(fieldPath)) {
      orderedPaths.push(fieldPath);
    }
  });

  knownFields.forEach((fieldPath) => {
    if (!orderedPaths.includes(fieldPath)) {
      orderedPaths.push(fieldPath);
    }
  });

  return orderedPaths;
}

function getFieldLabel(manifest, fieldPath) {
  const property = getSchemaProperty(manifest.schema, fieldPath);
  const title = typeof property?.title === 'string' ? property.title.trim() : '';
  return title || fieldPath;
}

export function deriveCuratedInspectorModel(manifest, element) {
  if (!manifest || !element) {
    return { fields: [], values: {} };
  }

  const fields = [];
  const values = {};

  getOrderedFieldPaths(manifest).forEach((fieldPath) => {
    const bindings = manifest.bindings.filter((binding) => (
      binding.field === fieldPath
      && SUPPORTED_CURATED_OPERATIONS.has(binding.op)
      && bindingMatchesElement(element, binding)
    ));

    if (bindings.length === 0) {
      return;
    }

    const value = readBindingValue(element, bindings[0]);
    const control = bindings.some((binding) => binding.op === 'setText') ? 'textarea' : 'text';

    fields.push({
      key: fieldPath,
      inputKey: createCuratedFieldKey(fieldPath),
      label: getFieldLabel(manifest, fieldPath),
      value,
      editable: true,
      control,
      placeholder: '',
      bindings,
    });
    values[fieldPath] = value;
  });

  return { fields, values };
}

export function applyCuratedInspectorValues(element, values, fields) {
  const errors = [];

  fields.forEach((field) => {
    if (typeof values[field.key] !== 'string') {
      return;
    }

    field.bindings.forEach((binding) => {
      if (!bindingMatchesElement(element, binding)) {
        return;
      }

      applyBindingValue(element, binding, values[field.key]);
    });
  });

  return { errors };
}
