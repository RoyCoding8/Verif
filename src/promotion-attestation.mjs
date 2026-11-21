import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { digest, requireThat } from './contracts.mjs';
import { promotionCommitMessage } from './git.mjs';

export const PROMOTION_PREDICATE_TYPE = 'https://github.com/RoyCoding8/Verif/attestation/promotion/v1';
const PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const maxPayload = 1_125_000;

function pae(payloadType, payload) {
  const type = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `, 'ascii'), type,
    Buffer.from(` ${payload.length} `, 'ascii'), payload]);
}

function keyId(key) {
  const publicKey = key.type === 'public' ? key : createPublicKey(key);
  requireThat(publicKey.asymmetricKeyType === 'ed25519', 'Promotion attestation requires an Ed25519 key');
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function operationReceipt(operation) {
  requireThat(operation && operation.status === 'promoted', 'Only promoted operations can be attested');
  const receipt = operation.receipt;
  const task = receipt?.task;
  const contract = task?.contract;
  const plan = task?.plan;
  const evidence = receipt?.evidence;
  requireThat(typeof operation.ref === 'string' && operation.ref.startsWith('refs/heads/'), 'Invalid target ref');
  requireThat(typeof operation.old === 'string' && OID.test(operation.old) &&
    typeof operation.next === 'string' && OID.test(operation.next), 'Invalid promotion commit identity');
  requireThat(contract && plan && typeof task.approval === 'string' && SHA256.test(task.approval) &&
    operation.contract === task.approval && digest(contract) === task.approval &&
    SHA256.test(contract.plan) && digest(plan) === contract.plan &&
    contract.policy?.ref === operation.ref && operation.policy === digest(contract.policy),
  'Operation contract, plan, or target policy binding is invalid');
  requireThat(evidence?.version === 1 && evidence.contract === task.approval && evidence.plan === contract.plan &&
    evidence.base === receipt.base && evidence.candidate === receipt.candidate &&
    evidence.assurance && typeof evidence.assurance === 'object' &&
    !Array.isArray(evidence.assurance), 'Stored evidence does not match the approved contract and candidate');
  return { receipt, contract, plan, evidence };
}

function promotionDetails(repo, operation, receipt) {
  const object = repo.commitObject(operation.next);
  const candidate = repo.commitObject(receipt.candidate);
  requireThat(object.parents.length === 1 && object.parents[0] === operation.old, 'Promotion commit must have its unique expected parent');
  requireThat(object.tree === candidate.tree,
    'Promotion tree does not match the verified candidate');
  const receiptDigest = digest(operation.receipt);
  const expectedMessage = promotionCommitMessage(operation.id, receiptDigest);
  requireThat(object.message === expectedMessage, 'Promotion commit trailers do not match the operation and receipt');
  return { commit: object.commit, tree: object.tree, receiptDigest };
}

function approvedExceptionIds(plan) {
  requireThat(Array.isArray(plan.criteria), 'Invalid approved plan criteria');
  const ids = plan.criteria.filter(criterion => Object.hasOwn(criterion, 'exception')).map(criterion => criterion.id);
  requireThat(ids.every(id => typeof id === 'string' && id.trim().length > 0), 'Invalid approved exception identifiers');
  return ids;
}

export function createPromotionAttestation({ repo, operation, privateKey }) {
  requireThat(privateKey?.type === 'private' && privateKey.asymmetricKeyType === 'ed25519',
    'Promotion attestation requires an Ed25519 private key');
  const { receipt, contract, plan, evidence } = operationReceipt(operation);
  const { commit, tree, receiptDigest } = promotionDetails(repo, operation, receipt);
  const exceptionIds = approvedExceptionIds(plan);
  const predicate = {
    version: 1,
    operation: operation.id,
    targetRef: operation.ref,
    parentCommit: operation.old,
    approvalDigest: operation.contract,
    planDigest: contract.plan,
    receiptDigest,
    assurance: evidence.assurance,
    ...(exceptionIds.length ? { approvedExceptionIds: exceptionIds } : {}),
  };
  const statement = {
    _type: STATEMENT_TYPE,
    subject: [{ name: operation.ref, digest: { gitCommit: commit, gitTree: tree } }],
    predicateType: PROMOTION_PREDICATE_TYPE,
    predicate,
  };
  const payload = Buffer.from(JSON.stringify(statement), 'utf8');
  requireThat(payload.length <= maxPayload, 'Promotion statement is too large');
  return {
    payloadType: PAYLOAD_TYPE,
    payload: payload.toString('base64'),
    signatures: [{ keyid: keyId(privateKey), sig: sign(null, pae(PAYLOAD_TYPE, payload), privateKey).toString('base64') }],
  };
}

function decodeEnvelope(envelope) {
  requireThat(envelope && envelope.payloadType === PAYLOAD_TYPE && typeof envelope.payload === 'string' &&
    envelope.payload.length <= maxPayload / 3 * 4 &&
    Array.isArray(envelope.signatures) && envelope.signatures.length === 1,
  'Invalid promotion DSSE envelope');
  const signature = envelope.signatures[0];
  requireThat(typeof signature?.keyid === 'string' && SHA256.test(signature.keyid) &&
    typeof signature.sig === 'string' && signature.sig.length === 88,
  'Invalid promotion DSSE signature');
  return { payload: Buffer.from(envelope.payload, 'base64'), signature, signatureBytes: Buffer.from(signature.sig, 'base64') };
}

function authenticatedStatement({ envelope, publicKey }) {
  requireThat(publicKey?.type === 'public' && publicKey.asymmetricKeyType === 'ed25519',
    'Promotion attestation requires an Ed25519 public key');
  const { payload, signature, signatureBytes } = decodeEnvelope(envelope);
  requireThat(envelope.payload === payload.toString('base64') && signature.sig === signatureBytes.toString('base64'),
    'Non-canonical DSSE base64 encoding');
  requireThat(signature.keyid === keyId(publicKey), 'DSSE key ID does not match the supplied public key');
  requireThat(signatureBytes.length === 64 && verify(null, pae(envelope.payloadType, payload), publicKey, signatureBytes),
    'Invalid promotion DSSE signature');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
  } catch {
    throw new Error('Signed promotion statement is not valid UTF-8 JSON');
  }
}

export function verifyPromotionAttestation({ repo, envelope, publicKey, expectedCommit }) {
  requireThat(typeof expectedCommit === 'string' && OID.test(expectedCommit), 'Expected full commit ID is required');
  const statement = authenticatedStatement({ envelope, publicKey });
  requireThat(statement?._type === STATEMENT_TYPE && statement.predicateType === PROMOTION_PREDICATE_TYPE &&
    Array.isArray(statement.subject) && statement.subject.length === 1,
  'Unsupported promotion statement');
  const subject = statement.subject[0];
  const predicate = statement.predicate;
  requireThat(subject && typeof subject.name === 'string' && subject.name.startsWith('refs/heads/') &&
    subject.digest && predicate?.version === 1 &&
    predicate.targetRef === subject.name && typeof predicate.parentCommit === 'string' && OID.test(predicate.parentCommit) &&
    typeof predicate.approvalDigest === 'string' && SHA256.test(predicate.approvalDigest) &&
    typeof predicate.planDigest === 'string' && SHA256.test(predicate.planDigest) &&
    typeof predicate.receiptDigest === 'string' && SHA256.test(predicate.receiptDigest) &&
    predicate.assurance && typeof predicate.assurance === 'object' &&
    !Array.isArray(predicate.assurance), 'Invalid promotion statement identity');
  const commit = subject.digest.gitCommit;
  const tree = subject.digest.gitTree;
  requireThat(typeof commit === 'string' && commit === expectedCommit && OID.test(commit) &&
    typeof tree === 'string' && OID.test(tree), 'Promotion subject does not match the expected commit');
  const object = repo.commitObject(commit);
  requireThat(object.parents.length === 1 && object.parents[0] === predicate.parentCommit,
    'Promotion commit must have its unique signed parent');
  const trailer = promotionCommitMessage(predicate.operation, predicate.receiptDigest);
  requireThat(object.message === trailer && object.tree === tree,
    'Promotion commit does not match the signed subject and trailers');
  if (predicate.approvedExceptionIds !== undefined) {
    requireThat(Array.isArray(predicate.approvedExceptionIds) &&
      predicate.approvedExceptionIds.every(id => typeof id === 'string' && id.trim().length > 0) &&
      new Set(predicate.approvedExceptionIds).size === predicate.approvedExceptionIds.length,
    'Invalid signed exception identifiers');
  }
  return statement;
}
