import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate, validateText, serialize } from './validate.mjs';
import { clean, pluginDirOf, frontmatter, readmeTitle, detectLicense, slug } from './build.mjs';

const SHA = 'a'.repeat(40);
const plugin = (over = {}) => ({
  id: 'demo',
  name: 'Demo',
  description: 'Does a thing.',
  categories: ['productivity'],
  publisher: { name: 'Ada', url: 'https://example.com' },
  license: 'MIT',
  source: { repo: 'https://github.com/o/r', sha: SHA, path: 'plugins/demo' },
  logo: `https://raw.githubusercontent.com/o/r/${SHA}/plugins/demo/logo.svg`,
  servers: ['demo'],
  skills: ['a', 'b'],
  ...over,
});
const cat = (plugins) => ({ v: 1, generatedAt: '2026-11-01T00:00:00Z', plugins });
const errs = (p) => validate(cat([p]));

test('a well-formed catalog passes', () => {
  assert.deepEqual(validate(cat([plugin(), plugin({ id: 'other', fields: [{ key: 'API_KEY', label: 'API key', secret: true }], generated: ['description'] })])), []);
});

test('the committed catalog.json passes', () => {
  const text = readFileSync(new URL('../catalog.json', import.meta.url), 'utf8');
  assert.deepEqual(validateText(text), []);
  assert.equal(serialize(JSON.parse(text)), text);
});

test('ids: pattern, unique, sorted', () => {
  for (const id of ['', 'Demo', '-x', 'a_b', 'x'.repeat(65)]) assert.ok(errs(plugin({ id })).some((e) => e.includes('.id')), id);
  assert.ok(validate(cat([plugin(), plugin()])).some((e) => e.includes('duplicate id')));
  assert.ok(validate(cat([plugin({ id: 'b' }), plugin({ id: 'a' })])).some((e) => e.includes('sorted by id')));
});

test('source: github https repo, 40-hex sha, safe path', () => {
  assert.ok(errs(plugin({ source: { repo: 'http://github.com/o/r', sha: SHA, path: '' } })).some((e) => e.includes('source.repo')));
  assert.ok(errs(plugin({ source: { repo: 'https://gitlab.com/o/r', sha: SHA, path: '' } })).some((e) => e.includes('source.repo')));
  assert.ok(errs(plugin({ source: { repo: 'https://github.com/o/r', sha: 'abc', path: '' }, logo: undefined })).some((e) => e.includes('source.sha')));
  assert.ok(errs(plugin({ source: { repo: 'https://github.com/o/r', sha: SHA.toUpperCase(), path: '' } })).some((e) => e.includes('source.sha')));
  for (const path of ['../x', '/abs', 'a/', 'a/./b', 'a//b'])
    assert.ok(errs(plugin({ source: { repo: 'https://github.com/o/r', sha: SHA, path } })).some((e) => e.includes('source.path')), path);
});

test('urls must be https; the logo must live in the source repo at its sha', () => {
  assert.ok(errs(plugin({ homepage: 'http://example.com' })).some((e) => e.includes('homepage')));
  assert.ok(errs(plugin({ homepage: 'javascript:alert(1)' })).some((e) => e.includes('homepage')));
  assert.ok(errs(plugin({ publisher: { name: 'Ada', url: 'ftp://x' } })).some((e) => e.includes('publisher.url')));
  assert.ok(errs(plugin({ logo: 'https://example.com/logo.png' })).some((e) => e.includes('.logo')));
  assert.ok(errs(plugin({ logo: `https://raw.githubusercontent.com/o/r/${'b'.repeat(40)}/logo.png` })).some((e) => e.includes('.logo')));
});

test('sizes and shapes', () => {
  assert.ok(errs(plugin({ description: 'x'.repeat(2001) })).some((e) => e.includes('description')));
  assert.ok(errs(plugin({ description: '' })).some((e) => e.includes('description')));
  assert.ok(errs(plugin({ skills: ['b', 'a'] })).some((e) => e.includes('sorted')));
  assert.ok(errs(plugin({ servers: ['x', 'x'] })).some((e) => e.includes('duplicate')));
  assert.ok(errs(plugin({ fields: [{ key: 'K', label: 'K', secret: 'yes' }] })).some((e) => e.includes('secret')));
  assert.ok(errs(plugin({ generated: ['name'] })).some((e) => e.includes('generated')));
  assert.ok(errs(plugin({ extra: 1 })).some((e) => e.includes('unknown key')));
  const { skills, ...noSkills } = plugin();
  assert.ok(errs(noSkills).some((e) => e.includes('missing skills')));
  assert.ok(validate({ v: 2, generatedAt: 'now', plugins: [] }).length === 2);
  assert.ok(validateText('{').some((e) => e.includes('not JSON')));
});

test('build helpers', () => {
  assert.equal(clean('./a/b/'), 'a/b');
  assert.equal(clean('../x'), null);
  assert.equal(pluginDirOf('x/.cursor-plugin/plugin.json'), 'x');
  assert.equal(pluginDirOf('.claude-plugin/plugin.json'), '');
  assert.equal(pluginDirOf('plugin.json'), '');
  assert.deepEqual(frontmatter('---\nname: "hello"\ndescription: Hi\n---\nbody'), { name: 'hello', description: 'Hi' });
  assert.equal(readmeTitle('intro\n# Chrome DevTools for agents\n'), 'Chrome DevTools for agents');
  assert.equal(readmeTitle('# <img src=x> Logo'), null);
  assert.equal(detectLicense('MIT License\n\nCopyright'), 'MIT');
  assert.equal(detectLicense('Licensed under the Apache License, Version 2.0 (the "License")'), 'Apache-2.0');
  assert.equal(detectLicense('All rights reserved.'), null);
  assert.equal(slug('Google Workspace MCP'), 'google-workspace-mcp');
});
