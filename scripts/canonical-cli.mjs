// The reference builder as a command, for firmware, mobile and catalog host CI.
//   npm run --silent canonical -- item <file.parquet> [--template <file.json>] [--templates <dir>] [--expect <item.json>]
//   npm run --silent canonical -- compare <a.json> <b.json>
// --silent keeps npm's banner out of the printed JSON.
// item prints the canonical File Item. With --expect it prints the differences instead.
// Exit codes are 0 for equal or printed, 1 for differences, 2 for a usage or read error, 3 for a file with no Item.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildItem, differences } from './canonical.mjs';
import { readDataFile } from './parquet.mjs';

const USAGE = [
  'usage: npm run --silent canonical -- item <file.parquet> [--template <file.json>] [--templates <dir>] [--expect <item.json>]',
  '       npm run --silent canonical -- compare <a.json> <b.json>',
].join('\n');

const fail = (message, code = 2) => {
  console.error(message);
  process.exit(code);
};
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${path}, ${error.message}`);
  }
};

const sha256Of = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

// Every *.json under dir, searched for the template whose exact bytes hash to the footer template.sha256.
const findTemplate = (dir, sha256) => {
  const walk = (d) => readdirSync(d).flatMap((name) => {
    const path = join(d, name);
    if (statSync(path).isDirectory()) return walk(path);
    return name.endsWith('.json') ? [path] : [];
  });
  return walk(dir).find((path) => sha256Of(path) === sha256);
};

const report = (diffs) => {
  if (diffs.length === 0) {
    console.log('No differences');
    return 0;
  }
  for (const line of diffs) console.log(line);
  return 1;
};

const item = async (args) => {
  const [input, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (!['--template', '--templates', '--expect'].includes(flag) || value === undefined) fail(USAGE);
    // A path may start with -, but an empty one would skip the template search or the comparison.
    if (value === '') fail(`${flag} needs a path, not an empty string`);
    options[flag.slice(2)] = value;
  }
  if (!input) fail(USAGE);
  let data;
  try {
    data = await readDataFile(input);
  } catch (error) {
    fail(`cannot read ${input}, ${error.message}`);
  }
  let template;
  const sha256 = data.footer?.template?.sha256;
  if ('template' in options) {
    // The template is the exact bytes the footer names, as when it is found by search.
    let actual;
    try {
      actual = sha256Of(options.template);
    } catch (error) {
      fail(`cannot read ${options.template}, ${error.message}`);
    }
    if (actual !== sha256) fail(`${options.template} hashes to ${actual}, not the footer template.sha256 ${sha256}`);
    template = readJson(options.template);
  } else {
    const dir = options.templates ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
    const path = sha256 && existsSync(dir) ? findTemplate(dir, sha256) : undefined;
    if (!path) fail(`no template in ${dir} matches the footer template.sha256 ${sha256}, pass --template`);
    template = readJson(path);
  }
  const built = buildItem({ ...data, template });
  if (built.none) fail(`no Item, ${built.none}`, 3);
  if ('expect' in options) return report(differences(built.item, readJson(options.expect)));
  console.log(JSON.stringify(built.item, null, 2));
  return 0;
};

// Any other error, such as --templates naming a file or a footer with no acquisition group, is bad input and exits 2.
const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'item') {
    process.exitCode = await item(args);
  } else if (command === 'compare' && args.length === 2) {
    process.exitCode = report(differences(readJson(args[0]), readJson(args[1])));
  } else {
    fail(USAGE);
  }
} catch (error) {
  fail(`cannot build the Item, ${error.message}`);
}
