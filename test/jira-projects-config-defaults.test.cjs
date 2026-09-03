'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-jira-config-defaults-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { readConfig, JIRA_POLL_MISSION } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('a fresh config defaults jiraProjects to an empty list', () => {
  assert.deepEqual(readConfig().jiraProjects, []);
});

test('a fresh config defaults jiraPoll to the decided settings', () => {
  const cfg = readConfig();
  assert.equal(cfg.jiraPoll.pollIntervalMs, 300000);
  assert.equal(cfg.jiraPoll.assigneeFilter, 'currentUser');
  assert.equal(cfg.jiraPoll.statusFilter, 'To Do');
  assert.equal(cfg.jiraPoll.assigneeAllowlist, undefined);
});

test('a jiraPoll persisted before assigneeAllowlist existed still loads (no crash, no default list)', () => {
  const p = path.join(userData, 'config.json');
  fs.writeFileSync(p, JSON.stringify({
    onboardingComplete: true,
    registeredRepos: [],
    jiraPoll: { pollIntervalMs: 600000, assigneeFilter: 'currentUser', statusFilter: 'To Do' }
  }));
  const cfg = readConfig();
  assert.equal(cfg.jiraPoll.pollIntervalMs, 600000);
  assert.equal(cfg.jiraPoll.assigneeAllowlist, undefined);
});

test('JIRA_POLL_MISSION documents the assignee allow-list by accountId, additive to currentUser', () => {
  assert.ok(JIRA_POLL_MISSION.body.includes('assigneeAllowlist'));
  assert.ok(JIRA_POLL_MISSION.body.includes('currentUser()'));
  assert.ok(JIRA_POLL_MISSION.body.includes('accountId'));
});

test('a config.json written before this field existed still loads (no crash)', () => {
  const p = path.join(userData, 'config.json');
  fs.writeFileSync(p, JSON.stringify({ onboardingComplete: true, registeredRepos: ['/x'] }));
  const cfg = readConfig();
  assert.deepEqual(cfg.jiraProjects, []);
  assert.equal(cfg.registeredRepos[0], '/x');
});

test('JIRA_POLL_MISSION targets god, is disabled by default, and has a 5 min cadence', () => {
  assert.equal(JIRA_POLL_MISSION.id, 'jira-poll');
  assert.equal(JIRA_POLL_MISSION.to, 'god');
  assert.equal(JIRA_POLL_MISSION.enabled, false);
  assert.equal(JIRA_POLL_MISSION.intervalMs, 300000);
  assert.ok(JIRA_POLL_MISSION.body.includes('/jira-bindings'));
});
