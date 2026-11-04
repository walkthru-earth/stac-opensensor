// Checks the Thing profile, the board templates and the footers beyond what stac-node-validator does.
// JSON Schema holds the structural rules. This script holds the rules that need more than one document.
// 1. Board templates in templates/ validate, sit at templates/<board>/<firmware.dict>.json and name their dictionary.
// 2. The root Catalog links every Thing Collection by a relative href.
// 3. Every Collection validates, matches its template, and equals the canonical Collection that
//    scripts/canonical.mjs rebuilds from the template, the footer, the owner config and the ledger.
// 4. Every Item validates, sits in the partition and HHMM of its rotation window, has a geometry made of
//    resolution 8 H3 cells, and equals the canonical Item rebuilt from its rows in fixtures/.
// 5. Footers and their GeoParquet geo keys validate and agree with their template, Collection and rows.
// 6. Broken documents must fail, so the checks above cannot pass by accident.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { polygonToCells, cellsToMultiPolygon, cellToLatLng, getResolution, isValidCell } from 'h3-js';
import {
  RESOLUTION, TOLERANCE, EXT, bboxOf, buildItem, buildCollection, differences, windowOf, partitionOf, hhmmOf,
} from './canonical.mjs';

const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const isRelative = (href) => !/^([a-zA-Z][a-zA-Z0-9+.-]*:|\/)/.test(href);
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
const warn = (file, message) => console.warn(`warning ${file}: ${message}`);

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
const close = (a, b) => differences(a, b, '', true).length === 0;
const checkLinks = (file, doc) => {
  const errors = [];
  for (const link of doc.links ?? []) {
    if (!hasScheme(link.href) && !existsSync(join(dirname(file), link.href))) {
      errors.push(`${link.rel} link ${link.href} does not resolve`);
    }
  }
  return errors;
};

// Fixtures. fixtures/thing=<uuid>/owner.json is the owner config, <file>.rows.json the rows of one file.
const fixtureOf = (thing, id) => {
  const path = `fixtures/thing=${thing}/${id}.rows.json`;
  if (!existsSync(path)) return undefined;
  const fixture = read(path);
  return { path, ...fixture, footerDoc: read(fixture.footer) };
};
const ownerOf = (thing) => {
  const path = `fixtures/thing=${thing}/owner.json`;
  return existsSync(path) ? read(path) : undefined;
};

// 3. Collections
const checkCollection = (file, doc) => {
  const errors = [...schemaErrors(profile, doc), ...checkLinks(file, doc)];
  if (basename(dirname(file)) !== `thing=${doc.id}`) {
    errors.push(`Collection does not sit in thing=${doc.id}/`);
  }
  if (!doc['partition:glob']?.includes(`/thing=${doc.id}/`)) {
    errors.push('partition:glob does not name this Thing');
  }
  const entry = describedby(doc, 'application/json').map((l) => templates.get(l['file:checksum'])).find(Boolean);
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

// The canonical Collection from the template, the newest footer of the Thing, the owner config and the ledger.
// The examples hold every uploaded Item, so the ledger is the union of their boxes and their earliest start.
const rebuildCollection = (doc, items) => {
  const owner = ownerOf(doc.id);
  const mine = items.filter(([, item]) => item.collection === doc.id);
  if (!owner || mine.length === 0) return ['no owner config or no Item in fixtures/ to rebuild the Collection from'];
  const fixtures = mine.map(([, item]) => fixtureOf(doc.id, item.id)).filter(Boolean);
  const footer = fixtures[fixtures.length - 1]?.footerDoc;
  const entry = templates.get(`1220${footer?.template?.sha256}`);
  if (!entry) return ['the footer names no template in templates/'];
  const boxes = mine.map(([, item]) => item.bbox);
  const ledger = {
    start: mine.map(([, item]) => item.properties.start_datetime).sort()[0],
    bbox: [0, 1].map((k) => Math.min(...boxes.map((b) => b[k]))).concat([2, 3].map((k) => Math.max(...boxes.map((b) => b[k])))),
  };
  return differences(buildCollection({ template: entry.doc, footer, owner, ledger }), doc)
    .map((d) => `not the canonical Collection, ${d}`);
};

// 4. Items
const checkItem = (file, doc, collection, footer) => {
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
  if (!footer || footer.thing?.id !== doc.collection || !doc.id.includes(`_${footer.firmware?.boot_id}_`)) {
    errors.push('no footer of this Thing and boot');
    return errors;
  }
  const props = doc.properties ?? {};
  if (props['opensensor:mobility'] !== collection['opensensor:mobility']) {
    errors.push('opensensor:mobility differs from the Collection');
  }
  // HHMM and the partition come from the rotation window that holds the first row, as the board writes them.
  const start = new Date(props.start_datetime);
  const window = windowOf(start.getTime() * 1000, footer.file.rotation_interval_s);
  const partition = partitionOf(doc.collection, window);
  if (!dirname(file).endsWith(partition)) {
    errors.push(`Item does not sit in ${partition}, the UTC date of its rotation window`);
  }
  if (!doc.id.startsWith(`data_${hhmmOf(window)}_`)) {
    errors.push(`HHMM in the file name is not ${hhmmOf(window)}, the start of the rotation window of start_datetime`);
  }
  if (new Date(props.end_datetime) < start) {
    errors.push('end_datetime is before start_datetime');
  }
  if (props['opensensor:sample_interval_s'] * 1000 !== footer.acquisition?.sample_interval_ms) {
    errors.push('opensensor:sample_interval_s is not the footer sample_interval_ms over 1000');
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

// The canonical Item from the rows. Its partition path must also be where the Item sits.
const rebuildItem = (file, doc, fixture) => {
  const entry = templates.get(`1220${fixture.footerDoc.template?.sha256}`);
  const built = buildItem({ file: fixture.file, rows: fixture.rows, footer: fixture.footerDoc, template: entry?.doc });
  if (!built.item) return [`the rows give no Item, ${built.none}`];
  const errors = differences(built.item, doc).map((d) => `not the canonical Item, ${d}`);
  if (!file.endsWith(built.path)) errors.push(`the canonical path is ${built.path}`);
  return errors;
};

// Location columns of the rows. A row with no location has null in all four, and a located row is resolution 8.
const checkRows = (fixture) => {
  const errors = [];
  const { rows } = fixture;
  rows.event_time_utc_us.forEach((_, i) => {
    const cell = rows.h3_cell_id?.[i] ?? null;
    const set = [cell, rows.h3_resolution?.[i] ?? null, rows.location_source?.[i] ?? null];
    if (set.every((v) => v === null)) return;
    if (set.some((v) => v === null)) errors.push(`row ${i} has a partial location`);
    else if (!isValidCell(cell) || getResolution(cell) !== rows.h3_resolution[i] || rows.h3_resolution[i] !== RESOLUTION) {
      errors.push(`row ${i} cell is not resolution ${RESOLUTION} or does not match h3_resolution`);
    } else if (![1, 2, 3].includes(rows.location_source[i])) {
      errors.push(`row ${i} location_source ${rows.location_source[i]} is not 1, 2 or 3`);
    }
  });
  return errors;
};

// 2. Walk examples/
const files = readdirSync('examples', { recursive: true }).filter((n) => n.endsWith('.json')).map((n) => `examples/${n}`);
const docs = new Map(files.map((file) => [file, read(file)]));
const collections = new Map();
for (const [file, doc] of docs) {
  if (doc.type === 'Collection') {
    report(file, checkCollection(file, doc));
    collections.set(doc.id, [file, doc]);
  }
}

const checkCatalog = (file, doc) => {
  const errors = checkLinks(file, doc);
  if (!(doc.links ?? []).some((l) => l.rel === 'root' && l.href === './catalog.json')) {
    errors.push('root link is not ./catalog.json');
  }
  const children = (doc.links ?? []).filter((l) => l.rel === 'child');
  for (const link of children) {
    if (!isRelative(link.href) || !/^\.\/thing=[0-9a-f-]{36}\/collection\.json$/.test(link.href)) {
      errors.push(`child link ${link.href} is not ./thing=<uuid>/collection.json`);
    } else if (docs.get(join(dirname(file), link.href))?.type !== 'Collection') {
      errors.push(`child link ${link.href} is not a Collection`);
    }
  }
  for (const [collectionFile] of collections.values()) {
    if (!children.some((l) => join(dirname(file), l.href) === collectionFile)) {
      errors.push(`no child link to ${collectionFile}`);
    }
  }
  return errors;
};
const [catalogFile, catalog] = [...docs].find(([, doc]) => doc.type === 'Catalog');
report(catalogFile, checkCatalog(catalogFile, catalog));

const collectionOf = (file, doc) => {
  const link = doc.links?.find((l) => l.rel === 'collection');
  return link ? docs.get(join(dirname(file), link.href)) : undefined;
};
const items = [];
for (const [file, doc] of docs) {
  if (doc.type === 'Feature') {
    const fixture = fixtureOf(doc.collection, doc.id);
    if (!fixture) {
      report(file, [`no rows in fixtures/thing=${doc.collection}/${doc.id}.rows.json`]);
      continue;
    }
    report(file, [
      ...checkItem(file, doc, collectionOf(file, doc), fixture.footerDoc),
      ...rebuildItem(file, doc, fixture),
    ]);
    report(fixture.path, checkRows(fixture));
    items.push([file, doc, fixture]);
  }
}
for (const [file, doc] of collections.values()) {
  report(file, rebuildCollection(doc, items));
}

// 5. Footers and geo keys
const checkFooter = (doc) => {
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
    // Any immutable URL is allowed. The two known layouts key the template by dictionary or by its own digest.
    const href = doc.template.href;
    if (!href.endsWith(`/${entry.board}/${entry.doc.firmware.dict}.json`) && !href.endsWith(`/${entry.board}/${doc.template.sha256}.json`)) {
      warn(entry.file, `template.href ${href} is neither <board>/<dict>.json nor <board>/<template sha256>.json`);
    }
  }
  const [, collection] = collections.get(doc.thing?.id) ?? [];
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
      warn(doc.thing.id, 'footer sample_interval_ms differs from the template default in the Collection');
    }
    if (!items.some(([, item]) => item.collection === doc.thing.id && item.id.includes(`_${doc.firmware?.boot_id}_`))) {
      errors.push('no Item of this Thing carries firmware.boot_id in its file name');
    }
  }
  return errors;
};

// The GeoParquet 2.0.0 geo key. Its bbox is over the cell centres of the located rows.
const checkGeo = (geo, rows) => {
  const errors = [];
  if (geo.version !== '2.0.0' || geo.primary_column !== 'geometry') {
    errors.push('version is not 2.0.0 or primary_column is not geometry');
  }
  const column = geo.columns?.geometry ?? {};
  if (column.encoding !== 'WKB' || JSON.stringify(column.geometry_types) !== '["Point"]' || 'crs' in column) {
    errors.push('geometry is not WKB Point with no crs');
  }
  const centres = (rows.h3_cell_id ?? []).filter((c) => c !== null).map((c) => cellToLatLng(c));
  if (centres.length === 0) {
    if ('bbox' in column) errors.push('a file with no located row has a bbox');
    return errors;
  }
  const lons = centres.map((p) => p[1]);
  const lats = centres.map((p) => p[0]);
  const want = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  if (!Array.isArray(column.bbox) || column.bbox.length !== 4 || !close(column.bbox, want)) {
    errors.push('bbox is not the bbox of the cell centres of the located rows');
  }
  return errors;
};

const footerFiles = readdirSync('footers').filter((n) => n.endsWith('.json') && !n.endsWith('.geo.json'));
for (const name of footerFiles) {
  const file = `footers/${name}`;
  const doc = read(file);
  report(file, checkFooter(doc));
  const geoFile = file.replace(/\.json$/, '.geo.json');
  const fixture = items.map(([, , f]) => f).find((f) => f.footer === file);
  if (!existsSync(geoFile) || !fixture) {
    report(file, ['no geo key example or no rows of this footer']);
  } else {
    report(geoFile, checkGeo(read(geoFile), fixture.rows));
  }
}

// 6. Broken documents must fail
let rejected = 0;
const mustFail = (file, what, errors, expect) => {
  const hit = expect ? errors.some((e) => e.includes(expect)) : errors.length > 0;
  if (hit) rejected += 1;
  else report(file, [`${what} passed the checks`]);
};
const itemOf = (mobility) => items.find(([, doc]) => doc.properties['opensensor:mobility'] === mobility);
const brokenItems = {
  fixed: {
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
    'a root relative root link': (doc) => {
      doc.links.find((l) => l.rel === 'root').href = '/catalog.json';
    },
    'no file:checksum': (doc) => {
      delete doc.assets.data['file:checksum'];
    },
  },
  moving: {
    'the Grid extension': (doc) => {
      doc.stac_extensions.splice(2, 0, EXT.grid);
      doc.properties['grid:code'] = 'H3-883e628e67fffff';
    },
    'a resolution 7 union': (doc) => {
      doc.geometry = { type: 'Polygon', coordinates: cellsToMultiPolygon(['873e628e6ffffff'], true)[0] };
      doc.bbox = bboxOf(doc.geometry);
    },
    'an absolute data href': (doc) => {
      doc.assets.data.href = `s3://walkthru-earth/opensensor-space/${doc.id}.parquet`;
    },
    'the fixed warning': (doc) => {
      doc.properties['anon:warning'] = 'The geometry is the H3 cell chosen by the owner, not the device position.';
    },
  },
};
for (const [mobility, cases] of Object.entries(brokenItems)) {
  const [file, item, fixture] = itemOf(mobility);
  for (const [what, mutate] of Object.entries(cases)) {
    const doc = structuredClone(item);
    mutate(doc);
    mustFail(file, `a ${mobility} Item with ${what}`, checkItem(file, doc, collectionOf(file, item), fixture.footerDoc));
  }
}

// HHMM is the window start, not the first row. A board that boots at 13:07 still writes data_1300_.
{
  const [file, item, fixture] = itemOf('fixed');
  const late = structuredClone(item);
  late.properties.start_datetime = '2026-10-24T13:07:42.5Z';
  report(file, checkItem(file, late, collectionOf(file, item), fixture.footerDoc)
    .map((e) => `a data_1300_ Item whose first row is 13:07:42 fails, ${e}`));
  const id = item.id.replace('data_1300_', 'data_1307_');
  const renamed = { ...late, id, assets: { data: { ...late.assets.data, href: `./${id}.parquet` } } };
  mustFail(file, 'a data_1307_ Item whose window starts at 13:00', checkItem(join(dirname(file), `${id}.json`), renamed,
    collectionOf(file, item), fixture.footerDoc), 'HHMM');
}

// The rebuild catches a change that every structural check allows.
const brokenRebuilds = {
  'a mean off by 0.01': (doc) => {
    doc.assets.data['table:columns'][0].statistics.mean += 0.01;
  },
  'Table and File swapped in stac_extensions': (doc) => {
    [doc.stac_extensions[0], doc.stac_extensions[1]] = [doc.stac_extensions[1], doc.stac_extensions[0]];
  },
  'a float minimum written as its float32 decimal': (doc) => {
    const column = doc.assets.data['table:columns'].find((c) => c.type === 'float');
    column.statistics.minimum = Number(Math.fround(column.statistics.minimum).toPrecision(7));
  },
  'a whole second end_datetime': (doc) => {
    doc.properties.end_datetime = doc.properties.end_datetime.replace(/\.[0-9]+Z$/, 'Z');
  },
  'a geometry moved by 1e-7 degrees': (doc) => {
    doc.geometry.coordinates[0][0][0] += 1e-7;
  },
};
{
  const [file, item, fixture] = itemOf('fixed');
  for (const [what, mutate] of Object.entries(brokenRebuilds)) {
    const doc = structuredClone(item);
    mutate(doc);
    mustFail(file, `an Item with ${what}`, rebuildItem(file, doc, fixture), 'not the canonical Item');
  }
  const shifted = structuredClone(item);
  shifted.geometry.coordinates[0][0][0] += TOLERANCE / 10;
  report(file, rebuildItem(file, shifted, fixture).map((e) => `a geometry within ${TOLERANCE} fails, ${e}`));
}

// Files that get no Item.
const noItem = {
  'a fixed file with two cells': (f) => {
    f.rows.h3_cell_id[5] = '887576970ffffff';
  },
  'a resolution 7 cell': (f) => {
    f.rows.h3_cell_id = f.rows.h3_cell_id.map(() => '877576970ffffff');
  },
  'no located row': (f) => {
    f.rows.h3_cell_id = f.rows.h3_cell_id.map(() => null);
  },
  'a row with no UTC time': (f) => {
    f.rows.event_time_utc_us[3] = null;
  },
  'an undated name': (f) => {
    f.file.name = 'unsynced_0001.parquet';
  },
};
{
  const [file, , fixture] = itemOf('fixed');
  const entry = templates.get(`1220${fixture.footerDoc.template.sha256}`);
  for (const [what, mutate] of Object.entries(noItem)) {
    const f = structuredClone(fixture);
    mutate(f);
    const built = buildItem({ file: f.file, rows: f.rows, footer: f.footerDoc, template: entry.doc });
    mustFail(file, `the rows of ${what}`, built.item ? [] : [built.none]);
  }
}

const brokenCollections = {
  'a column the template does not have': (doc) => {
    columnsOf(doc)[0] = { ...columnsOf(doc)[0], unit: 'mg/m3' };
  },
  'a closed temporal interval': (doc) => {
    doc.extent.temporal.interval[0][1] = '2026-10-25T00:00:00Z';
  },
  'a root relative parent link': (doc) => {
    doc.links.find((l) => l.rel === 'parent').href = '/catalog.json';
  },
  'a protocol relative root link': (doc) => {
    doc.links.find((l) => l.rel === 'root').href = '//example.com/catalog.json';
  },
};
for (const [file, collection] of collections.values()) {
  for (const [what, mutate] of Object.entries(brokenCollections)) {
    const doc = structuredClone(collection);
    mutate(doc);
    mustFail(file, `a Collection with ${what}`, checkCollection(file, doc));
  }
  const shrunk = structuredClone(collection);
  shrunk.extent.temporal.interval[0][0] = '2026-10-24T14:00:00Z';
  mustFail(file, 'a Collection with a shrunk extent', rebuildCollection(shrunk, items), 'not the canonical Collection');
}

const brokenFooters = {
  'a mobility that differs from the Collection': (doc) => {
    doc.thing.mobility = doc.thing.mobility === 'fixed' ? 'moving' : 'fixed';
  },
  'a template.sha256 of no template': (doc) => {
    doc.template.sha256 = '0'.repeat(64);
  },
  'a rotation of 1000 s': (doc) => {
    doc.file.rotation_interval_s = 1000;
  },
  'version 0.2.0': (doc) => {
    doc.version = '0.2.0';
  },
};
for (const name of footerFiles) {
  const file = `footers/${name}`;
  for (const [what, mutate] of Object.entries(brokenFooters)) {
    const doc = read(file);
    mutate(doc);
    mustFail(file, `a footer with ${what}`, checkFooter(doc));
  }
  const patch = read(file);
  patch.version = '0.1.7';
  report(file, checkFooter(patch).map((e) => `a 0.1.7 footer fails, ${e}`));
}
{
  const [, , fixture] = itemOf('moving');
  const geoFile = fixture.footer.replace(/\.json$/, '.geo.json');
  const brokenGeo = {
    'a crs': (geo) => {
      geo.columns.geometry.crs = 'OGC:CRS84';
    },
    'a bbox over cell polygons': (geo) => {
      geo.columns.geometry.bbox[0] -= 0.004;
    },
    'a Polygon type': (geo) => {
      geo.columns.geometry.geometry_types = ['Polygon'];
    },
  };
  for (const [what, mutate] of Object.entries(brokenGeo)) {
    const geo = read(geoFile);
    mutate(geo);
    mustFail(geoFile, `a geo key with ${what}`, checkGeo(geo, fixture.rows));
  }
  const partial = structuredClone(fixture);
  partial.rows.location_source[0] = 2;
  mustFail(fixture.path, 'a row with a partial location', checkRows(partial));
}

if (failures > 0) {
  process.exit(1);
}
console.log(`Profile OK. ${templates.size} templates, ${collections.size} Collections, ${items.length} Items `
  + `rebuilt from rows, ${footerFiles.length} footers with geo keys, ${rejected} broken cases rejected`);
