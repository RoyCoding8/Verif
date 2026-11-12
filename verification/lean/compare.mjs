import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compose, planVerification } from "../../src/contracts.mjs";

const grades = ["tested", "bounded", "formal"];
const cases = JSON.parse(readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"));
const leanResults = JSON.parse(readFileSync(process.argv[2], "utf8"));
const domainFor = (id) => id === null
  ? null
  : { module: "Fixture", name: "D" + id, axes: [[id]] };

function runJavaScriptCase(testCase) {
  const statements = new Map(testCase.claims.map((claim) =>
    [claim.id, "Claim " + claim.id + " is supported"]));
  const intent = {
    claims: testCase.claims.map((claim) => ({
      id: claim.id,
      statement: statements.get(claim.id),
      required: grades[claim.required],
      domain: domainFor(claim.domain),
      dependencies: claim.dependencies.map((index) => {
        const dependency = testCase.claims[index];
        return { claim: dependency.id, statement: statements.get(dependency.id) };
      })
    })),
    obligations: testCase.claims.flatMap((claim) => claim.evidence.map((grade, index) => ({
      id: "obligation-" + claim.id + "-" + index,
      claim: claim.id,
      subject: "candidate",
      expect: "PASS",
      method: grade === 0 ? "node-test" : grade === 1 ? "finite-domain" : "deductive",
      oracle: { file: "fixtures/oracle.json", digest: "0".repeat(64) },
      outputs: [],
      cases: ["only"],
      timeoutMs: 1
    }))),
    criteria: testCase.roots.map((root, index) => ({
      id: "criterion-" + index,
      description: "Acceptance root " + index,
      claims: [testCase.claims[root].id]
    }))
  };

  let plan;
  try {
    plan = planVerification(intent);
  } catch (error) {
    if (testCase.expectedAccepted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    assert.equal(message, testCase.expectedJsError, testCase.name + " failed for an unexpected reason");
    return { name: testCase.name, accepted: false, effective: [] };
  }

  assert.equal(testCase.expectedAccepted, true, testCase.name + " should have been rejected");
  const results = plan.obligations.map((obligation) => ({
    id: obligation.id,
    status: obligation.expect,
    level: obligation.method === "node-test" ? "tested" : "bounded",
    outputs: {}
  }));
  const composed = compose(plan, results);
  return {
    name: testCase.name,
    accepted: true,
    effective: testCase.claims.map((claim) => grades.indexOf(composed[claim.id]))
  };
}

assert.deepEqual(
  cases.map(runJavaScriptCase),
  leanResults,
  "Lean reference and JavaScript contract disagree on a finite fixture"
);
console.log("8 finite cases matched src/contracts.mjs");