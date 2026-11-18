// Checks that every published schema and registry answers at its URL with the bytes of the repo file.
// A schema's URL is its `$id`. A registry file in registry/ is served under `<version>/registry/`.
// The fetch follows at most one redirect, and every hop stays on the allowed hosts.
// It needs network, so it is not part of `npm test`. The publish and the daily workflows run it.
//
// Usage: node scripts/check-live-schemas.mjs [--root <dir>] [--attempts <n>] [--wait <seconds>]
//   --root      the checkout to compare, by default this repository. The daily run passes a worktree of a tag.
//   --attempts  how many times to try before failing, by default 1. The publish run retries while Pages updates.
//   --wait      seconds between attempts, by default 30.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTS = new Set(['walkthru-earth.github.io', 'walkthru.earth']);
const MAX_HOPS = 1;

function parseArgs(argv) {
  const options = { root: fileURLToPath(new URL('../', import.meta.url)), attempts: 1, wait: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root' && value) options.root = resolve(value);
    else if (flag === '--attempts' && /^[1-9][0-9]*$/.test(value ?? '')) options.attempts = Number(value);
    else if (flag === '--wait' && /^[0-9]+$/.test(value ?? '')) options.wait = Number(value);
    else {
      console.error(`Unknown or incomplete option ${flag}`);
      process.exit(2);
    }
    i += 1;
  }
  return options;
}

// Lists [url, local path] pairs. Schemas give their own `$id`. Registries sit under the schemas' folder.
function targets(root) {
  const list = [];
  const errors = [];
  const folders = new Set();
  const schemaDir = join(root, 'json-schema');
  for (const name of readdirSync(schemaDir).filter((n) => n.endsWith('.json')).sort()) {
    const path = join(schemaDir, name);
    const id = JSON.parse(readFileSync(path, 'utf8')).$id;
    if (typeof id !== 'string') {
      errors.push(`json-schema/${name} has no $id`);
      continue;
    }
    const url = new URL(id);
    url.hash = '';
    if (!url.pathname.endsWith(`/${name}`)) errors.push(`json-schema/${name} has $id ${id}, which names another file`);
    folders.add(url.href.slice(0, url.href.lastIndexOf('/') + 1));
    list.push([url.href, path]);
  }
  if (folders.size !== 1) errors.push(`the schemas' $id values name ${folders.size} folders, not one: ${[...folders].join(' ')}`);
  const registryDir = join(root, 'registry');
  if (folders.size === 1 && existsSync(registryDir)) {
    const [folder] = folders;
    for (const name of readdirSync(registryDir).filter((n) => n.endsWith('.json')).sort()) {
      list.push([`${folder}registry/${name}`, join(registryDir, name)]);
    }
  }
  return { list, errors };
}

// Fetches a URL, following redirects by hand so each hop can be checked.
async function fetchChecked(start) {
  let url = new URL(start);
  for (let hops = 0; ; hops += 1) {
    if (url.protocol !== 'https:' || !HOSTS.has(url.hostname)) return { error: `${url.href} is off the allowed hosts` };
    const response = await fetch(url, { redirect: 'manual', headers: { 'cache-control': 'no-cache' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return { error: `${url.href} answered ${response.status} with no Location` };
      if (hops + 1 > MAX_HOPS) return { error: `${start} redirects more than ${MAX_HOPS} time` };
      url = new URL(location, url);
      continue;
    }
    if (response.status !== 200) return { error: `${url.href} answered ${response.status}` };
    return { body: Buffer.from(await response.arrayBuffer()), final: url.href };
  }
}

async function check(root) {
  const { list, errors } = targets(root);
  for (const [url, path] of list) {
    let result;
    try {
      result = await fetchChecked(url);
    } catch (error) {
      result = { error: `${url} failed, ${error.message}` };
    }
    if (result.error) {
      errors.push(result.error);
    } else if (!result.body.equals(readFileSync(path))) {
      errors.push(`${url} serves other bytes than ${path.slice(root.length).replace(/^\/+/, '')}`);
    } else {
      console.log(`ok ${url}`);
    }
  }
  return errors;
}

const options = parseArgs(process.argv.slice(2));
for (let attempt = 1; ; attempt += 1) {
  const errors = await check(options.root);
  if (errors.length === 0) {
    console.log('Live schemas OK');
    break;
  }
  for (const error of errors) console.error(`FAIL ${error}`);
  if (attempt >= options.attempts) process.exit(1);
  console.error(`Attempt ${attempt} of ${options.attempts} failed. Trying again in ${options.wait} s.`);
  await new Promise((done) => setTimeout(done, options.wait * 1000));
}
