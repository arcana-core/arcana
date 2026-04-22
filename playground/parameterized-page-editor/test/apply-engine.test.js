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
}) {
  const attributeMap = new Map(attributes.map((attribute) => [attribute.name, attribute.value]));
  const styleMap = new Map();

  const element = {
    tagName: tagName.toUpperCase(),
    textContent,
    className,
    id,
    get classList() {
      return element.className.split(/\s+/).filter(Boolean);
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
    attributes: [
      { name: 'class', value: 'hero-title' },
      { name: 'style', value: 'color: rgb(20, 30, 40);' },
    ],
  });
  const model = deriveInspectorModel(element, createViewStub({}));

  assert.equal(model.label, 'h1.hero-title');
  assert.deepEqual(sectionLabels(model, 'content'), ['Text']);
  assert.deepEqual(sectionLabels(model, 'layout'), ['Display', 'Visibility', 'Spacing']);
  assert.deepEqual(sectionLabels(model, 'style'), ['Text color', 'Background', 'Inline style', 'Class names']);
  assert.equal(model.sections.style[0].value, 'rgb(20, 30, 40)');
  assert.equal(model.sections.attributes[0].label, 'class');
  assert.equal(model.sections.content[0].editable, true);
  assert.equal(model.sections.style[0].editable, true);
  assert.equal(model.sections.style[1].editable, true);
  assert.equal(model.sections.style[2].editable, false);
  assert.equal(model.sections.style[3].editable, true);
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
  assert.equal(model.sections.attributes[1].label, 'href');
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
  assert.equal(model.sections.attributes[0].label, 'id');
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
