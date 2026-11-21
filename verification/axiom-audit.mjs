import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function expectedReports(source) {
  return [...source.matchAll(/^#print axioms (\S+)(?:[ \t]*--[ \t]*allow:([^\r\n]*))?\r?$/gm)]
    .map(([, name, allow = '']) => ({ name, allowed: new Set(allow.split(/[\s,]+/).filter(Boolean)) }));
}

export function printedReports(output) {
  return [...output.matchAll(/'([^']+)' (?:does not depend on any axioms|depends on axioms: \[([^\]]*)\])/g)]
    .map(([, name, axioms = '']) => ({ name, axioms: axioms.split(',').map((axiom) => axiom.trim()).filter(Boolean) }));
}

export function auditReports(file, expected, printed) {
  const problems = [];
  if (printed.length !== expected.length) problems.push(`${file}: expected ${expected.length} axiom reports, Lean printed ${printed.length}`);
  expected.forEach(({ name, allowed }, index) => {
    const report = printed[index];
    if (!report || (report.name !== name && !report.name.endsWith(`.${name}`))) {
      problems.push(`${file}: report ${index + 1} should be ${name}, got ${report?.name ?? 'nothing'}`);
      return;
    }
    const extra = report.axioms.filter((axiom) => !allowed.has(axiom));
    if (extra.length) problems.push(`${file}: ${report.name} depends on ${extra.join(', ')}`);
  });
  return problems;
}

if (import.meta.main) {
  const packageDir = resolve(process.argv[2] ?? '.');
  const files = readdirSync(packageDir).filter((name) => name.endsWith('.lean'))
    .filter((name) => /^#print axioms /m.test(readFileSync(join(packageDir, name), 'utf8'))).sort();
  if (files.length === 0) throw new Error(`no #print axioms commands under ${packageDir}`);
  let declarations = 0;
  const problems = files.flatMap((file) => {
    const expected = expectedReports(readFileSync(join(packageDir, file), 'utf8'));
    declarations += expected.length;
    const output = execFileSync('lake', ['env', 'lean', '-DwarningAsError=true', file], { cwd: packageDir, encoding: 'utf8' });
    return auditReports(file, expected, printedReports(output));
  });
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`${declarations} declarations in ${files.join(', ')} use only their allowed axioms`);
}
