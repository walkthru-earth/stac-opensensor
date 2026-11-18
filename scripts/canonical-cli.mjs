// The reference builder as a command, for firmware, mobile and catalog host CI.
//   npm run canonical -- item <file.parquet> [--template <file.json>] [--templates <dir>] [--expect <item.json>]
//   npm run canonical -- compare <a.json> <b.json>
// item prints the canonical File Item. With --expect it prints the differences instead.
// Exit codes are 0 for equal or printed, 1 for differences, 2 for a usage or read error, 3 for a file with no Item.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildItem, differences } from './canonical.mjs';
import { readDataFile } from './parquet.mjs';

const USAGE = [
  'usage: npm run canonical -- item <file.parquet> [--template <file.json>] [--templates <dir>] [--expect <item.json>]',
  '       npm run canonical -- compare <a.json> <b.json>',
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

// Every *.json under dir, searched for the template whose exact bytes hash to the footer template.sha256.
const findTemplate = (dir, sha256) => {
  const walk = (d) => readdirSync(d).flatMap((name) => {
    const path = join(d, name);
    if (statSync(path).isDirectory()) return walk(path);
    return name.endsWith('.json') ? [path] : [];
  });
  return walk(dir).find((path) => createHash('sha256').update(readFileSync(path)).digest('hex') === sha256);
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
  if (options.template) {
    template = readJson(options.template);
  } else {
    const dir = options.templates ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
    const sha256 = data.footer?.template?.sha256;
    const path = sha256 && existsSync(dir) ? findTemplate(dir, sha256) : undefined;
    if (!path) fail(`no template in ${dir} matches the footer template.sha256 ${sha256}, pass --template`);
    template = readJson(path);
  }
  const built = buildItem({ ...data, template });
  if (built.none) fail(`no Item, ${built.none}`, 3);
  if (options.expect) return report(differences(built.item, readJson(options.expect)));
  console.log(JSON.stringify(built.item, null, 2));
  return 0;
};

const [command, ...args] = process.argv.slice(2);
if (command === 'item') {
  process.exitCode = await item(args);
} else if (command === 'compare' && args.length === 2) {
  process.exitCode = report(differences(readJson(args[0]), readJson(args[1])));
} else {
  fail(USAGE);
}
