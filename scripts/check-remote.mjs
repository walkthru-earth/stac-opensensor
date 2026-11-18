// Networked registry check, kept out of npm test so that stays offline.
// It fetches every registered first_template.href, hashes the bytes and compares them to first_template.sha256.
// Broken cases run first against a stubbed fetch, so the rule cannot pass by accident.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const remoteErrors = async (registryDoc, fetchBytes) => {
  const errors = [];
  for (const [slug, entry] of Object.entries(registryDoc.boards ?? {})) {
    const { href, sha256 } = entry.first_template ?? {};
    let bytes;
    try {
      bytes = await fetchBytes(href);
    } catch (error) {
      errors.push(`${slug} first template ${href} could not be fetched, ${error.message}`);
      continue;
    }
    const got = digest(bytes);
    if (got !== sha256) errors.push(`${slug} first template ${href} hashes to ${got}, not ${sha256}`);
  }
  return errors;
};

const httpBytes = async (href) => {
  const response = await fetch(href);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

const boards = JSON.parse(readFileSync('registry/boards.json', 'utf8'));
let failures = 0;

// Broken cases against a stub that serves fixed bytes for every href.
const served = Buffer.from('{"type":"Collection"}');
const stubBoards = (sha256) => ({ boards: { 'acme-probe': { first_template: { href: 'https://example.com/acme-probe/x.json', sha256 } } } });
const cases = {
  'bytes that match': [stubBoards(digest(served)), async () => served, 0],
  'bytes that hash to another digest': [stubBoards('0'.repeat(64)), async () => served, 1],
  'an href that does not answer': [stubBoards(digest(served)), async () => { throw new Error('HTTP 404'); }, 1],
};
for (const [what, [doc, stub, want]] of Object.entries(cases)) {
  const got = (await remoteErrors(doc, stub)).length;
  if (got !== want) {
    console.error(`stub case with ${what} gave ${got} errors, expected ${want}`);
    failures++;
  }
}

for (const error of await remoteErrors(boards, httpBytes)) {
  console.error(`registry/boards.json: ${error}`);
  failures++;
}
if (failures > 0) process.exit(1);
console.log(`Remote OK. ${Object.keys(boards.boards).length} first templates match their href, `
  + `${Object.keys(cases).length} stub cases checked`);
