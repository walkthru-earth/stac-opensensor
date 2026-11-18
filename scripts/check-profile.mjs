// Checks the Thing profile, the board templates and the footers beyond what stac-node-validator does.
// JSON Schema holds the structural rules. This script holds the rules that need more than one document.
// 0. The property and scale registries in registry/ validate and agree with each other.
// 1. Board templates in templates/ validate, sit at templates/<board>/<firmware.dict>.json, name their dictionary,
//    use only properties of the registry, with its units and its scales, and declare every setup key they show.
// 2. The root Catalog links every Thing Collection by a relative href.
// 3. Every Collection validates, matches its template, and equals the canonical Collection that
//    scripts/canonical.mjs rebuilds from the template, the footer, the owner config and the ledger.
// 4. Every Item validates, sits in the partition and HHMM of its rotation window, has a geometry made of
//    resolution 8 H3 cells, and equals the canonical Item rebuilt from its rows in fixtures/.
// 5. Footers and their GeoParquet geo keys validate and agree with their template, Collection and rows.
// 6. Every board slug in templates/, footers/ and examples/ is in registry/boards.json.
// 7. scripts/validate.mjs passes every document of this repository on its own.
// 8. Broken documents must fail, so the checks above cannot pass by accident.
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import {
  polygonToCells, cellsToMultiPolygon, cellToLatLng, cellToParent, cellToCenterChild, getResolution, isValidCell,
} from 'h3-js';
import {
  RESOLUTION, TOLERANCE, EXT, bboxOf, geometryOf, buildItem, buildCollection, differences, windowOf, partitionOf, hhmmOf,
} from './canonical.mjs';
import * as shared from './checks.mjs';

const { read, sha256, schemaErrors, checkRegistry, columnErrors, columnsOf } = shared;
const {
  profile, footer: footerSchema, registry: registrySchema, boardRegistry: boardRegistrySchema,
} = shared.schemas;
const isRelative = (href) => !/^([a-zA-Z][a-zA-Z0-9+.-]*:|\/)/.test(href);
const hasScheme = (href) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);

let failures = 0;
const report = (file, errors) => {
  for (const message of errors) {
    failures += 1;
    console.error(`${file}: ${message}`);
  }
};
const warn = (file, message) => console.warn(`warning ${file}: ${message}`);

// 0. Registries
const registry = read('registry/properties.json');
const scaleRegistry = read('registry/scales.json');
report('registry/', checkRegistry(registry, scaleRegistry));

// The single document checks live in checks.mjs, shared with scripts/validate.mjs.
const hintErrors = (doc) => shared.hintErrors(doc, scaleRegistry);
const registryErrors = (doc) => shared.registryErrors(doc, registry);

// 1. Templates
const checkTemplate = (doc) => shared.checkTemplate(doc, { registry, scaleRegistry });
const templates = new Map();
// Every template file with its folder, kept apart from the digest-keyed map, so identical copies all count.
const templateFolders = [];
for (const name of readdirSync('templates', { recursive: true }).filter((n) => n.endsWith('.json'))) {
  const file = `templates/${name}`;
  const doc = read(file);
  const errors = checkTemplate(doc);
  if (!/^[a-z0-9-]+\/[0-9a-f]{64}\.json$/.test(name) || !name.endsWith(`/${doc.firmware?.dict}.json`)) {
    errors.push('path is not templates/<board>/<firmware.dict>.json');
  }
  report(file, errors);
  templates.set(`1220${sha256(file)}`, { file, doc, board: name.split('/')[0] });
  templateFolders.push([file, name.split('/')[0]]);
}

// Shared helpers
// The display hints a Collection may change. Every other column member is the template's.
const HINTS = ['title', 'description', 'opensensor:title_i18n', 'opensensor:description_i18n', 'opensensor:decimals',
  'opensensor:group', 'opensensor:scale'];
const publicColumn = (column) => JSON.stringify(Object.fromEntries(Object.entries(column)
  .filter(([key]) => !HINTS.includes(key))));
const describedby = (doc, type) => (doc.links ?? []).filter((l) => l.rel === 'describedby' && l.type === type);
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
  const errors = [...schemaErrors(profile, doc), ...checkLinks(file, doc), ...hintErrors(doc)];
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
    errors.push(`columns differ from ${entry.file} beyond the display hints`);
  }
  for (const key of ['keywords', 'instruments', 'opensensor:sample_interval_s']) {
    if (JSON.stringify(doc[key]) !== JSON.stringify(entry.doc[key])) {
      errors.push(`${key} differs from ${entry.file}`);
    }
  }
  errors.push(...columnErrors(doc));
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
  const errors = [...shared.itemErrors(file, doc), ...checkLinks(file, doc)];
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
  if (props['opensensor:sample_interval_s'] * 1000 !== footer.acquisition?.sample_interval_ms) {
    errors.push('opensensor:sample_interval_s is not the footer sample_interval_ms over 1000');
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
const files = readdirSync('examples', { recursive: true }).filter((n) => n.endsWith('.json')).sort()
  .map((n) => `examples/${n}`);
const docs = new Map(files.map((file) => [file, read(file)]));
const collections = new Map();
for (const [file, doc] of docs) {
  if (doc.type === 'Collection') {
    report(file, checkCollection(file, doc));
    collections.set(doc.id, [file, doc]);
  }
}

const checkCatalog = (file, doc) => {
  const errors = [...checkLinks(file, doc), ...shared.catalogErrors(doc)];
  const children = (doc.links ?? []).filter((l) => l.rel === 'child');
  for (const link of children) {
    if (!isRelative(link.href) || !/^\.\/thing=[0-9a-f-]{36}\/collection\.json$/.test(link.href)) {
      continue;
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
  const errors = shared.geoKeyErrors(geo);
  const column = geo.columns?.geometry ?? {};
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

// 6. Board slugs. Every slug in use is registered, and a registered first template sits under its own slug.
const boards = read('registry/boards.json');
const slugOfHref = (href) => href.match(/\/([a-z0-9]+(?:-[a-z0-9]+)*)\/[0-9a-f]{64}\.json$/)?.[1];
const slugUses = [
  ...templateFolders,
  ...footerFiles.flatMap((name) => [[`footers/${name}`, name.replace(/\.json$/, '')],
    [`footers/${name} thing.board`, read(`footers/${name}`).thing?.board]]),
  ...[...collections.values()].flatMap(([file, doc]) => describedby(doc, 'application/json')
    .map((l) => [`${file} template link`, slugOfHref(l.href)])),
];
const slugErrors = (registryDoc, uses) => {
  const errors = [...schemaErrors(registrySchema, registryDoc), ...schemaErrors(boardRegistrySchema, registryDoc)];
  const known = registryDoc.boards ?? {};
  for (const [where, slug] of uses) {
    if (!Object.hasOwn(known, slug)) errors.push(`${where} uses board ${slug}, which registry/boards.json does not list`);
  }
  for (const [slug, entry] of Object.entries(known)) {
    const template = templates.get(`1220${entry.first_template?.sha256}`);
    if (!template) {
      errors.push(`${slug} first template sha256 matches no template copy in templates/`);
    } else if (template.board !== slug) {
      errors.push(`${slug} first template is ${template.file}, under another board`);
    }
    if (entry.first_template && slugOfHref(entry.first_template.href) !== slug) {
      errors.push(`${slug} first template href does not end in /${slug}/<sha256>.json`);
    }
  }
  return errors;
};
report('registry/boards.json', slugErrors(boards, slugUses));

// 7. The validator for outside files passes every document here.
const regs = { registry, scaleRegistry, boards };
const allDocuments = ['templates', 'footers', 'examples', 'registry']
  .flatMap((dir) => readdirSync(dir, { recursive: true }).filter((n) => n.endsWith('.json')).map((n) => `${dir}/${n}`));
for (const file of allDocuments) {
  const { kind, errors } = shared.validateDocument(file, read(file), regs);
  report(file, errors.map((e) => `validate.mjs ${kind}, ${e}`));
}

// 8. Broken documents must fail
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
  'a scale with no period': (doc) => {
    for (const scale of Object.values(doc['opensensor:scales'] ?? {})) {
      delete scale.period;
    }
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

// Display hints and the registry. A template may carry every hint, and a wrong hint must fail.
const SEN6X_STATUS_BITS = [
  [4, 'fan-error', 'Fan on but its speed is 0 RPM. Sticky.'],
  [6, 'rht-error', 'Humidity and temperature sensor error. Sticky.'],
  [11, 'pm-error', 'Particulate sensor error. Sticky.'],
  [12, 'co2-error', 'CO2 sensor error. Sticky.'],
  [21, 'fan-speed-warning', 'Fan speed off target. Clears itself.'],
].map(([offset, name, description]) => ({
  offset, length: 1, name, description, classes: [{ value: 0, name: 'ok' }, { value: 1, name: 'set' }],
}));
SEN6X_STATUS_BITS[0]['opensensor:title_i18n'] = { ar: 'خطأ المروحة' };
SEN6X_STATUS_BITS[0].classes[1]['opensensor:title_i18n'] = { ar: 'مرفوع' };
// A setup manifest in the shape of firmware decision 0003. The key names are a sketch, not the firmware's.
const CROWPANEL_MANIFEST = {
  setup: [
    { id: 'name', req: false },
    { id: 'location', req: true },
    { id: 'wifi', req: false },
    {
      id: 'panel', req: false, label: 'Display', label_i18n: { ar: 'الشاشة' }, keys: ['panel.theme', 'panel.start_page'],
    },
  ],
  settings: [
    { id: 'location' },
    { id: 'wifi' },
    { id: 'panel', label: 'Display', keys: ['panel.theme', 'panel.refresh_s', 'panel.start_page', 'panel.label'] },
    {
      id: 'air', label: 'Air sensor', label_i18n: { ar: 'مستشعر الهواء' }, keys: ['sen6x.co2_asc', 'sen6x.fan_clean'],
    },
  ],
  config_keys: {
    'panel.theme': {
      type: 'enum', values: ['light', 'dark'], applies: 'immediately', page: 7, label: 'Theme', label_i18n: { ar: 'المظهر' },
    },
    'panel.refresh_s': { type: 'integer', values: { min: 60, max: 3600 }, applies: 'next sample', page: 7, label: 'Refresh' },
    'panel.start_page': { type: 'enum', values: [0, 1, 2], applies: 'next boot', page: 7, label: 'Start page' },
    'panel.label': { type: 'text', values: { min: 0, max: 24 }, applies: 'immediately', page: 7, label: 'Panel label' },
    'sen6x.co2_asc': { type: 'boolean', applies: 'next boot', page: 7, label: 'CO2 self calibration' },
    'sen6x.fan_clean': { type: 'boolean', applies: 'action', page: 7, label: 'Clean the fan' },
  },
};
const hinted = (() => {
  const entry = [...templates.values()].find((t) => t.board === 'elecrow-crowpanel-epaper-42');
  const doc = structuredClone(entry.doc);
  const column = (name) => columnsOf(doc).find((c) => c.name === name);
  doc['opensensor:primary'] = 'pm25_mass_ug_m3';
  doc['opensensor:scales'] = { 'who-2021-pm25': scaleRegistry.scales['who-2021-pm25'] };
  Object.assign(column('pm25_mass_ug_m3'), {
    title: 'PM2.5',
    description: 'Fine particles from the SEN63C.',
    'opensensor:title_i18n': { ar: 'الجسيمات الدقيقة PM2.5' },
    'opensensor:description_i18n': { en: 'Fine particles from the SEN63C.' },
    'opensensor:decimals': 1,
    'opensensor:group': 'particulate',
    'opensensor:scale': 'who-2021-pm25',
  });
  column('sen6x_device_status')['classification:bitfields'] = SEN6X_STATUS_BITS;
  Object.assign(column('sen6x_status')['classification:classes'].find((c) => c.name === 'warming'), {
    title: 'Warming up',
    'opensensor:title_i18n': { ar: 'قيد التسخين' },
    'opensensor:description_i18n': { en: 'The sensor is still settling.' },
  });
  Object.assign(doc.firmware, structuredClone(CROWPANEL_MANIFEST));
  return { file: entry.file, doc };
})();
report(hinted.file, checkTemplate(hinted.doc).map((e) => `the template with every display hint fails, ${e}`));
{
  const [file, collection] = [...collections.values()][0];
  const doc = structuredClone(collection);
  const column = columnsOf(doc).find((c) => c.unit === 'ug/m3');
  Object.assign(column, {
    description: 'Owner note on this column.',
    'opensensor:title_i18n': { en: 'Fine dust' },
    'opensensor:decimals': 0,
    'opensensor:group': 'particulate',
  });
  report(file, checkCollection(file, doc).map((e) => `a Collection with owner display hints fails, ${e}`));
}
const brokenTemplates = {
  'a primary that is not a column': (doc) => {
    doc['opensensor:primary'] = 'pm3_mass_ug_m3';
  },
  'a property the registry does not have': (doc) => {
    columnsOf(doc)[0]['opensensor:property'] = 'urn:walkthru-earth:property:unknown';
  },
  'a unit that differs from the registry': (doc) => {
    columnsOf(doc).find((c) => c.name === 'co2_ppm').unit = 'ppm';
  },
  'a scale the template does not hold': (doc) => {
    delete doc['opensensor:scales'];
  },
  'a WHO scale with another guideline': (doc) => {
    doc['opensensor:scales']['who-2021-pm25'] = { ...doc['opensensor:scales']['who-2021-pm25'], guideline: 10 };
  },
  'a scale with no period': (doc) => {
    const { period, ...rest } = doc['opensensor:scales']['who-2021-pm25'];
    doc['opensensor:scales']['who-2021-pm25'] = rest;
  },
  'a scale period that is not an ISO 8601 duration': (doc) => {
    doc['opensensor:scales']['who-2021-pm25'] = { ...doc['opensensor:scales']['who-2021-pm25'], period: '24h' };
  },
  'a WHO scale with another period': (doc) => {
    doc['opensensor:scales']['who-2021-pm25'] = { ...doc['opensensor:scales']['who-2021-pm25'], period: 'P1Y' };
  },
  'decimals of -1': (doc) => {
    columnsOf(doc).find((c) => c.name === 'pm25_mass_ug_m3')['opensensor:decimals'] = -1;
  },
  'a group outside the vocabulary': (doc) => {
    columnsOf(doc).find((c) => c.name === 'pm25_mass_ug_m3')['opensensor:group'] = 'weather';
  },
  'an upper case language code': (doc) => {
    columnsOf(doc).find((c) => c.name === 'pm25_mass_ug_m3')['opensensor:title_i18n'] = { EN: 'PM2.5' };
  },
  'bit fields on a column that is not {bitmask}': (doc) => {
    columnsOf(doc).find((c) => c.name === 'sen6x_status')['classification:bitfields'] = SEN6X_STATUS_BITS;
  },
  'an upper case language code on a class': (doc) => {
    columnsOf(doc).find((c) => c.name === 'sen6x_status')['classification:classes'][1]['opensensor:title_i18n'] = { AR: 'x' };
  },
  'an empty translation on a bit field': (doc) => {
    columnsOf(doc).find((c) => c.name === 'sen6x_device_status')['classification:bitfields'][0]['opensensor:title_i18n'] = {};
  },
  'a setup step the app owns': (doc) => {
    doc.firmware.setup.unshift({ id: 'pair', req: true });
  },
  'a setup step listed twice': (doc) => {
    doc.firmware.setup.push({ id: 'wifi' });
  },
  'a step that shows an undeclared key': (doc) => {
    doc.firmware.settings[2].keys.push('panel.sleep_s');
  },
  'more than 31 setup steps': (doc) => {
    doc.firmware.setup = Array.from({ length: 32 }, (_, i) => ({ id: `step_${i}` }));
  },
  'a secret config key': (doc) => {
    doc.firmware.config_keys['wifi.psk'] = { type: 'text', applies: 'immediately', page: 7, label: 'Password' };
  },
  'a config key under a reserved prefix': (doc) => {
    doc.firmware.config_keys['sensor.model'] = { type: 'text', applies: 'immediately', page: 7, label: 'Model' };
  },
  'a config key with one part': (doc) => {
    doc.firmware.config_keys.theme = doc.firmware.config_keys['panel.theme'];
  },
  'a config key that holds a value': (doc) => {
    doc.firmware.config_keys['panel.theme'].value = 'dark';
  },
  'a config key with a default': (doc) => {
    doc.firmware.config_keys['panel.theme'].default = 'light';
  },
  'a decimal config key': (doc) => {
    doc.firmware.config_keys['panel.refresh_s'].type = 'number';
  },
  'an action that is not a boolean': (doc) => {
    doc.firmware.config_keys['panel.refresh_s'].applies = 'action';
  },
  'an integer key with no range': (doc) => {
    delete doc.firmware.config_keys['panel.refresh_s'].values;
  },
  'an integer key with a fractional bound': (doc) => {
    doc.firmware.config_keys['panel.refresh_s'].values = { min: 0.5, max: 10 };
  },
  'a range that runs downwards': (doc) => {
    doc.firmware.config_keys['panel.refresh_s'].values = { min: 3600, max: 60 };
  },
  'an enum key with no values': (doc) => {
    delete doc.firmware.config_keys['panel.theme'].values;
  },
  'an enum key with a range': (doc) => {
    doc.firmware.config_keys['panel.theme'].values = { min: 0, max: 1 };
  },
  'an enum key that repeats a value': (doc) => {
    doc.firmware.config_keys['panel.theme'].values = ['light', 'light'];
  },
  'a boolean key with values': (doc) => {
    doc.firmware.config_keys['sen6x.co2_asc'].values = [0, 1];
  },
  'a null config key': (doc) => {
    doc.firmware.config_keys['panel.theme'] = null;
  },
  'a null setup step': (doc) => {
    doc.firmware.setup.push(null);
  },
  'a setup step with a label that is not a string': (doc) => {
    doc.firmware.setup[3].label = 7;
  },
  'a settings section with an empty label': (doc) => {
    doc.firmware.settings[3].label = '';
  },
  'a step label translation keyed by an upper case tag': (doc) => {
    doc.firmware.setup[3].label_i18n = { AR: 'x' };
  },
  'a text key longer than 64 bytes': (doc) => {
    doc.firmware.config_keys['panel.label'].values = { min: 0, max: 65 };
  },
  'a config key with no page': (doc) => {
    delete doc.firmware.config_keys['panel.theme'].page;
  },
  'a config key with no label': (doc) => {
    delete doc.firmware.config_keys['panel.theme'].label;
  },
  'an applies outside the vocabulary': (doc) => {
    doc.firmware.config_keys['panel.theme'].applies = 'later';
  },
};
for (const [what, mutate] of Object.entries(brokenTemplates)) {
  const doc = structuredClone(hinted.doc);
  mutate(doc);
  mustFail(hinted.file, `a template with ${what}`, checkTemplate(doc));
}
for (const [file, collection] of collections.values()) {
  const primary = structuredClone(collection);
  primary['opensensor:primary'] = 'pm3_mass_ug_m3';
  mustFail(file, 'a Collection whose primary is not a column', checkCollection(file, primary), 'opensensor:primary');
}
const brokenRegistries = {
  'a scale it does not hold': (properties) => {
    Object.values(properties.properties)[0].scale = 'who-2005-pm25';
  },
  'a label with no English': (properties) => {
    Object.values(properties.properties)[0].label = { ar: 'الوقت' };
  },
  'a group outside the vocabulary': (properties) => {
    Object.values(properties.properties)[0].group = 'weather';
  },
};
for (const [what, mutate] of Object.entries(brokenRegistries)) {
  const doc = structuredClone(registry);
  mutate(doc);
  mustFail('registry/properties.json', `a registry with ${what}`, checkRegistry(doc, scaleRegistry));
}
const brokenBoards = {
  'a template folder it does not list': (doc, uses) => uses.push(['templates/acme-probe/x.json', 'acme-probe']),
  'a footer board it does not list': (doc, uses) => uses.push(['footers/x.json thing.board', 'cores3']),
  'a slug with an upper case letter': (doc) => {
    doc.boards['M5stack-cores3'] = doc.boards['m5stack-cores3'];
  },
  'a slug with an underscore': (doc) => {
    doc.boards.acme_probe = doc.boards['m5stack-cores3'];
  },
  'an entry with no home': (doc) => {
    delete doc.boards['m5stack-cores3'].home;
  },
  'a home that is not https': (doc) => {
    doc.boards['m5stack-cores3'].home = 'http://example.com/templates/m5stack-cores3';
  },
  'a first template of another board': (doc) => {
    doc.boards['m5stack-cores3'].first_template = doc.boards['waveshare-esp32-s3-sim7670g'].first_template;
  },
  'a first template that is not a SHA-256': (doc) => {
    doc.boards['m5stack-cores3'].first_template.sha256 = 'cores3';
  },
  'a first template with no copy in templates/': (doc) => {
    doc.boards['m5stack-cores3'].first_template.sha256 = '0'.repeat(64);
  },
  'a first template on a GitHub branch': (doc) => {
    const entry = doc.boards['m5stack-cores3'].first_template;
    entry.href = entry.href.replace(/\/[0-9a-f]{40}\//, '/main/');
  },
  'a slug with no model': (doc) => {
    doc.boards.acme = doc.boards['m5stack-cores3'];
  },
  'a template folder named after an Object member': (doc, uses) => uses.push(['templates/constructor/x.json', 'constructor']),
};
for (const [what, mutate] of Object.entries(brokenBoards)) {
  const doc = structuredClone(boards);
  const uses = [...slugUses];
  mutate(doc, uses);
  mustFail('registry/boards.json', `a board registry with ${what}`, slugErrors(doc, uses));
}
// A moving Item has no grid:code, so only its geometry shows the resolution.
const [movingFile, movingItem] = itemOf('moving');
const movingPolygons = movingItem.geometry.type === 'Polygon' ? [movingItem.geometry.coordinates] : movingItem.geometry.coordinates;
const movingCells = [...new Set(movingPolygons.flatMap((p) => polygonToCells(p, RESOLUTION, true)))];
for (const [what, cells] of Object.entries({
  'resolution 7 cells': [...new Set(movingCells.map((c) => cellToParent(c, 7)))],
  'resolution 9 cells': movingCells.map((c) => cellToCenterChild(c, 9)),
})) {
  const doc = structuredClone(movingItem);
  doc.geometry = geometryOf(cells);
  doc.bbox = bboxOf(doc.geometry);
  mustFail(movingFile, `validate.mjs with a moving Item built from ${what}`,
    shared.validateDocument(movingFile, doc, regs).errors, `union of resolution ${RESOLUTION}`);
}
const unknownKind = shared.validateDocument('x.json', { type: 'Thing' }, regs);
mustFail('x.json', 'validate.mjs with a document of no known kind', unknownKind.errors);
{
  // A region-size rectangle is rejected before polygonToCells fills its bounds.
  const doc = structuredClone(movingItem);
  doc.geometry = { type: 'Polygon', coordinates: [[[0, 0], [20, 0], [20, 20], [0, 20], [0, 0]]] };
  doc.bbox = [0, 0, 20, 20];
  const started = Date.now();
  const { errors } = shared.validateDocument(movingFile, doc, regs);
  mustFail(movingFile, 'validate.mjs with a region-size rectangle', errors, `union of resolution ${RESOLUTION}`);
  if (Date.now() - started > 2000) report(movingFile, ['a region-size rectangle took more than 2 s to reject']);
}
{
  const doc = structuredClone(catalog);
  doc.links.find((l) => l.rel === 'root').href = './other.json';
  mustFail(catalogFile, 'validate.mjs with a Catalog whose root is not itself', shared.validateDocument(catalogFile, doc, regs).errors,
    'root link is not ./catalog.json');
}
for (const [what, kind, mutate] of [
  ['Collection with table:columns as an object', 'Collection', (doc) => { doc.item_assets.data['table:columns'] = {}; }],
  ['template with links as an object', 'OpenSensorTemplate', (doc) => { doc.links = {}; }],
  ['Item with a null geometry', 'Feature', (doc) => { doc.geometry = null; }],
]) {
  const [file, source] = [...docs, ...[...templates.values()].map((t) => [t.file, read(t.file)])]
    .find(([, doc]) => doc.type === kind);
  const doc = structuredClone(source);
  mutate(doc);
  let errors;
  try {
    ({ errors } = shared.validateDocument(file, doc, regs));
  } catch (e) {
    errors = [];
    report(file, [`validate.mjs threw on a ${what}, ${e.message}`]);
  }
  mustFail(file, `validate.mjs with a ${what}`, errors);
}
{
  // The dictionary link is the text/plain describedby link, wherever it sits.
  const { file } = [...templates.values()][0];
  const doc = read(file);
  doc.links.unshift({ rel: 'describedby', href: 'https://example.com/readme.html', type: 'text/html' });
  report(file, shared.validateDocument(file, doc, regs).errors.map((e) => `with a second describedby link first, ${e}`));
}
{
  // The command line. A wrong or missing digest fails, and a digest in capitals still matches.
  const { file } = [...templates.values()][0];
  const digest = sha256(file);
  const run = (...args) => spawnSync(process.execPath, ['scripts/validate.mjs', ...args], { encoding: 'utf8' });
  const wrong = run('--sha256', '0'.repeat(64), file);
  mustFail(file, 'validate.mjs with a wrong --sha256', wrong.status === 1 ? [wrong.stdout] : [],
    'SHA-256 of the bytes is');
  const bare = run(file, '--sha256');
  mustFail(file, 'validate.mjs with --sha256 and no digest', bare.status === 2 ? [bare.stderr] : [], 'usage');
  const upper = run('--sha256', digest.toUpperCase(), file);
  if (upper.status !== 0) report(file, [`validate.mjs rejected the digest in capitals, ${upper.stdout}${upper.stderr}`]);
  const unchecked = run('--json', catalogFile, 'x-missing.json');
  const results = unchecked.status === 1 ? JSON.parse(unchecked.stdout) : [];
  if (results.length !== 2 || results[0].errors.length > 0) {
    report(catalogFile, [`validate.mjs did not report each file, ${unchecked.stdout}${unchecked.stderr}`]);
  }
}
const noPeriod = structuredClone(scaleRegistry);
delete noPeriod.scales['who-2021-pm10'].period;
mustFail('registry/scales.json', 'a scale registry with a scale that has no period', checkRegistry(registry, noPeriod));

if (failures > 0) {
  process.exit(1);
}
console.log(`Profile OK. ${templates.size} templates, ${collections.size} Collections, ${items.length} Items `
  + `rebuilt from rows, ${footerFiles.length} footers with geo keys, ${rejected} broken cases rejected`);
