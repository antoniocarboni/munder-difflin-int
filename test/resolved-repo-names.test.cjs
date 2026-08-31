'use strict';

// src/renderer/src/hooks/useResolvedRepoNames.ts — extracted from
// FullscreenTerminal.tsx so every place an agent's bare name shows (Command
// Center pickers, restore toasts, detail headers) can tag it with the SAME
// reliably-resolved project label the roster already groups by. Only the
// pure functions are unit-tested here — `useResolvedRepoNames` itself needs
// a mounted React tree to exercise (it drives the async git lookup that
// fills the module-level cache these fall back from).

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { basename, repoKeyOf, repoLabelOf, projectTag } =
  loadTs('src/renderer/src/hooks/useResolvedRepoNames.ts');

function agent(overrides) {
  return { id: 'a1', name: 'Andy', cwd: '/Users/shaibon/www/burdastyle', isGod: false, ...overrides };
}

test('basename splits on both / and \\\\, so a Windows path works too', () => {
  assert.equal(basename('/Users/shaibon/www/burdastyle'), 'burdastyle');
  assert.equal(basename('C:\\work\\burdastyle'), 'burdastyle');
  assert.equal(basename('burdastyle'), 'burdastyle');
});

test('repoLabelOf falls back to agent.project before the git root resolves', () => {
  assert.equal(repoLabelOf(agent({ project: 'BurdaStyle' })), 'BurdaStyle');
});

test('repoLabelOf falls back to basename(cwd) when there is no project either', () => {
  assert.equal(repoLabelOf(agent({ project: undefined })), 'burdastyle');
});

test('repoLabelOf never returns empty, even for an agent with no cwd and no project', () => {
  assert.equal(repoLabelOf(agent({ cwd: '', project: undefined })), 'unknown');
});

test('repoKeyOf falls back to the raw cwd before the git root resolves', () => {
  assert.equal(repoKeyOf(agent()), '/Users/shaibon/www/burdastyle');
});

test('projectTag is empty for the god agent — there is only ever one, never ambiguous', () => {
  assert.equal(projectTag(agent({ isGod: true })), '');
});

test('projectTag is " · <label>" for everyone else', () => {
  assert.equal(projectTag(agent({ project: 'BurdaStyle' })), ' · BurdaStyle');
});

test('two same-named agents on different projects produce different tags', () => {
  const andyA = agent({ id: 'andy-1', cwd: '/repo/burdastyle', project: 'BurdaStyle' });
  const andyB = agent({ id: 'andy-2', cwd: '/repo/bravifarmacie', project: 'BravaFarmacie' });
  assert.notEqual(`${andyA.name}${projectTag(andyA)}`, `${andyB.name}${projectTag(andyB)}`);
});
