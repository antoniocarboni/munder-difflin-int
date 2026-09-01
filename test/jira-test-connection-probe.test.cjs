'use strict';

// Settings → Integrations → "Test Connection" on the Jira row sent NO path, so the
// probe hit the bare configured base URL (`…/rest/api/3`), which Jira answers with
// 404 — a correctly configured integration reported as broken. The probe must fall
// back to Jira's canonical identity endpoint (`GET /rest/api/3/myself`) while
// leaving the user's configured base URL untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-test-conn-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData }, safeStorage: { isEncryptionAvailable: () => false } }
};

const now = Date.now();
const record = (over) => ({
  label: 'Jira', kind: 'custom-rest', authType: 'header', authHeader: 'Authorization',
  enabled: true, createdAt: now, updatedAt: now, ...over
});
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  integrations: [
    record({ id: 'jira', baseUrl: 'https://example.atlassian.net/rest/api/3', secretRef: 'int:jira' }),
    record({ id: 'notion', label: 'Notion', authType: 'bearer', authHeader: undefined,
             baseUrl: 'https://api.notion.com/v1', secretRef: 'int:notion' }),
    record({ id: 'nonjira', label: 'Non-Jira', authType: 'bearer', authHeader: undefined,
             baseUrl: 'https://nonjira.example.com/rest/api/3', secretRef: 'int:nonjira' })
  ]
}));

const { probeRecord } = loadTs('src/main/integrations.ts');

const realFetch = globalThis.fetch;
let seen = [];
globalThis.fetch = async (url) => { seen.push(String(url)); return { ok: true, status: 200 }; };
test.beforeEach(() => { seen = []; });
test.after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(userData, { recursive: true, force: true });
});

test('Test Connection on Jira probes /myself under the configured base URL', async () => {
  const res = await probeRecord('jira');
  assert.deepEqual(seen, ['https://example.atlassian.net/rest/api/3/myself']);
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
});

test('an explicit probe path still wins over the default', async () => {
  await probeRecord('jira', '/project/ABC');
  assert.deepEqual(seen, ['https://example.atlassian.net/rest/api/3/project/ABC']);
});

test('a non-Jira integration still probes its own base URL root', async () => {
  await probeRecord('notion');
  assert.deepEqual(seen, ['https://api.notion.com/v1/']);
});

test('a non-Jira integration with a /rest/api/<n>-shaped base still probes its own root', async () => {
  await probeRecord('nonjira');
  assert.deepEqual(seen, ['https://nonjira.example.com/rest/api/3/']);
});
