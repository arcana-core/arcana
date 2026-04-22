import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveInspectorModel } from '../src/default-inspector.js';

function createElementStub({
  tagName,
  textContent = '',
  className = '',
  id = '',
  attributes = [],
}) {
  const attributeMap = new Map(attributes.map((attribute) => [attribute.name, attribute.value]));
  const classList = className.split(/\s+/).filter(Boolean);

  return {
    tagName: tagName.toUpperCase(),
    textContent,
    className,
    classList,
    id,
    attributes: attributes.map((attribute) => ({ ...attribute })),
    getAttribute(name) {
      return attributeMap.has(name) ? attributeMap.get(name) : null;
    },
  };
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
