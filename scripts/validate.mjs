#!/usr/bin/env node
// Validates OpenSensor JSON documents one at a time, with the same checks npm test runs on this repository.
//   npm run validate -- [--json] [--sha256 <64 hex>] <file.json>...
// It finds the kind of each file from its content. Templates, footers, geo keys, Collections, Items, Catalogs and the
// registries are known. Run stac-node-validator too for STAC core and the other extensions.
// --sha256 compares the bytes of each template with the digest the device or the footer names.
// The exit code is 0 when every file passes, 1 when one fails and 2 on a usage error.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadRegistries, validateDocument } from './checks.mjs';

const usage = 'usage: npm run validate -- [--json] [--sha256 <64 hex>] <file.json>...';
const args = process.argv.slice(2);
const json = args.includes('--json');
let digest;
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--json') continue;
  if (args[i] === '--sha256') {
    digest = args[i + 1];
    i += 1;
  } else if (args[i].startsWith('-')) {
    files.length = 0;
    break;
  } else {
    files.push(args[i]);
  }
}
if (files.length === 0 || (digest !== undefined && !/^[0-9a-f]{64}$/.test(digest))) {
  console.error(usage);
  process.exit(2);
}

const regs = loadRegistries();
const results = files.map((file) => {
  let bytes;
  let doc;
  try {
    bytes = readFileSync(file);
    doc = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    return { file, kind: 'unreadable', errors: [e.message] };
  }
  const { kind, errors } = validateDocument(file, doc, regs);
  const result = { file, kind, errors };
  if (kind === 'template') {
    result.sha256 = createHash('sha256').update(bytes).digest('hex');
    if (digest !== undefined && result.sha256 !== digest) {
      errors.push(`SHA-256 of the bytes is ${result.sha256}, not ${digest}`);
    }
  }
  return result;
});

if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const { file, kind, errors, sha256 } of results) {
    const digestNote = sha256 ? ` sha256 ${sha256}` : '';
    console.log(`${errors.length === 0 ? 'ok' : 'FAIL'} ${file} (${kind})${digestNote}`);
    for (const e of errors) console.log(`  ${e}`);
  }
}
process.exit(results.some((r) => r.errors.length > 0) ? 1 : 0);
