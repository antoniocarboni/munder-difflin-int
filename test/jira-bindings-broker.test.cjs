'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

function makeBroker(bindings) {
  return new IntegrationBroker({
    getRecord: () => undefined,
    getSecret: () => undefined,
    getJiraBindings: () => ({
      bindings,
      poll: { pollIntervalMs: 300000, assigneeFilter: 'currentUser', statusFilter: 'To Do' }
    })
  });
}

test('GET /jira-bindings falls back to an empty list when getJiraBindings is not supplied', async () => {
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined });
  await broker.start();
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/jira-bindings`, { headers: { 'x-md-broker-token': token } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.bindings, []);
  broker.stop();
});

test('GET /jira-bindings requires a valid capability token', async () => {
  const broker = makeBroker([]);
  await broker.start();
  const res = await fetch(`${broker.url()}/jira-bindings`);
  assert.equal(res.status, 401);
  broker.stop();
});

test('GET /jira-bindings returns bindings + poll settings for any valid token', async () => {
  const binding = { key: 'BURD', repo: '/r/burd', baseBranch: 'develop', enabled: true };
  const broker = makeBroker([binding]);
  await broker.start();
  // A token granted for an UNRELATED integration id still works — this route
  // isn't gated by allowedIds, it's a config-data read, not an integration proxy.
  const token = broker.grant('god', ['some-other-integration']);
  const res = await fetch(`${broker.url()}/jira-bindings`, { headers: { 'x-md-broker-token': token } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.bindings, [binding]);
  assert.equal(body.poll.pollIntervalMs, 300000);
  broker.stop();
});

test('GET /jira-bindings only ever returns what getJiraBindings hands back (already-filtered)', async () => {
  // The broker itself does no enabled-filtering — that's jiraProjects.ts's job
  // when it builds the deps in index.ts. This just proves the route is a
  // transparent passthrough, not that it filters (it must not double-filter).
  const disabled = { key: 'OLD', repo: '/r/old', baseBranch: 'main', enabled: false };
  const broker = makeBroker([disabled]);
  await broker.start();
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/jira-bindings`, { headers: { 'x-md-broker-token': token } });
  const body = await res.json();
  assert.deepEqual(body.bindings, [disabled]);
  broker.stop();
});
