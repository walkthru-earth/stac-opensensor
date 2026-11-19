// Runs `npm run canonical -- item` on every golden Parquet file and expects its Item with no differences.
// It also checks the exit codes other repos rely on, 1 for differences and 2 for bad input.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDataFile } from './parquet.mjs';

const GOLDEN = 'fixtures/golden';
const run = (...args) => spawnSync(process.execPath, ['scripts/canonical-cli.mjs', ...args], { encoding: 'utf8' });
const errors = [];
const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

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
if (cases.length > 1) {
  const [a, b] = cases.map((n) => join(GOLDEN, n));
  const expect = a.replace(/\.parquet$/, '.json');
  const sha256 = (await readDataFile(a)).footer.template.sha256;
  const templates = readdirSync('templates', { recursive: true }).filter((n) => n.endsWith('.json'))
    .map((n) => join('templates', n));
  const own = templates.find((path) => sha256Of(path) === sha256);
  const other = templates.find((path) => sha256Of(path) !== sha256);
  expectExit('item with its own --template', run('item', a, '--template', own, '--expect', expect), 0);
  expectExit('item with the --template of another board', run('item', a, '--template', other), 2);
  expectExit('item with an empty --expect', run('item', a, '--expect', ''), 2);
  expectExit('item with an empty --template', run('item', a, '--template', ''), 2);
  expectExit('item with --templates naming a file', run('item', a, '--templates', b), 2);
}

if (errors.length > 0) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log(`Golden OK, ${cases.length} Parquet files give their Item`);
