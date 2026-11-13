import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { digest } from '../src/contracts.mjs';
import { GitRepo } from '../src/git.mjs';
import { createPromotionAttestation, PROMOTION_PREDICATE_TYPE, verifyPromotionAttestation } from '../src/promotion-attestation.mjs';

function git(root, args, input) {
  return execFileSync('git', ['-C', root, ...args], {
    input,
    encoding: input === undefined ? 'utf8' : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, '.git', 'verity-test-config') },
  }).toString().trim();
}

function commit(root, message) {
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@invalid', 'commit', '--quiet', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function pae(type, payload) {
  const encodedType = Buffer.from(type, 'ascii');
  return Buffer.concat([Buffer.from(`DSSEv1 ${encodedType.length} `), encodedType,
    Buffer.from(` ${payload.length} `), payload]);
}

function resign(envelope, statement, privateKey) {
  const payload = Buffer.from(JSON.stringify(statement));
  return {
    payloadType: envelope.payloadType,
    payload: payload.toString('base64'),
    signatures: [{ ...envelope.signatures[0], sig: crypto.sign(null, pae(envelope.payloadType, payload), privateKey).toString('base64') }],
  };
}

function statement(envelope) {
  return JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verity-attestation-'));
  git(root, ['init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'value.txt'), 'base');
  const base = commit(root, 'base');
  fs.writeFileSync(path.join(root, 'value.txt'), 'candidate');
  const candidate = commit(root, 'candidate');
  const repo = new GitRepo(root);
  const ref = 'refs/heads/protected';
  const plan = { version: 1,
    criteria: [{ id: 'covered', claims: [] }, { id: 'known-exception', exception: 'private risk text', claims: [] }],
    claims: [], obligations: [] };
  const contract = { version: 1, id: 'task-1', plan: digest(plan), policy: { ref } };
  const approval = digest(contract);
  const operationId = '12345678-1234-4234-8234-123456789abc';
  const evidence = { version: 1, contract: approval, plan: contract.plan, base, candidate, assurance: { claim: 'tested' } };
  const receipt = {
    task: { contract, plan, approval }, evidence, base, candidate,
    localPath: 'C:\\private\\workspace', heldOutObservation: 'must not be exported',
  };
  const next = repo.promotionCommit({ tree: repo.tree(candidate), parent: base, operation: operationId, receipt: digest(receipt) });
  repo.updateRef(ref, next, null, operationId);
  const operation = { id: operationId, status: 'promoted', contract: approval, ref, old: base, next, receipt };
  const keys = crypto.generateKeyPairSync('ed25519');
  return { root, repo, base, candidate, operation, keys };
}

test('promotion attestation has a deterministic signed replay and rejects the finite identity matrix', t => {
  const { root, repo, base, candidate, operation, keys } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const envelope = createPromotionAttestation({ repo, operation, privateKey: keys.privateKey });
  assert.deepEqual(createPromotionAttestation({ repo, operation, privateKey: keys.privateKey }), envelope);
  const verified = verifyPromotionAttestation({ repo, envelope, publicKey: keys.publicKey, expectedCommit: operation.next });
  assert.equal(verified.predicateType, PROMOTION_PREDICATE_TYPE);
  assert.deepEqual(verified.subject, [{ name: operation.ref,
    digest: { gitCommit: operation.next, gitTree: repo.commitObject(operation.next).tree } }]);
  assert.equal(verified.predicate.operation, operation.id);
  assert.equal(verified.predicate.targetRef, operation.ref);
  assert.equal(verified.predicate.parentCommit, base);
  assert.equal(verified.predicate.approvalDigest, operation.contract);
  assert.equal(verified.predicate.planDigest, operation.receipt.task.contract.plan);
  assert.equal(verified.predicate.receiptDigest, digest(operation.receipt));
  assert.deepEqual(verified.predicate.approvedExceptionIds, ['known-exception']);
  assert.equal(JSON.stringify(verified).includes('private'), false);
  assert.equal(JSON.stringify(verified).includes('heldOutObservation'), false);
  assert.equal(JSON.stringify(verified).includes('must not be exported'), false);
  assert.equal(JSON.stringify(verified).includes('private risk text'), false);

  const advanced = repo.promotionCommit({ tree: repo.commitObject(operation.next).tree,
    parent: operation.next, operation: 'next-operation', receipt: 'f'.repeat(64) });
  repo.updateRef(operation.ref, advanced, operation.next, 'next-operation');
  assert.deepEqual(createPromotionAttestation({ repo, operation, privateKey: keys.privateKey }), envelope);
  assert.deepEqual(verifyPromotionAttestation({ repo, envelope, publicKey: keys.publicKey,
    expectedCommit: operation.next }), verified);

  const alteredSignature = structuredClone(envelope);
  alteredSignature.signatures[0].sig = Buffer.alloc(64).toString('base64');
  assert.throws(() => verifyPromotionAttestation({ repo, envelope: alteredSignature, publicKey: keys.publicKey, expectedCommit: operation.next }), /signature/i);
  assert.throws(() => verifyPromotionAttestation({ repo, envelope, publicKey: keys.publicKey, expectedCommit: candidate }), /expected commit/i);

  const wrongTree = statement(envelope);
  wrongTree.subject[0].digest.gitTree = '0'.repeat(wrongTree.subject[0].digest.gitTree.length);
  assert.throws(() => verifyPromotionAttestation({ repo, envelope: resign(envelope, wrongTree, keys.privateKey),
    publicKey: keys.publicKey, expectedCommit: operation.next }), /subject and trailers/i);

  const wrongCommit = statement(envelope);
  wrongCommit.subject[0].digest.gitCommit = candidate;
  assert.throws(() => verifyPromotionAttestation({ repo, envelope: resign(envelope, wrongCommit, keys.privateKey),
    publicKey: keys.publicKey, expectedCommit: candidate }), /subject and trailers/i);

  const wrongParent = statement(envelope);
  wrongParent.predicate.parentCommit = candidate;
  assert.throws(() => verifyPromotionAttestation({ repo, envelope: resign(envelope, wrongParent, keys.privateKey),
    publicKey: keys.publicKey, expectedCommit: operation.next }), /unique signed parent/i);

  const wrongReceipt = statement(envelope);
  wrongReceipt.predicate.receiptDigest = '0'.repeat(64);
  assert.throws(() => verifyPromotionAttestation({ repo, envelope: resign(envelope, wrongReceipt, keys.privateKey),
    publicKey: keys.publicKey, expectedCommit: operation.next }), /subject and trailers/i);

  const wrongOperation = structuredClone(operation);
  wrongOperation.id = 'different-operation';
  assert.throws(() => createPromotionAttestation({ repo, operation: wrongOperation, privateKey: keys.privateKey }), /trailers/i);
  for (const status of ['prepared', 'abandoned']) {
    assert.throws(() => createPromotionAttestation({ repo, operation: { ...operation, status }, privateKey: keys.privateKey }), /promoted/i);
  }
  const changedReceipt = structuredClone(operation);
  changedReceipt.receipt.localPath = 'C:\\different\\workspace';
  assert.throws(() => createPromotionAttestation({ repo, operation: changedReceipt, privateKey: keys.privateKey }), /trailers/i);
  const changedPlan = structuredClone(operation);
  changedPlan.receipt.task.plan.criteria[1].exception = 'different risk text';
  assert.throws(() => createPromotionAttestation({ repo, operation: changedPlan, privateKey: keys.privateKey }), /plan binding/i);

  const twoParentCommit = execFileSync('git', ['-C', root, 'commit-tree', repo.commitObject(operation.next).tree,
    '-p', base, '-p', candidate], { input: Buffer.from(`Verity promotion\n\nOperation: ${operation.id}\nReceipt: ${digest(operation.receipt)}\n`), encoding: 'utf8' }).trim();
  const twoParentStatement = statement(envelope);
  twoParentStatement.subject[0].digest.gitCommit = twoParentCommit;
  const twoParentEnvelope = resign(envelope, twoParentStatement, keys.privateKey);
  assert.throws(() => verifyPromotionAttestation({ repo, envelope: twoParentEnvelope,
    publicKey: keys.publicKey, expectedCommit: twoParentCommit }), /unique signed parent/i);
});
