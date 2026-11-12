import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Journal } from '../src/journal.mjs';
import {
  authorized,
  explore,
  initialState,
  promotionInvariant,
  stateKey,
  transitions,
  values,
} from '../verification/JournalCorrespondence.mjs';

const { Old, Other } = values;
const fixtureRoot = join(process.cwd(), 'test');
const operation = {
  id: 'op',
  attempt: 'attempt',
  contract: 'contract',
  policy: 'policy-a',
  ref: 'refs/heads/main',
  old: 'old',
  next: 'next',
  receipt: { result: 'verified' },
};

function withJournal(run) {
  const dir = mkdtempSync(join(fixtureRoot, '.journal-correspondence-'));
  const journal = new Journal(join(dir, 'journal.sqlite'));
  try {
    journal.registerAttempt({ id: 'attempt', contract: 'contract', policy: 'policy-a' });
    const ref = { value: Old };
    return run(journal, ref);
  } finally {
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function observe(journal, ref) {
  const authority = journal.authority('attempt');
  const prepared = journal.getOperation('op');
  return {
    head: ref.value,
    status: prepared?.status ?? 'none',
    attemptActive: authority.active,
    policyEpoch: authority.policy === 'policy-a' ? 0 : 1,
    operationEpoch: prepared ? (prepared.policy === 'policy-a' ? 0 : 1) : null,
  };
}

function assertObservation(expected, journal, ref) {
  assertCorresponds(expected, observe(journal, ref));
}

function assertCorresponds(expected, actual) {
  assert.deepEqual(actual, expected);
}

function apply(journal, ref, transition) {
  switch (transition.action) {
    case 'prepare':
      journal.prepare({
        ...operation,
        policy: transition.to.operationEpoch === 0 ? 'policy-a' : 'policy-b',
      });
      break;
    case 'changePolicy':
      journal.setPolicy('attempt', 'policy-b');
      break;
    case 'revokeAttempt':
      journal.invalidate('attempt');
      break;
    case 'moveHeadElsewhere':
      ref.value = Other;
      break;
    case 'crashAfterRefWrite':
      assert.throws(() => journal.promote('op', {
        readRef: () => ref.value,
        recheck: () => true,
        updateRef: (_name, next) => {
          ref.value = next;
          throw new Error('simulated lost response');
        },
      }), /simulated lost response/);
      break;
    case 'promote': {
      let rechecks = 0;
      let updates = 0;
      if (transition.outcome === 'refused') {
        assert.throws(() => journal.promote('op', {
          readRef: () => ref.value,
          recheck: () => { rechecks += 1; return true; },
          updateRef: (_name, next, old) => {
            updates += 1;
            assert.equal(ref.value, old);
            ref.value = next;
          },
        }));
        assert.equal(updates, 0);
      } else {
        const result = journal.promote('op', {
          readRef: () => ref.value,
          recheck: () => { rechecks += 1; return true; },
          updateRef: (_name, next, old) => {
            updates += 1;
            assert.equal(ref.value, old);
            ref.value = next;
          },
        });
        assert.equal(result.status, 'promoted');
        if (transition.outcome === 'idempotent' || transition.outcome === 'recovered') {
          assert.equal(rechecks, 0);
          assert.equal(updates, 0);
        } else {
          assert.equal(rechecks, 1);
          assert.equal(updates, 1);
        }
      }
      break;
    }
    default:
      assert.fail('unmapped abstract action: ' + transition.action);
  }
}

function replayPath(journal, ref, path) {
  let state = initialState;
  assertObservation(state, journal, ref);
  for (const transition of path) {
    apply(journal, ref, transition);
    state = transition.to;
    assertObservation(state, journal, ref);
  }
  return state;
}

test('every reachable abstract transition conforms to SQLite Journal observations', () => {
  const graph = explore();
  const uniqueEdges = new Map();
  for (const transition of graph.edges) {
    const key = JSON.stringify([stateKey(transition.from), transition.action, transition.outcome]);
    uniqueEdges.set(key, transition);
  }
  assert.equal(graph.states.length, 28);
  assert.equal(uniqueEdges.size, 58);
  for (const transition of uniqueEdges.values()) {
    assert.equal(promotionInvariant(transition), true, transition.action + ' must preserve authorization');
  }

  for (const transition of uniqueEdges.values()) {
    withJournal((journal, ref) => {
      const prefix = graph.paths.get(stateKey(transition.from));
      assert.ok(prefix, 'reachable prefix for ' + transition.action);
      const reached = replayPath(journal, ref, prefix);
      assert.deepEqual(reached, transition.from);
      apply(journal, ref, transition);
      assertObservation(transition.to, journal, ref);
    });
  }

  assert.ok(graph.edges.some(({ action }) => action === 'crashAfterRefWrite'));
  assert.ok(graph.edges.some(({ action, outcome }) => action === 'promote' && outcome === 'recovered'));
  assert.ok(graph.edges.some(({ action, outcome }) => action === 'promote' && outcome === 'refused'));
  assert.ok(graph.edges.some(({ action }) => action === 'revokeAttempt'));
  assert.ok(graph.edges.some(({ action }) => action === 'changePolicy'));
});

test('authorization invariant rejects the unsafe stale-authority transition', () => {
  const stale = explore().states.find(state =>
    state.status === 'prepared' && state.head === Old &&
    state.policyEpoch !== state.operationEpoch && state.attemptActive);
  assert.ok(stale);
  assert.equal(authorized(stale), false);

  const unsafe = transitions(stale, { unsafeAuthorization: true })
    .find(transition => transition.outcome === 'unsafe');
  assert.ok(unsafe);
  assert.equal(promotionInvariant(unsafe), false);
  assert.throws(() => assertCorresponds(stale, unsafe.to), assert.AssertionError);
});
