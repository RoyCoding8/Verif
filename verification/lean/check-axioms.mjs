import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const output = readFileSync(process.argv[2], "utf8");
const names = [
  "supportsWeakestExact",
  "supportsWeakestWithExact",
  "formalDropsToBounded",
  "boundedDependencyBlocksFormal",
  "allFormalComponentsPreserveFormal",
  "insufficientTestedEvidenceRejectsBounded",
  "gateExact",
  "gateRefusesMissing"
];
for (const name of names) {
  const matching = output.split(/\r?\n/).filter((line) => line.includes("VerityContract." + name));
  assert.equal(matching.length, 1, "missing or duplicate axiom report for " + name);
  assert.match(matching[0], /does not depend on any axioms$/, name + " gained an axiom dependency");
}
console.log(names.length + " exported theorems have no axiom dependencies");
