'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const ap = loadTs('src/shared/agentProvider.ts');

test('deepcode is a recognized, selectable provider', () => {
  assert.ok(ap.isAgentProvider('deepcode'));
  assert.ok(ap.AGENT_PROVIDER_PRESETS.some((p) => p.id === 'deepcode'));
});

test('deepcode preset uses a hooks bridge with the deepcode shim, not a proxy bridge', () => {
  const p = ap.providerPreset('deepcode');
  assert.deepEqual(p.bridge, { kind: 'hooks', shim: 'deepcode' });
  assert.equal(ap.bridgeOf('deepcode')?.kind, 'hooks');
});

test('deepcode preset has no CLI model flag and delivers the model via its settings file instead', () => {
  const p = ap.providerPreset('deepcode');
  assert.equal(p.supportsModel, true);
  assert.equal(p.modelFlag, undefined);
  assert.equal(p.modelDeliveredVia, 'settingsFile');
});

test('deepcode preset takes its initial hive prompt under -p and resumes with --resume', () => {
  const p = ap.providerPreset('deepcode');
  assert.equal(p.initialPromptFlag, '-p');
  assert.equal(p.resumeFlag, '--resume');
});

test('deepcode is not hiveAware (it is not Claude) and has no autoFlag (permissions are file-config, not argv)', () => {
  const p = ap.providerPreset('deepcode');
  assert.equal(p.hiveAware, false);
  assert.equal(p.autoFlag, undefined);
});

test('every existing provider is unaffected: modelDeliveredVia is undefined for all of them', () => {
  for (const p of ap.AGENT_PROVIDER_PRESETS) {
    if (p.id === 'deepcode') continue;
    assert.equal(p.modelDeliveredVia, undefined, `${p.id} should not have modelDeliveredVia set`);
  }
});
