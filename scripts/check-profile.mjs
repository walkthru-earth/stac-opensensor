// Checks the Thing profile and the board templates beyond what stac-node-validator does.
// 1. Thing Collections and file Items in examples/ validate against json-schema/profile.json.
// 2. Board templates in templates/ validate against json-schema/template.json.
// 3. A Thing Collection carries its template's columns unchanged, and both checksums match.
// 4. Parquet footers in footers/ validate against json-schema/footer.json and point at a template and its dictionary.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
for (const name of ['schema', 'profile', 'template', 'footer']) {
  ajv.addSchema(read(`json-schema/${name}.json`));
}
const base = 'https://walkthru-earth.github.io/stac-opensensor/v0.1.0/';
const profile = ajv.getSchema(`${base}profile.json`);
const template = ajv.getSchema(`${base}template.json`);
const footer = ajv.getSchema(`${base}footer.json`);

let failures = 0;
const fail = (file, message) => {
  failures += 1;
  console.error(`${file}: ${message}`);
};
const check = (validate, file, doc) => {
  if (!validate(doc)) {
    fail(file, ajv.errorsText(validate.errors));
  }
};

const templates = new Map();
for (const name of readdirSync('templates').filter((n) => n.endsWith('.json'))) {
  const file = `templates/${name}`;
  const doc = read(file);
  check(template, file, doc);
  const dictLink = doc.links.find((l) => l.rel === 'describedby');
  if (dictLink?.['file:checksum'] !== `1220${doc.firmware.dict}`) {
    fail(file, 'describedby file:checksum does not match firmware.dict');
  }
  templates.set(`1220${sha256(file)}`, { file, doc });
}

const publicColumn = ({ title, 'opensensor:scale': scale, ...rest }) => JSON.stringify(rest);
for (const name of readdirSync('examples').filter((n) => n.endsWith('.json'))) {
  const file = `examples/${name}`;
  const doc = read(file);
  if (doc.type === 'Catalog') {
    continue;
  }
  check(profile, file, doc);
  if (doc.type !== 'Collection') {
    continue;
  }
  const link = doc.links.find((l) => l.rel === 'describedby' && templates.has(l['file:checksum']));
  if (!link) {
    fail(file, 'no describedby link whose file:checksum matches a template in templates/');
    continue;
  }
  const { file: tFile, doc: t } = templates.get(link['file:checksum']);
  const thing = doc.item_assets.data['table:columns'].map(publicColumn);
  const board = t.item_assets.data['table:columns'].map(publicColumn);
  if (JSON.stringify(thing) !== JSON.stringify(board)) {
    fail(file, `columns differ from ${tFile} beyond title and opensensor:scale`);
  }
}

for (const name of readdirSync('footers').filter((n) => n.endsWith('.json'))) {
  const file = `footers/${name}`;
  const doc = read(file);
  check(footer, file, doc);
  const entry = templates.get(`1220${doc.template?.sha256}`);
  if (!entry) {
    fail(file, 'template.sha256 matches no template in templates/');
    continue;
  }
  if (doc.dictionary?.sha256 !== entry.doc.firmware.dict) {
    fail(file, `dictionary.sha256 differs from firmware.dict in ${entry.file}`);
  }
}

if (failures > 0) {
  process.exit(1);
}
console.log('Profile, templates and footers OK');
