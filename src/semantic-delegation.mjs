import { requireThat } from './contracts.mjs';
import { prepareSemanticRevision } from './delegation-policy.mjs';
import { checkLeanClaimOracle, readLeanDefinitions } from './lean-claim.mjs';
import { buildRefinementChallenge, verifyRefinement } from './refinement-proof.mjs';

export async function authorizeSemanticRevision({ parent, proposal, claim, solution, oracleRoot, scratch, signal }) {
  const prepared = prepareSemanticRevision(parent, proposal, claim);
  const { result, contract, binding, old, successor } = prepared;
  const trustedDefinitions = await readLeanDefinitions(oracleRoot, successor);
  const obligation = result.plan.obligations.find(item => item.id === successor.obligation);
  const priorObligation = prepared.parent.plan.obligations.find(item => item.id === old.obligation);
  await checkLeanClaimOracle(oracleRoot, old, priorObligation, trustedDefinitions);
  await checkLeanClaimOracle(oracleRoot, successor, obligation, trustedDefinitions);
  const built = buildRefinementChallenge({ contract, trustedDefinitions, binding });
  if (solution === undefined) return { challenge: built.challenge, theorem: built.theorem, binding, witnessDigest: built.witnessDigest };
  const witness = await verifyRefinement({ contract, approvedDigest: built.contractDigest, binding,
    trustedDefinitions, solution, timeoutMs: obligation.timeoutMs, scratch, signal });
  requireThat(witness.accepted, 'Semantic refinement witness refused for ' + claim);
  return { ...result, witness: { theorem: witness.theorem, digest: witness.witnessDigest } };
}
