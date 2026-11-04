// Checks the Thing profile, the board templates and the footers beyond what stac-node-validator does.
// JSON Schema holds the structural rules. This script holds the rules that need more than one document.
// 1. Board templates in templates/ validate, sit at templates/<board>/<firmware.dict>.json and name their dictionary.
// 2. Every Collection and Item under examples/ validates against json-schema/profile.json.
// 3. Every relative link resolves to a file, and each Item sits in the partition its start time names.
// 4. A Collection carries its template's columns plus only title and opensensor:scale, and both describedby
//    checksums match that template. Scales, primary columns, field ids, gates and derived inputs are consistent.
// 5. Item geometry is the union of resolution 8 H3 cells, the bbox is its bbox, and the Collection extent covers it.
// 6. Footers in footers/ validate and agree with their template and Thing Collection.
// 7. A few broken Items must fail, so the checks above cannot pass by accident.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { polygonToCells, cellsToMultiPolygon, getResolution, isValidCell } from 'h3-js';

const RESOLUTION = 8;
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const hasScheme = (href) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
for (const name of ['schema', 'profile', 'template', 'footer']) {
  ajv.addSchema(read(`json-schema/${name}.json`));
}
const base = 'https://walkthru-earth.github.io/stac-opensensor/v0.1.0/';
const profile = ajv.getSchema(`${base}profile.json`);
const templateSchema = ajv.getSchema(`${base}template.json`);
const footerSchema = ajv.getSchema(`${base}footer.json`);
const schemaErrors = (validate, doc) => (validate(doc) ? [] : [ajv.errorsText(validate.errors)]);

let failures = 0;
const report = (file, errors) => {
  for (const message of errors) {
    failures += 1;
    console.error(`${file}: ${message}`);
  }
};

// 1. Templates
const templates = new Map();
for (const name of readdirSync('templates', { recursive: true }).filter((n) => n.endsWith('.json'))) {
  const file = `templates/${name}`;
  const doc = read(file);
  const errors = schemaErrors(templateSchema, doc);
  const dictLink = doc.links?.find((l) => l.rel === 'describedby');
  if (dictLink?.['file:checksum'] !== `1220${doc.firmware?.dict}`) {
    errors.push('describedby file:checksum does not match firmware.dict');
  }
  if (!/^[a-z0-9-]+\/[0-9a-f]{64}\.json$/.test(name) || !name.endsWith(`/${doc.firmware?.dict}.json`)) {
    errors.push('path is not templates/<board>/<firmware.dict>.json');
  }
  report(file, errors);
  templates.set(`1220${sha256(file)}`, { file, doc, board: name.split('/')[0] });
}

// Shared helpers
const columnsOf = (doc) => doc.item_assets?.data?.['table:columns'] ?? [];
const publicColumn = ({ title, 'opensensor:scale': scale, ...rest }) => JSON.stringify(rest);
const describedby = (doc, type) => (doc.links ?? []).filter((l) => l.rel === 'describedby' && l.type === type);

const ringsOf = (geometry) => {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
};
const bboxOf = (geometry) => {
  const points = ringsOf(geometry).flat(2);
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const close = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => close(v, b[i]));
  }
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9;
};

const checkLinks = (file, doc) => {
  const errors = [];
  for (const link of doc.links ?? []) {
    if (!hasScheme(link.href) && !existsSync(join(dirname(file), link.href))) {
      errors.push(`${link.rel} link ${link.href} does not resolve`);
    }
  }
  return errors;
};

// 4. Collections
const checkCollection = (file, doc) => {
  const errors = [...schemaErrors(profile, doc), ...checkLinks(file, doc)];
  if (basename(dirname(file)) !== `thing=${doc.id}`) {
    errors.push(`Collection does not sit in thing=${doc.id}/`);
  }
  if (!doc['partition:glob']?.includes(`/thing=${doc.id}/`)) {
    errors.push('partition:glob does not name this Thing');
  }
  const templateLinks = describedby(doc, 'application/json');
  const entry = templateLinks.map((l) => templates.get(l['file:checksum'])).find(Boolean);
  if (!entry) {
    errors.push('no application/json describedby link whose file:checksum matches a template in templates/');
    return errors;
  }
  const dictLinks = describedby(doc, 'text/plain');
  if (dictLinks.length !== 1 || dictLinks[0]['file:checksum'] !== `1220${entry.doc.firmware.dict}`) {
    errors.push(`text/plain describedby link is not the dictionary of ${entry.file}`);
  }
  const columns = columnsOf(doc);
  if (JSON.stringify(columns.map(publicColumn)) !== JSON.stringify(columnsOf(entry.doc).map(publicColumn))) {
    errors.push(`columns differ from ${entry.file} beyond title and opensensor:scale`);
  }
  for (const key of ['keywords', 'instruments', 'opensensor:sample_interval_s']) {
    if (JSON.stringify(doc[key]) !== JSON.stringify(entry.doc[key])) {
      errors.push(`${key} differs from ${entry.file}`);
    }
  }
  const names = new Set(columns.map((c) => c.name));
  const data = doc.item_assets?.data ?? {};
  for (const key of ['table:primary_datetime', 'table:primary_geometry']) {
    if (key in data && !names.has(data[key])) {
      errors.push(`${key} ${data[key]} is not a column`);
    }
  }
  const ids = new Set();
  for (const column of columns) {
    const scale = column['opensensor:scale'];
    if (scale !== undefined && !doc['opensensor:scales']?.[scale]) {
      errors.push(`column ${column.name} points at missing scale ${scale}`);
    }
    const id = column['opensensor:field_id'];
    if (id !== undefined) {
      if (!Number.isInteger(id) || id < 1 || ids.has(id)) {
        errors.push(`column ${column.name} has a repeated or invalid field_id ${id}`);
      }
      ids.add(id);
    }
    const gate = column['opensensor:valid_when']?.column;
    if (gate !== undefined && !names.has(gate)) {
      errors.push(`column ${column.name} valid_when names missing column ${gate}`);
    }
    for (const from of column['opensensor:derived']?.from ?? []) {
      if (!names.has(from)) {
        errors.push(`column ${column.name} derived.from names missing column ${from}`);
      }
    }
  }
  return errors;
};

// 3 and 5. Items
const checkItem = (file, doc, collection) => {
  const errors = [...schemaErrors(profile, doc), ...checkLinks(file, doc)];
  const stem = basename(file, '.json');
  if (doc.id !== stem) {
    errors.push(`id ${doc.id} is not the file name ${stem}`);
  }
  if (doc.assets?.data?.href !== `./${doc.id}.parquet`) {
    errors.push(`data href is not ./${doc.id}.parquet`);
  }
  if (!collection || collection.id !== doc.collection) {
    errors.push('collection link does not reach the Collection named by collection');
    return errors;
  }
  const props = doc.properties ?? {};
  if (props['opensensor:mobility'] !== collection['opensensor:mobility']) {
    errors.push('opensensor:mobility differs from the Collection');
  }
  const start = new Date(props.start_datetime);
  const pad = (n) => String(n).padStart(2, '0');
  const partition = `thing=${doc.collection}/year=${start.getUTCFullYear()}/month=${pad(start.getUTCMonth() + 1)}`
    + `/day=${pad(start.getUTCDate())}`;
  if (!dirname(file).endsWith(partition)) {
    errors.push(`Item does not sit in ${partition}, the UTC date of start_datetime`);
  }
  if (!doc.id.startsWith(`data_${pad(start.getUTCHours())}${pad(start.getUTCMinutes())}_`)) {
    errors.push('HHMM in the file name is not the start_datetime');
  }
  if (new Date(props.end_datetime) < start) {
    errors.push('end_datetime is before start_datetime');
  }

  // The geometry is cellsToMultiPolygon of the distinct cells in ascending order, so every writer gets the same JSON.
  const cells = [...new Set(ringsOf(doc.geometry).flatMap((polygon) => polygonToCells(polygon, RESOLUTION, true)))].sort();
  if (cells.length === 0 || !close(cellsToMultiPolygon(cells, true), ringsOf(doc.geometry))) {
    errors.push(`geometry is not a union of resolution ${RESOLUTION} H3 cells`);
  }
  const code = props['grid:code'];
  if (code !== undefined) {
    const cell = code.replace(/^H3-/, '');
    if (!isValidCell(cell) || getResolution(cell) !== RESOLUTION) {
      errors.push(`grid:code ${code} is not a resolution ${RESOLUTION} H3 cell`);
    } else if (doc.geometry?.type !== 'Polygon' || !close(cellsToMultiPolygon([cell], true), [doc.geometry.coordinates])) {
      errors.push('geometry is not the polygon of grid:code');
    }
  }
  if (!close(doc.bbox, bboxOf(doc.geometry))) {
    errors.push('bbox is not the bbox of the geometry');
  }
  const covered = (collection.extent?.spatial?.bbox ?? []).some(
    (b) => b[0] <= doc.bbox[0] && b[1] <= doc.bbox[1] && b[2] >= doc.bbox[2] && b[3] >= doc.bbox[3],
  );
  if (!covered) {
    errors.push('Collection spatial extent does not cover the Item bbox');
  }
  const [from, to] = collection.extent?.temporal?.interval?.[0] ?? [];
  if (new Date(from) > start || (to !== null && new Date(to) < new Date(props.end_datetime))) {
    errors.push('Collection temporal extent does not cover the Item');
  }
  const names = new Set(columnsOf(collection).map((c) => c.name));
  for (const column of doc.assets?.data?.['table:columns'] ?? []) {
    if (!names.has(column.name)) {
      errors.push(`statistics name missing column ${column.name}`);
    }
  }
  return errors;
};

// 2. Walk examples/
const files = readdirSync('examples', { recursive: true }).filter((n) => n.endsWith('.json')).map((n) => `examples/${n}`);
const docs = new Map(files.map((file) => [file, read(file)]));
const collections = new Map();
for (const [file, doc] of docs) {
  if (doc.type === 'Catalog') {
    report(file, checkLinks(file, doc));
  } else if (doc.type === 'Collection') {
    report(file, checkCollection(file, doc));
    collections.set(doc.id, doc);
  }
}
const collectionOf = (file, doc) => {
  const link = doc.links?.find((l) => l.rel === 'collection');
  return link ? docs.get(join(dirname(file), link.href)) : undefined;
};
const items = [];
for (const [file, doc] of docs) {
  if (doc.type === 'Feature') {
    report(file, checkItem(file, doc, collectionOf(file, doc)));
    items.push([file, doc]);
  }
}

// 6. Footers
for (const name of readdirSync('footers').filter((n) => n.endsWith('.json'))) {
  const file = `footers/${name}`;
  const doc = read(file);
  const errors = schemaErrors(footerSchema, doc);
  const entry = templates.get(`1220${doc.template?.sha256}`);
  if (!entry) {
    errors.push('template.sha256 matches no template in templates/');
  } else {
    if (doc.dictionary?.sha256 !== entry.doc.firmware.dict) {
      errors.push(`dictionary.sha256 differs from firmware.dict in ${entry.file}`);
    }
    if (doc.firmware?.schema !== entry.doc.id || doc.thing?.board !== entry.board) {
      errors.push(`firmware.schema or thing.board differs from ${entry.file}`);
    }
    if (!doc.template.href.endsWith(`/${entry.board}/${entry.doc.firmware.dict}.json`)) {
      errors.push('template.href does not end in <board>/<dict>.json');
    }
  }
  const collection = collections.get(doc.thing?.id);
  if (!collection) {
    errors.push('thing.id names no Thing Collection in examples/');
  } else {
    if (collection['opensensor:mobility'] !== doc.thing.mobility) {
      errors.push('thing.mobility differs from the Collection');
    }
    if (!describedby(collection, 'application/json').some((l) => l['file:checksum'] === `1220${doc.template?.sha256}`)) {
      errors.push('template.sha256 differs from the Collection template link');
    }
    if (collection['opensensor:sample_interval_s'] * 1000 !== doc.acquisition?.sample_interval_ms) {
      errors.push('sample_interval_ms differs from the Collection');
    }
    if (!items.some(([, item]) => item.collection === doc.thing.id && item.id.includes(`_${doc.firmware?.boot_id}_`))) {
      errors.push('no Item of this Thing carries firmware.boot_id in its file name');
    }
  }
  report(file, errors);
}

// 7. Broken Items must fail
const [fixedFile, fixedItem] = items.find(([, doc]) => doc.properties['opensensor:mobility'] === 'fixed');
const fixedCollection = collectionOf(fixedFile, fixedItem);
const broken = {
  'a resolution 7 cell': (doc) => {
    doc.properties['grid:code'] = 'H3-877576970ffffff';
    [doc.geometry.coordinates] = cellsToMultiPolygon(['877576970ffffff'], true);
    doc.bbox = bboxOf(doc.geometry);
  },
  'an absolute data href': (doc) => {
    doc.assets.data.href = `https://data.source.coop/walkthru-earth/opensensor-space/${doc.id}.parquet`;
  },
  'a datetime': (doc) => {
    doc.properties.datetime = doc.properties.start_datetime;
  },
  'a coarser anon:size': (doc) => {
    doc.properties['anon:size'] = 0.03;
  },
  'an absolute collection link': (doc) => {
    doc.links.find((l) => l.rel === 'collection').href = 'https://example.com/collection.json';
  },
};
for (const [what, mutate] of Object.entries(broken)) {
  const doc = structuredClone(fixedItem);
  mutate(doc);
  if (checkItem(fixedFile, doc, fixedCollection).length === 0) {
    report(fixedFile, [`an Item with ${what} passed the checks`]);
  }
}

if (failures > 0) {
  process.exit(1);
}
console.log(`Profile OK. ${templates.size} templates, ${collections.size} Collections, ${items.length} Items, `
  + `${readdirSync('footers').length} footers, ${Object.keys(broken).length} broken Items rejected`);
