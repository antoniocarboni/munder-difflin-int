'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  JIRA_KEY_RE,
  validateJiraKeyFormat,
  hasDuplicateKey,
  parseJiraMapJson,
  DEFAULT_JIRA_POLL_SETTINGS
} = loadTs('src/shared/jiraProjects.ts');

test('JIRA_KEY_RE accepts real project keys', () => {
  assert.ok(JIRA_KEY_RE.test('BURD'));
  assert.ok(JIRA_KEY_RE.test('BRAVI'));
  assert.ok(JIRA_KEY_RE.test('A1'));
});

test('JIRA_KEY_RE rejects lowercase, leading digit, and too-short/long keys', () => {
  assert.equal(JIRA_KEY_RE.test('burd'), false);
  assert.equal(JIRA_KEY_RE.test('1BURD'), false);
  assert.equal(JIRA_KEY_RE.test('A'), false);
  assert.equal(JIRA_KEY_RE.test('A'.repeat(11)), false);
});

test('validateJiraKeyFormat returns null for a valid key', () => {
  assert.equal(validateJiraKeyFormat('BURD'), null);
});

test('validateJiraKeyFormat returns a message for an invalid key', () => {
  assert.ok(typeof validateJiraKeyFormat('burd') === 'string' && validateJiraKeyFormat('burd').length > 0);
});

test('hasDuplicateKey is case-insensitive and checks only the given list', () => {
  const others = [{ key: 'BURD', repo: '/r', baseBranch: 'develop', enabled: true }];
  assert.equal(hasDuplicateKey('burd', others), true);
  assert.equal(hasDuplicateKey('BRAVI', others), false);
});

test('parseJiraMapJson maps projects[] and claimFilter into bindings/poll', () => {
  const raw = JSON.stringify({
    claimFilter: { assignee: 'currentUser()', status: 'To Do', pollIntervalMs: 300000 },
    projects: [
      { key: 'BURD', repo: '/Users/shaibon/www/motta-burdastyle', baseBranch: 'develop', agents: ['dwight-mtcttd07'] },
      { key: 'BRAVI', repo: '/Users/shaibon/www/magenio-M2-bravifarmacie', baseBranch: 'develop', agents: [] }
    ]
  });
  const result = parseJiraMapJson(raw);
  assert.deepEqual(result.bindings, [
    { key: 'BURD', repo: '/Users/shaibon/www/motta-burdastyle', baseBranch: 'develop', agents: ['dwight-mtcttd07'], enabled: true },
    { key: 'BRAVI', repo: '/Users/shaibon/www/magenio-M2-bravifarmacie', baseBranch: 'develop', agents: [], enabled: true }
  ]);
  assert.equal(result.poll.pollIntervalMs, 300000);
});

test('parseJiraMapJson returns null for malformed JSON instead of throwing', () => {
  assert.equal(parseJiraMapJson('{not json'), null);
});

test('parseJiraMapJson returns an empty bindings list when projects is missing', () => {
  const result = parseJiraMapJson(JSON.stringify({ claimFilter: {} }));
  assert.deepEqual(result.bindings, []);
});

test('DEFAULT_JIRA_POLL_SETTINGS matches the decided defaults', () => {
  assert.deepEqual(DEFAULT_JIRA_POLL_SETTINGS, {
    pollIntervalMs: 300000,
    assigneeFilter: 'currentUser',
    statusFilter: 'To Do'
  });
  assert.equal(DEFAULT_JIRA_POLL_SETTINGS.assigneeAllowlist, undefined,
    'empty/absent allow-list must mean today\'s behavior (assignee = currentUser())');
});
