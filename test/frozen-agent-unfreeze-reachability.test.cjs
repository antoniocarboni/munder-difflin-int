'use strict';

/**
 * t-029 — Unfreeze must stay reachable for a frozen agent that has NO live pty.
 *
 * Freezing an agent (autoDeliveryPausedAgents, see src/shared/frozenAgents.ts)
 * pauses its auto-delivery and makes Restore Team skip it on purpose after a
 * restart (partitionFrozenAgents) — by design, it stays parked instead of
 * respawning. But that also means it never gets a live pty back on its own, and
 * AgentControlStrip (the only place Unfreeze lived) only mounts behind
 * `isReal = !!agent.ptyId` in AgentDetailPanel.tsx. So once its pty is gone —
 * any restart — the button that undoes the freeze becomes permanently
 * unreachable from the UI. `test/control.test.cjs` already covers
 * partitionFrozenAgents/shouldThawForDispatch as PURE FUNCTIONS and both were
 * green the whole time: the defect was never in that logic, only in whether a
 * control wired to it is actually rendered anywhere reachable. These tests
 * pin that at the source level instead.
 *
 * A pty-less frozen agent lives in `restorableAgents` (see
 * store.ts#reconcileWithLivePtys — a dead-ptyId agent is moved out of the live
 * `agents` list and does not come back on its own while frozen), and the
 * "previous session" dropdown in AgentStrip.tsx is the only place it is still
 * shown at all. That is where the fix adds a direct Unfreeze control.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const AGENT_STRIP = 'src/renderer/src/components/AgentStrip.tsx';

/** The restorableAgents.map(...) render block — the only place a pty-less
 *  frozen agent is shown at all. Isolated with a brace counter (JSX nests
 *  plenty of `{}` and `()` of its own) so the assertions below can't
 *  accidentally match some unrelated part of the file. */
function restorableAgentsBlock() {
  const src = strip(read(AGENT_STRIP));
  // `restorableAgents.map(...)` also appears earlier, building the button's
  // hover-title string (`{names: restorableAgents.map(a => ...).join(', ')}`).
  // The render block — the one this test cares about — is the LAST occurrence.
  const start = src.lastIndexOf('restorableAgents.map(');
  assert.ok(start >= 0, 'restorableAgents.map( not found in AgentStrip.tsx — did the roster render move?');
  let depth = 0;
  let i = src.indexOf('(', start);
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0, 'unbalanced parens while scanning restorableAgents.map(...)');
  return src.slice(bodyStart, i + 1);
}

test('the restorable-agents list can compute whether an entry is frozen', () => {
  const block = restorableAgentsBlock();
  assert.match(block, /autoDeliveryPausedAgents/,
    'no frozen check in the restorable-agents block — Unfreeze has nothing to gate on');
});

test('a frozen restorable entry calls the real unfreeze IPC (controlAutoDelivery(id, false))', () => {
  const block = restorableAgentsBlock();
  assert.match(block, /controlAutoDelivery\(\s*a\.id\s*,\s*false\s*\)/,
    'restorable list never calls window.cth.controlAutoDelivery(id, false) — clicking would not unfreeze anything');
});

test('regression: the unfreeze control does not require a live pty', () => {
  // This is the exact shape of the original bug: AgentControlStrip's Unfreeze
  // button only mounted behind `isReal = !!agent.ptyId`. Reproduce that check
  // here and assert it is NOT what gates the restorable-list control — a
  // pty-less agent (which is the only kind that ever appears in
  // restorableAgents) must still be able to reach it.
  const block = restorableAgentsBlock();
  assert.doesNotMatch(block, /\.ptyId/,
    'the restorable-agents block references ptyId — that would make Unfreeze unreachable again for a dead-pty (i.e. every) restorable agent');
  assert.doesNotMatch(block, /isReal/,
    'the restorable-agents block reintroduces an isReal-style gate — restorable agents never have one');
});

test('the unfreeze control is scoped to the frozen entry, not shown for every restorable agent', () => {
  const block = restorableAgentsBlock();
  // "isFrozen && (...controlAutoDelivery...)" — order-independent: the boolean
  // must gate the JSX that calls the IPC, not just coexist with it somewhere else.
  const guardIdx = block.search(/isFrozen\s*&&/);
  const callIdx = block.search(/controlAutoDelivery\(\s*a\.id\s*,\s*false\s*\)/);
  assert.ok(guardIdx >= 0 && callIdx >= 0 && guardIdx < callIdx,
    'controlAutoDelivery(id,false) must be gated behind the per-agent frozen check');
});
