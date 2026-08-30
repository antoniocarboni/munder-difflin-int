'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// integrations.ts reads readConfig() (electron app.getPath), so it needs the
// same mock as test/config-write-notify.test.cjs, pointed at a throwaway dir.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-probe-record-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData }, safeStorage: { isEncryptionAvailable: () => false } }
};

const { probeRecord } = loadTs('src/main/integrations.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('probeRecord returns an error for an unknown integration id', async () => {
  const res = await probeRecord('does-not-exist');
  assert.equal(res.ok, false);
  assert.match(res.error, /unknown integration/);
});
