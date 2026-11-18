#!/usr/bin/env node
// Validates OpenSensor JSON documents one at a time, with the single document checks npm test runs on this repository.
// The checks that join documents, the Markdown checks and stac-node-validator stay in npm test.
//   npm run --silent validate -- [--json] [--sha256 <64 hex>] <file.json>...
// It finds the kind of each file from its content. Templates, footers, geo keys, Collections, Items, Catalogs and the
// registries are known. Run stac-node-validator too for STAC core and the other extensions.
// A relative path is read from the directory npm was started in, so npm --prefix <checkout> works from anywhere.
// --sha256 compares the bytes of each template with the digest the device or the footer names. It fails when no
// file is a template, so a footer passed by mistake cannot pass for a digest check.
// The exit code is 0 when every file passes, 1 when one fails and 2 on a usage error.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadRegistries, validateDocument } from './checks.mjs';

const usage = 'usage: npm run validate -- [--json] [--sha256 <64 hex>] <file.json>...';
const args = process.argv.slice(2);
const json = args.includes('--json');
let digest;
let bad = false;
const files = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--json') continue;
  if (args[i] === '--sha256') {
    // A present flag needs its digest. Leaving the flag out is fine, a flag with no digest is a usage error.
    const operand = args[i + 1];
    if (operand === undefined || !/^[0-9a-fA-F]{64}$/.test(operand)) bad = true;
    else digest = operand.toLowerCase();
    i += 1;
  } else if (args[i].startsWith('-')) {
    bad = true;
  } else {
    files.push(args[i]);
  }
}
if (bad || files.length === 0) {
  console.error(usage);
  process.exit(2);
}
const from = process.env.INIT_CWD ?? process.cwd();

const regs = loadRegistries();
const results = files.map((file) => {
  let bytes;
  let doc;
  try {
    bytes = readFileSync(resolve(from, file));
    doc = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    return { file, kind: 'unreadable', errors: [e.message] };
  }
  let checked;
  try {
    checked = validateDocument(file, doc, regs);
  } catch (e) {
    return { file, kind: 'unchecked', errors: [`the validator failed on this file, ${e.message}`] };
  }
  const { kind, errors } = checked;
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
const noTemplate = digest !== undefined && !results.some((r) => r.kind === 'template');
if (noTemplate) console.error('--sha256 was given but no file is a template, so no digest was compared');
process.exitCode = noTemplate || results.some((r) => r.errors.length > 0) ? 1 : 0;
