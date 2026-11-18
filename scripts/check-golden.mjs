// Runs `npm run canonical -- item` on every golden Parquet file and expects its Item with no differences.
// It also checks the exit codes other repos rely on, 1 for differences and 2 for a file it cannot read.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const GOLDEN = 'fixtures/golden';
const run = (...args) => spawnSync(process.execPath, ['scripts/canonical-cli.mjs', ...args], { encoding: 'utf8' });
const errors = [];
const expectExit = (what, result, code) => {
  if (result.status !== code) {
    errors.push(`${what} exits ${result.status}, not ${code}\n${result.stdout}${result.stderr}`.trimEnd());
  }
};

const cases = readdirSync(GOLDEN, { recursive: true }).filter((n) => n.endsWith('.parquet')).sort();
if (cases.length === 0) errors.push(`no Parquet file in ${GOLDEN}`);
for (const name of cases) {
  const parquet = join(GOLDEN, name);
  expectExit(parquet, run('item', parquet, '--expect', parquet.replace(/\.parquet$/, '.json')), 0);
}
if (cases.length > 1) {
  const [a, b] = cases.map((n) => join(GOLDEN, n.replace(/\.parquet$/, '.json')));
  expectExit('compare of two different Items', run('compare', a, b), 1);
}
expectExit('item of a missing file', run('item', join(GOLDEN, 'missing.parquet')), 2);

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log(`Golden OK, ${cases.length} Parquet files give their Item`);
