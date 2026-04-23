import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveInspectorModel, applyInspectorValues } from '../src/default-inspector.js';
import {
  deriveCuratedInspectorModel,
  applyCuratedInspectorValues,
} from '../src/curated-inspector.js';

function createElementStub({
  tagName,
  textContent = '',
  className = '',
  id = '',
  attributes = [],
  childElementCount = 0,
}) {
  const attributeMap = new Map(attributes.map((attribute) => [attribute.name, attribute.value]));
  const styleMap = new Map();

  const element = {
    tagName: tagName.toUpperCase(),
    textContent,
    className,
    id,
    childElementCount,
    get classList() {
      return element.className.split(/\s+/).filter(Boolean);
    },
    get children() {
      return { length: childElementCount };
    },
    get attributes() {
      return Array.from(attributeMap.entries()).map(([name, value]) => ({ name, value }));
    },
    style: {
      getPropertyValue(name) {
        return styleMap.get(name) || '';
      },
      setProperty(name, value) {
        styleMap.set(name, value);
        syncStyleAttribute();
      },
      removeProperty(name) {
        const current = styleMap.get(name) || '';
        styleMap.delete(name);
        syncStyleAttribute();
        return current;
      },
    },
    getAttribute(name) {
      return attributeMap.has(name) ? attributeMap.get(name) : null;
    },
    matches(selector) {
      const normalized = String(selector || '').trim();

      if (!normalized) {
        return false;
      }

      if (normalized.startsWith('.')) {
        return element.classList.includes(normalized.slice(1));
      }

      if (normalized.startsWith('#')) {
        return element.id === normalized.slice(1);
      }

      return normalized.toLowerCase() === element.tagName.toLowerCase();
    },
    setAttribute(name, value) {
      const normalized = String(value);
      attributeMap.set(name, normalized);

      if (name === 'class') {
        element.className = normalized;
      }

      if (name === 'id') {
        element.id = normalized;
      }

      if (name === 'style') {
        resetStyleMap(normalized);
      }
    },
    removeAttribute(name) {
      attributeMap.delete(name);

      if (name === 'class') {
        element.className = '';
      }

      if (name === 'id') {
        element.id = '';
      }

      if (name === 'style') {
        styleMap.clear();
      }
    },
  };

  function resetStyleMap(styleText) {
    styleMap.clear();

    styleText
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => {
        const separatorIndex = part.indexOf(':');

        if (separatorIndex === -1) {
          return;
        }

        const property = part.slice(0, separatorIndex).trim();
        const value = part.slice(separatorIndex + 1).trim();

        if (property && value) {
          styleMap.set(property, value);
        }
      });
  }

  function syncStyleAttribute() {
    if (styleMap.size === 0) {
      attributeMap.delete('style');
      return;
    }

    const inlineStyle = Array.from(styleMap.entries())
      .map(([name, value]) => `${name}: ${value}`)
      .join('; ');

    attributeMap.set('style', inlineStyle);
  }

  const inlineStyle = attributeMap.get('style');

  if (inlineStyle) {
    resetStyleMap(inlineStyle);
  }

  return element;
}

function createViewStub(style) {
  return {
    getComputedStyle() {
      return {
        display: '',
        visibility: '',
        color: '',
        backgroundColor: '',
        marginTop: '',
        marginRight: '',
        marginBottom: '',
        marginLeft: '',
        paddingTop: '',
        paddingRight: '',
        paddingBottom: '',
        paddingLeft: '',
        width: '',
        height: '',
        ...style,
      };
    },
  };
}

function sectionLabels(model, key) {
  return model.sections[key].map((field) => field.label);
}

test('deriveInspectorModel derives common fields for text-like elements', () => {
  const element = createElementStub({
    tagName: 'h1',
    textContent: 'Arcana Editor',
    className: 'hero-title',
    id: 'headline',
    attributes: [
      { name: 'id', value: 'headline' },
      { name: 'class', value: 'hero-title' },
      { name: 'title', value: 'Hero headline' },
      { name: 'aria-label', value: 'Arcana Editor' },
      { name: 'data-tone', value: 'warm' },
      { name: 'style', value: 'color: rgb(20, 30, 40);' },
    ],
  });
  const model = deriveInspectorModel(element, createViewStub({}));

  assert.equal(model.label, 'h1#headline.hero-title');
  assert.deepEqual(sectionLabels(model, 'content'), ['Text']);
  assert.deepEqual(sectionLabels(model, 'layout'), ['Display', 'Visibility', 'Spacing']);
  assert.deepEqual(sectionLabels(model, 'style'), ['Text color', 'Background', 'Inline style', 'Class names']);
  assert.equal(model.sections.style[0].value, 'rgb(20, 30, 40)');
  assert.equal(model.sections.attributes[0].label, 'Id');
  assert.equal(model.sections.content[0].editable, true);
  assert.equal(model.sections.style[0].editable, true);
  assert.equal(model.sections.style[1].editable, true);
  assert.equal(model.sections.style[2].editable, false);
  assert.equal(model.sections.style[3].editable, true);
  assert.deepEqual(
    model.sections.attributes.map((field) => ({
      key: field.key,
      label: field.label,
      editable: field.editable,
      value: field.value,
    })),
    [
      { key: 'attr:id', label: 'Id', editable: true, value: 'headline' },
      { key: 'attr:title', label: 'Title', editable: true, value: 'Hero headline' },
      { key: 'attr:role', label: 'Role', editable: true, value: '' },
      { key: 'attr:aria-label', label: 'aria-label', editable: true, value: 'Arcana Editor' },
      { key: 'attr:data-tone', label: 'data-tone', editable: true, value: 'warm' },
    ],
  );
  assert.deepEqual(
    model.sections.advanced.map((field) => field.label),
    ['Margin', 'Padding', 'Border', 'Border radius', 'Opacity', 'Font size', 'Line height', 'Letter spacing'],
  );
  assert.equal(model.sections.advanced[0].editable, true);
});

test('deriveInspectorModel derives link fields', () => {
  const element = createElementStub({
    tagName: 'a',
    textContent: 'See pricing',
    className: 'hero-link',
    attributes: [
      { name: 'class', value: 'hero-link' },
      { name: 'href', value: '/pricing' },
      { name: 'target', value: '_blank' },
    ],
  });
  const model = deriveInspectorModel(element, createViewStub({}));

  assert.deepEqual(sectionLabels(model, 'content'), ['Text', 'Href', 'Target']);
  assert.equal(model.sections.content[1].value, '/pricing');
  assert.equal(model.sections.content[2].value, '_blank');
  assert.deepEqual(
    model.sections.attributes.map((field) => field.key),
    ['attr:id', 'attr:title', 'attr:role'],
  );
});

test('deriveInspectorModel derives image fields', () => {
  const element = createElementStub({
    tagName: 'img',
    className: 'hero-image',
    attributes: [
      { name: 'class', value: 'hero-image' },
      { name: 'src', value: '/hero.png' },
      { name: 'alt', value: 'Hero image' },
      { name: 'width', value: '640' },
      { name: 'height', value: '360' },
    ],
  });
  const model = deriveInspectorModel(element, createViewStub({}));

  assert.deepEqual(sectionLabels(model, 'content'), ['Src', 'Alt']);
  assert.deepEqual(sectionLabels(model, 'layout'), ['Display', 'Visibility', 'Spacing', 'Width', 'Height']);
  assert.deepEqual(sectionLabels(model, 'style'), ['Background', 'Class names']);
  assert.equal(model.sections.content[0].value, '/hero.png');
  assert.equal(model.sections.content[1].value, 'Hero image');
  assert.equal(model.sections.layout[3].editable, true);
  assert.equal(model.sections.layout[4].editable, true);
});

test('deriveInspectorModel derives generic container fields without invented content inputs', () => {
  const element = createElementStub({
    tagName: 'div',
    className: 'hero-shell',
    id: 'shell',
    childElementCount: 1,
    attributes: [
      { name: 'id', value: 'shell' },
      { name: 'class', value: 'hero-shell' },
    ],
  });
  const model = deriveInspectorModel(element, createViewStub({}));

  assert.deepEqual(sectionLabels(model, 'content'), ['Content']);
  assert.equal(model.sections.content[0].muted, true);
  assert.deepEqual(sectionLabels(model, 'layout'), ['Display', 'Visibility', 'Spacing']);
  assert.deepEqual(sectionLabels(model, 'style'), ['Background', 'Inline style', 'Class names']);
  assert.equal(model.sections.attributes[0].label, 'Id');
});

test('deriveInspectorModel exposes text editing for plain-text div containers', () => {
  const element = createElementStub({
    tagName: 'div',
    className: 'start-subtitle',
    textContent: '明宫残卷',
    attributes: [
      { name: 'class', value: 'start-subtitle' },
    ],
  });
  const model = deriveInspectorModel(element, createViewStub({}));

  assert.deepEqual(sectionLabels(model, 'content'), ['Text']);
  assert.equal(model.sections.content[0].editable, true);
  assert.equal(model.sections.content[0].value, '明宫残卷');
});

test('deriveInspectorModel excludes internal and common attributes while exposing safe editable attribute and advanced style fields', () => {
  const element = createElementStub({
    tagName: 'a',
    textContent: 'Open docs',
    className: 'hero-link',
    id: 'docs-link',
    attributes: [
      { name: 'id', value: 'docs-link' },
      { name: 'class', value: 'hero-link' },
      { name: 'href', value: '/docs' },
      { name: 'target', value: '_blank' },
      { name: 'title', value: 'Read the docs' },
      { name: 'role', value: 'button' },
      { name: 'aria-label', value: 'Open documentation' },
      { name: 'data-variant', value: 'primary' },
      { name: 'data-arcana-selected-element', value: 'true' },
      {
        name: 'style',
        value: 'margin: 12px; padding: 8px; border-radius: 24px; font-size: 2rem; line-height: 1.2',
      },
    ],
  });
  const model = deriveInspectorModel(element, createViewStub({}));

  assert.deepEqual(
    model.sections.attributes.map((field) => field.key),
    ['attr:id', 'attr:title', 'attr:role', 'attr:aria-label', 'attr:data-variant'],
  );
  assert.equal(model.sections.attributes.some((field) => field.label === 'href'), false);
  assert.equal(model.sections.attributes.some((field) => field.label === 'class'), false);
  assert.equal(model.sections.attributes.some((field) => field.label === 'data-arcana-selected-element'), false);
  assert.deepEqual(
    model.sections.advanced.map((field) => [field.key, field.value]),
    [
      ['style:margin', '12px'],
      ['style:padding', '8px'],
      ['style:border', ''],
      ['style:border-radius', '24px'],
      ['style:opacity', ''],
      ['style:font-size', '2rem'],
      ['style:line-height', '1.2'],
      ['style:letter-spacing', ''],
    ],
  );
});

test('applyInspectorValues writes editable fields and removes cleared attributes/styles', () => {
  const element = createElementStub({
    tagName: 'a',
    textContent: 'See pricing',
    className: 'hero-link cta',
    attributes: [
      { name: 'class', value: 'hero-link cta' },
      { name: 'href', value: '/pricing' },
      { name: 'target', value: '_blank' },
      { name: 'style', value: 'color: rgb(20, 30, 40); background: peachpuff; display: inline-flex; visibility: visible' },
    ],
  });

  applyInspectorValues(element, {
    text: 'Read docs',
    href: '/docs',
    target: '',
    classNames: 'hero-link hero-link-updated',
    textColor: '',
    background: 'papayawhip',
    display: 'block',
    visibility: '',
  });

  assert.equal(element.textContent, 'Read docs');
  assert.equal(element.getAttribute('href'), '/docs');
  assert.equal(element.getAttribute('target'), null);
  assert.equal(element.getAttribute('class'), 'hero-link hero-link-updated');
  assert.equal(element.style.getPropertyValue('color'), '');
  assert.equal(element.style.getPropertyValue('background'), 'papayawhip');
  assert.equal(element.style.getPropertyValue('display'), 'block');
  assert.equal(element.style.getPropertyValue('visibility'), '');
});

test('applyInspectorValues validates and clears image dimensions explicitly', () => {
  const element = createElementStub({
    tagName: 'img',
    className: 'hero-image',
    attributes: [
      { name: 'class', value: 'hero-image' },
      { name: 'src', value: '/hero.png' },
      { name: 'alt', value: 'Hero image' },
      { name: 'width', value: '640' },
      { name: 'height', value: '360' },
      { name: 'style', value: 'background-color: pink' },
    ],
  });

  const result = applyInspectorValues(element, {
    src: '/next.png',
    alt: '',
    width: '',
    height: 'wide',
    background: '',
    classNames: '',
  });

  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Height must be a whole number/i);
  assert.equal(element.getAttribute('src'), '/next.png');
  assert.equal(element.getAttribute('alt'), null);
  assert.equal(element.getAttribute('width'), null);
  assert.equal(element.getAttribute('height'), '360');
  assert.equal(element.getAttribute('class'), null);
  assert.equal(element.getAttribute('style'), null);
});

test('applyInspectorValues applies editable attribute and advanced style fields conservatively', () => {
  const element = createElementStub({
    tagName: 'div',
    className: 'hero-shell',
    id: 'shell',
    attributes: [
      { name: 'id', value: 'shell' },
      { name: 'class', value: 'hero-shell' },
      { name: 'title', value: 'Hero shell' },
      { name: 'role', value: 'region' },
      { name: 'aria-label', value: 'Shell' },
      { name: 'data-tone', value: 'warm' },
      {
        name: 'style',
        value: 'margin: 12px; padding: 8px; border-radius: 24px; opacity: 0.8; font-size: 1.25rem',
      },
    ],
  });

  applyInspectorValues(element, {
    'attr:id': 'shell-updated',
    'attr:title': '',
    'attr:role': 'presentation',
    'attr:aria-label': 'Updated shell',
    'attr:data-tone': '',
    'style:margin': '24px 12px',
    'style:padding': '',
    'style:border': '1px solid tomato',
    'style:border-radius': '',
    'style:opacity': '0.95',
    'style:font-size': '2rem',
    'style:line-height': '1.4',
    'style:letter-spacing': '0.08em',
  });

  assert.equal(element.getAttribute('id'), 'shell-updated');
  assert.equal(element.getAttribute('title'), null);
  assert.equal(element.getAttribute('role'), 'presentation');
  assert.equal(element.getAttribute('aria-label'), 'Updated shell');
  assert.equal(element.getAttribute('data-tone'), null);
  assert.equal(element.style.getPropertyValue('margin'), '24px 12px');
  assert.equal(element.style.getPropertyValue('padding'), '');
  assert.equal(element.style.getPropertyValue('border'), '1px solid tomato');
  assert.equal(element.style.getPropertyValue('border-radius'), '');
  assert.equal(element.style.getPropertyValue('opacity'), '0.95');
  assert.equal(element.style.getPropertyValue('font-size'), '2rem');
  assert.equal(element.style.getPropertyValue('line-height'), '1.4');
  assert.equal(element.style.getPropertyValue('letter-spacing'), '0.08em');
});

test('applyInspectorValues updates plain-text div containers through the shared text field', () => {
  const element = createElementStub({
    tagName: 'div',
    className: 'start-subtitle',
    textContent: '明宫残卷',
    attributes: [
      { name: 'class', value: 'start-subtitle' },
    ],
  });

  applyInspectorValues(element, {
    text: '紫禁疑云',
  });

  assert.equal(element.textContent, '紫禁疑云');
});

test('deriveCuratedInspectorModel only returns matching supported fields ordered by manifest ui.order', () => {
  const element = createElementStub({
    tagName: 'h1',
    textContent: 'Arcana Editor',
    className: 'hero-title',
    attributes: [
      { name: 'class', value: 'hero-title' },
      { name: 'data-tone', value: 'warm' },
      { name: 'style', value: 'color: tomato' },
    ],
  });
  const manifest = {
    schema: {
      type: 'object',
      properties: {
        headline: { type: 'string', title: 'Headline' },
        tone: { type: 'string', title: 'Tone' },
        accent: { type: 'string', title: 'Accent' },
        hidden: { type: 'string', title: 'Hidden' },
      },
    },
    ui: {
      order: ['tone', 'headline', 'accent', 'hidden'],
    },
    bindings: [
      { field: 'headline', selector: '.hero-title', op: 'setText', target: null, options: {} },
      { field: 'headline', selector: '.hero-title', op: 'setAttribute', target: 'aria-label', options: {} },
      { field: 'tone', selector: '.hero-title', op: 'setAttribute', target: 'data-tone', options: {} },
      { field: 'accent', selector: '.hero-title', op: 'setStyle', target: 'color', options: {} },
      { field: 'hidden', selector: '.other-node', op: 'setText', target: null, options: {} },
      { field: 'headline', selector: '.hero-title', op: 'setHtml', target: null, options: {} },
    ],
  };

  const model = deriveCuratedInspectorModel(manifest, element);

  assert.deepEqual(model.fields.map((field) => field.key), ['tone', 'headline', 'accent']);
  assert.deepEqual(model.fields.map((field) => field.label), ['Tone', 'Headline', 'Accent']);
  assert.equal(model.values.tone, 'warm');
  assert.equal(model.values.headline, 'Arcana Editor');
  assert.equal(model.values.accent, 'tomato');
  assert.equal(model.fields[1].bindings.length, 2);
  assert.deepEqual(model.fields[1].bindings.map((binding) => binding.op), ['setText', 'setAttribute']);
});

test('applyCuratedInspectorValues writes matching text, attribute, style, and image bindings only to the selected element', () => {
  const titleElement = createElementStub({
    tagName: 'h1',
    textContent: 'Arcana Editor',
    className: 'hero-title',
    attributes: [
      { name: 'class', value: 'hero-title' },
      { name: 'data-tone', value: 'warm' },
      { name: 'style', value: 'color: tomato' },
      { name: 'aria-label', value: 'Arcana Editor' },
    ],
  });
  const imageElement = createElementStub({
    tagName: 'img',
    className: 'hero-image',
    attributes: [
      { name: 'class', value: 'hero-image' },
      { name: 'src', value: '/hero.png' },
    ],
  });
  const manifest = {
    schema: {
      type: 'object',
      properties: {
        headline: { type: 'string', title: 'Headline' },
        tone: { type: 'string', title: 'Tone' },
        accent: { type: 'string', title: 'Accent' },
        image: { type: 'string', title: 'Hero Image' },
      },
    },
    ui: {
      order: ['headline', 'tone', 'accent', 'image'],
    },
    bindings: [
      { field: 'headline', selector: '.hero-title', op: 'setText', target: null, options: {} },
      { field: 'headline', selector: '.hero-title', op: 'setAttribute', target: 'aria-label', options: {} },
      { field: 'tone', selector: '.hero-title', op: 'setAttribute', target: 'data-tone', options: {} },
      { field: 'accent', selector: '.hero-title', op: 'setStyle', target: 'color', options: {} },
      { field: 'image', selector: '.hero-image', op: 'setImageSrc', target: null, options: {} },
      { field: 'headline', selector: '.other-node', op: 'setText', target: null, options: {} },
    ],
  };

  const titleModel = deriveCuratedInspectorModel(manifest, titleElement);
  const titleResult = applyCuratedInspectorValues(titleElement, {
    headline: 'Arcana Launch',
    tone: 'cool',
    accent: 'royalblue',
    image: '/ignored.png',
  }, titleModel.fields);

  assert.deepEqual(titleResult.errors, []);
  assert.equal(titleElement.textContent, 'Arcana Launch');
  assert.equal(titleElement.getAttribute('aria-label'), 'Arcana Launch');
  assert.equal(titleElement.getAttribute('data-tone'), 'cool');
  assert.equal(titleElement.style.getPropertyValue('color'), 'royalblue');
  assert.equal(imageElement.getAttribute('src'), '/hero.png');

  const imageModel = deriveCuratedInspectorModel(manifest, imageElement);
  applyCuratedInspectorValues(imageElement, {
    image: '/updated.png',
    headline: 'Ignored on image selection',
  }, imageModel.fields);

  assert.equal(imageElement.getAttribute('src'), '/updated.png');
});
