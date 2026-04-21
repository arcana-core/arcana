export const SUPPORTED_OPERATIONS = new Set([
  'setText',
  'setHtml',
  'setImageSrc',
  'setStyle',
  'toggleClass',
  'setAttribute',
  'insertNode',
  'removeNode',
]);

export function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

export function collectSchemaFields(schema, prefix = '', output = []) {
  const normalizedSchema = ensureObject(schema, 'Manifest schema');
  const properties = ensureObject(normalizedSchema.properties, 'Manifest schema.properties');

  for (const [propertyName, property] of Object.entries(properties)) {
    ensureObject(property, `Schema property "${propertyName}"`);

    const fieldPath = prefix ? `${prefix}.${propertyName}` : propertyName;

    if (property.type === 'object' && property.properties) {
      collectSchemaFields(property, fieldPath, output);
      continue;
    }

    output.push(fieldPath);
  }

  return output;
}

export function normalizeManifest(rawManifest) {
  const manifest = ensureObject(rawManifest, 'Manifest');
  const schema = ensureObject(manifest.schema, 'Manifest schema');
  const bindings = manifest.bindings;

  if (schema.type !== 'object') {
    throw new Error('Manifest schema must declare type "object".');
  }

  if (!Array.isArray(bindings) || bindings.length === 0) {
    throw new Error('Manifest bindings must be a non-empty array.');
  }

  const fieldPaths = collectSchemaFields(schema);
  const knownFields = new Set(fieldPaths);

  const normalizedBindings = bindings.map((binding, index) => {
    const normalizedBinding = ensureObject(binding, `Manifest binding at index ${index}`);
    const field = typeof normalizedBinding.field === 'string' ? normalizedBinding.field.trim() : '';
    const selector = typeof normalizedBinding.selector === 'string' ? normalizedBinding.selector.trim() : '';
    const op = typeof normalizedBinding.op === 'string' ? normalizedBinding.op.trim() : '';

    if (!field) {
      throw new Error(`Manifest binding at index ${index} must include a field.`);
    }

    if (!knownFields.has(field)) {
      throw new Error(`Unknown field "${field}" in manifest binding.`);
    }

    if (!selector) {
      throw new Error(`Manifest binding for field "${field}" must include a non-empty selector.`);
    }

    if (!SUPPORTED_OPERATIONS.has(op)) {
      throw new Error(`Unsupported operation "${op}" in manifest binding.`);
    }

    return {
      ...normalizedBinding,
      field,
      selector,
      op,
      target: typeof normalizedBinding.target === 'string' && normalizedBinding.target.trim()
        ? normalizedBinding.target.trim()
        : null,
      options: normalizedBinding.options === undefined
        ? {}
        : ensureObject(normalizedBinding.options, `Manifest binding options for field "${field}"`),
    };
  });

  const normalizedUi = manifest.ui === undefined
    ? { order: fieldPaths, sections: [] }
    : ensureObject(manifest.ui, 'Manifest ui');

  return {
    ...manifest,
    version: typeof manifest.version === 'number' ? manifest.version : 1,
    title: typeof manifest.title === 'string' && manifest.title.trim() ? manifest.title.trim() : 'Untitled manifest',
    description: typeof manifest.description === 'string' ? manifest.description : '',
    schema,
    bindings: normalizedBindings,
    ui: normalizedUi,
  };
}
