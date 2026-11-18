// Checks that need only one document and the registries. scripts/check-profile.mjs and scripts/validate.mjs
// both import them, so the repository checks and the validator for outside files cannot drift.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { polygonToCells, cellsToMultiPolygon, getResolution, isValidCell } from 'h3-js';
import { RESOLUTION, bboxOf, differences } from './canonical.mjs';

const repo = new URL('../', import.meta.url);
export const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const readRepo = (path) => read(new URL(path, repo));

export const base = 'https://walkthru-earth.github.io/stac-opensensor/v0.1.0/';
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
for (const name of ['schema', 'profile', 'template', 'footer', 'registry']) {
  ajv.addSchema(readRepo(`json-schema/${name}.json`));
}
export const schemas = {
  profile: ajv.getSchema(`${base}profile.json`),
  template: ajv.getSchema(`${base}template.json`),
  footer: ajv.getSchema(`${base}footer.json`),
  registry: ajv.getSchema(`${base}registry.json`),
  boardRegistry: ajv.getSchema(`${base}registry.json#/definitions/boardRegistry`),
};
export const schemaErrors = (validate, doc) => (validate(doc) ? [] : [ajv.errorsText(validate.errors)]);

// The registries of this repository, the ones a template is checked against.
export const loadRegistries = () => ({
  registry: readRepo('registry/properties.json'),
  scaleRegistry: readRepo('registry/scales.json'),
  boards: readRepo('registry/boards.json'),
});

const same = (a, b) => differences(a, b).length === 0;
const close = (a, b) => differences(a, b, '', true).length === 0;
export const columnsOf = (doc) => doc.item_assets?.data?.['table:columns'] ?? [];

// The property and scale registries validate, and every default scale exists.
export const checkRegistry = (properties, scales) => {
  const errors = [...schemaErrors(schemas.registry, properties), ...schemaErrors(schemas.registry, scales)];
  for (const [uri, entry] of Object.entries(properties.properties ?? {})) {
    if (typeof entry.scale === 'string' && !scales.scales?.[entry.scale]) {
      errors.push(`${uri} points at scale ${entry.scale}, which registry/scales.json does not have`);
    }
  }
  return errors;
};

// A scale id names one scale everywhere. A document that reuses a registry id must carry the same scale.
export const scaleErrors = (scales, scaleRegistry) => Object.entries(scales ?? {})
  .filter(([id, scale]) => scaleRegistry.scales[id] && !same(scale, scaleRegistry.scales[id]))
  .map(([id]) => `scale ${id} differs from registry/scales.json`);

// Display hints in the template or the Collection. primary and scale must name what the document holds.
export const hintErrors = (doc, scaleRegistry) => {
  const errors = [];
  const columns = columnsOf(doc);
  const primary = doc['opensensor:primary'];
  if (primary !== undefined && !columns.some((c) => c.name === primary)) {
    errors.push(`opensensor:primary ${primary} is not a column`);
  }
  for (const column of columns) {
    const scale = column['opensensor:scale'];
    if (scale !== undefined && !doc['opensensor:scales']?.[scale]) {
      errors.push(`column ${column.name} points at missing scale ${scale}`);
    }
    if ('classification:bitfields' in column && column.unit !== '{bitmask}') {
      errors.push(`column ${column.name} has classification:bitfields but its unit is not {bitmask}`);
    }
  }
  return [...errors, ...scaleErrors(doc['opensensor:scales'], scaleRegistry)];
};

// Every column property is in the registry, with the same unit.
export const registryErrors = (doc, registry) => {
  const errors = [];
  for (const column of columnsOf(doc)) {
    const entry = registry.properties[column['opensensor:property']];
    if (!entry) {
      errors.push(`column ${column.name} property ${column['opensensor:property']} is not in registry/properties.json`);
    } else if (entry.unit !== column.unit) {
      errors.push(`column ${column.name} unit ${column.unit} differs from the registry unit ${entry.unit}`);
    }
  }
  return errors;
};

// The setup manifest. Every key a step or section lists is declared, ids are unique, a range runs upwards.
// Shapes the schema rejects are skipped here, so their schema errors still reach the report.
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const manifestErrors = (firmware) => {
  const errors = [];
  const keys = isObject(firmware?.config_keys) ? firmware.config_keys : {};
  for (const list of ['setup', 'settings']) {
    const ids = new Set();
    for (const step of Array.isArray(firmware?.[list]) ? firmware[list] : []) {
      if (!isObject(step)) continue;
      if (ids.has(step.id)) errors.push(`firmware.${list} lists ${step.id} twice`);
      ids.add(step.id);
      for (const key of Array.isArray(step.keys) ? step.keys : []) {
        if (!isObject(keys[key])) errors.push(`firmware.${list} ${step.id} shows ${key}, which firmware.config_keys does not declare`);
      }
    }
  }
  for (const [key, spec] of Object.entries(keys)) {
    if (!isObject(spec) || !isObject(spec.values)) continue;
    const { min, max } = spec.values;
    if (min > max) errors.push(`firmware.config_keys ${key} range runs from ${min} down to ${max}`);
  }
  return errors;
};

// A board template on its own. The dictionary link must carry the digest the firmware block names.
export const checkTemplate = (doc, { registry, scaleRegistry }) => {
  const schema = schemaErrors(schemas.template, doc);
  if (schema.length > 0) return schema;
  const errors = [...hintErrors(doc, scaleRegistry), ...registryErrors(doc, registry), ...manifestErrors(doc.firmware)];
  if (doc.links?.some((l) => l === null || typeof l !== 'object' || Array.isArray(l))) {
    errors.push('links holds an entry that is not a link object');
  }
  const dictLink = doc.links?.find((l) => l?.rel === 'describedby' && l.type === 'text/plain');
  if (dictLink?.['file:checksum'] !== `1220${doc.firmware?.dict}`) {
    errors.push('describedby file:checksum does not match firmware.dict');
  }
  return errors;
};

// Columns of a Collection. Ids are unique, and every column a column names exists.
export const columnErrors = (doc) => {
  const errors = [];
  const columns = columnsOf(doc);
  const names = new Set(columns.map((c) => c.name));
  const data = doc.item_assets?.data ?? {};
  for (const key of ['table:primary_datetime', 'table:primary_geometry']) {
    if (key in data && !names.has(data[key])) {
      errors.push(`${key} ${data[key]} is not a column`);
    }
  }
  const ids = new Set();
  for (const column of columns) {
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

// A GeoJSON Polygon or MultiPolygon whose rings are closed-length arrays of numeric positions. The schema checks
// the type but not the nesting, and the cell checks below read every position.
const isPosition = (p) => Array.isArray(p) && p.length >= 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n));
const isPolygon = (rings) => Array.isArray(rings) && rings.length > 0
  && rings.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isPosition));
const wellFormed = (geometry) => (geometry?.type === 'Polygon' && isPolygon(geometry.coordinates))
  || (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0
    && geometry.coordinates.every(isPolygon));

const ringsOf = (geometry) => {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
};

// A union of n resolution 8 cells has a boundary of at least about the square root of 48n vertices, so a polygon
// whose bounds hold far more cells than its vertex count allows is not one. This rejects it before polygonToCells
// fills its bounds. Polygons that pass still face the exact comparison.
const CELL_KM2 = 0.737;
const KM_PER_DEGREE = 111.32;
const tooLargeForItsBoundary = (polygons) => polygons.some((rings) => {
  const ring = rings[0] ?? [];
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  const midLat = ((Math.max(...lats) + Math.min(...lats)) / 2) * (Math.PI / 180);
  const km2 = (Math.max(...lats) - Math.min(...lats)) * KM_PER_DEGREE
    * (Math.max(...lngs) - Math.min(...lngs)) * KM_PER_DEGREE * Math.max(Math.cos(midLat), 0.01);
  const vertices = rings.reduce((sum, r) => sum + r.length, 0);
  return km2 / CELL_KM2 > 16 * vertices * vertices + 10000;
});

// The geometry of a File Item is cellsToMultiPolygon of its distinct resolution 8 cells in ascending order,
// so every writer gets the same JSON. A fixed Item is the one polygon of its grid:code.
export const geometryErrors = (doc) => {
  if (!wellFormed(doc.geometry)) return ['geometry is not a Polygon or MultiPolygon of closed rings of positions'];
  const errors = [];
  const polygons = ringsOf(doc.geometry);
  const cells = tooLargeForItsBoundary(polygons)
    ? []
    : [...new Set(polygons.flatMap((polygon) => polygonToCells(polygon, RESOLUTION, true)))].sort();
  if (cells.length === 0 || !close(cellsToMultiPolygon(cells, true), polygons)) {
    errors.push(`geometry is not a union of resolution ${RESOLUTION} H3 cells`);
  }
  const code = doc.properties?.['grid:code'];
  if (code !== undefined && typeof code !== 'string') {
    errors.push('grid:code is not a string');
  } else if (code !== undefined) {
    const cell = code.replace(/^H3-/, '');
    if (!isValidCell(cell) || getResolution(cell) !== RESOLUTION) {
      errors.push(`grid:code ${code} is not a resolution ${RESOLUTION} H3 cell`);
    } else if (doc.geometry?.type !== 'Polygon' || !close(cellsToMultiPolygon([cell], true), [doc.geometry.coordinates])) {
      errors.push('geometry is not the polygon of grid:code');
    }
  }
  if (!Array.isArray(doc.bbox) || !close(doc.bbox, bboxOf(doc.geometry))) {
    errors.push('bbox is not the bbox of the geometry');
  }
  return errors;
};

// A File Item on its own. Its id is its file name and its data sits beside it.
export const itemErrors = (file, doc) => {
  const schema = schemaErrors(schemas.profile, doc);
  if (schema.length > 0) return schema;
  const errors = geometryErrors(doc);
  const stem = basename(file, '.json');
  if (doc.id !== stem) {
    errors.push(`id ${doc.id} is not the file name ${stem}`);
  }
  if (doc.assets?.data?.href !== `./${doc.id}.parquet`) {
    errors.push(`data href is not ./${doc.id}.parquet`);
  }
  if (new Date(doc.properties?.end_datetime) < new Date(doc.properties?.start_datetime)) {
    errors.push('end_datetime is before start_datetime');
  }
  return errors;
};

// The GeoParquet 2.0.0 geo key of a data file. Its bbox needs the rows, so check-profile.mjs checks that.
export const geoKeyErrors = (geo) => {
  const errors = [];
  if (geo.version !== '2.0.0' || geo.primary_column !== 'geometry') {
    errors.push('version is not 2.0.0 or primary_column is not geometry');
  }
  const column = geo.columns?.geometry ?? {};
  if (column.encoding !== 'WKB' || JSON.stringify(column.geometry_types) !== '["Point"]' || 'crs' in column) {
    errors.push('geometry is not WKB Point with no crs');
  }
  return errors;
};

// The kind of a document, from its type or, for a footer, from its members.
export const kindOf = (doc) => {
  if (doc?.type === 'OpenSensorTemplate') return 'template';
  if (doc?.type === 'OpenSensorPropertyRegistry' || doc?.type === 'OpenSensorScaleRegistry') return 'registry';
  if (doc?.type === 'OpenSensorBoardRegistry') return 'board registry';
  if (doc?.type === 'Collection') return 'collection';
  if (doc?.type === 'Feature') return 'item';
  if (doc?.type === 'Catalog') return 'catalog';
  if (doc && typeof doc === 'object' && 'primary_column' in doc && 'columns' in doc) return 'geo key';
  if (doc && typeof doc === 'object' && 'thing' in doc && 'template' in doc && 'dictionary' in doc) return 'footer';
  return 'unknown';
};

// A Catalog on its own. The profile schema covers Collections and Items only, and stac-node-validator covers STAC
// core, so this checks what the profile adds. Its root is itself and each child is a thing= Collection beside it.
// That each child exists and that every Collection is listed needs the other documents, so check-profile.mjs checks that.
export const catalogErrors = (doc) => {
  if (!Array.isArray(doc.links)) return ['links is not an array'];
  const links = doc.links;
  const errors = [];
  for (const key of ['id', 'description']) {
    if (typeof doc[key] !== 'string' || doc[key] === '') errors.push(`${key} is not a non-empty string`);
  }
  if (!links.some((l) => l?.rel === 'root' && l.href === './catalog.json')) {
    errors.push('root link is not ./catalog.json');
  }
  for (const link of links.filter((l) => l?.rel === 'child')) {
    if (!/^\.\/thing=[0-9a-f-]{36}\/collection\.json$/.test(link.href)) {
      errors.push(`child link ${link.href} is not ./thing=<uuid>/collection.json`);
    }
  }
  return errors;
};

// The schema first, since the other checks of a kind assume its shape.
const afterSchema = (schema, checks) => (schema.length > 0 ? schema : checks());

// Every single document check, picked by kind. Checks that join documents stay in check-profile.mjs.
export const validateDocument = (file, doc, regs) => {
  const kind = kindOf(doc);
  const errors = {
    template: () => checkTemplate(doc, regs),
    registry: () => afterSchema(schemaErrors(schemas.registry, doc), () => (doc.type === 'OpenSensorPropertyRegistry'
      ? checkRegistry(doc, regs.scaleRegistry) : [])),
    'board registry': () => schemaErrors(schemas.boardRegistry, doc),
    collection: () => afterSchema(schemaErrors(schemas.profile, doc), () => [...hintErrors(doc, regs.scaleRegistry),
      ...columnErrors(doc), ...registryErrors(doc, regs.registry)]),
    item: () => itemErrors(file, doc),
    catalog: () => catalogErrors(doc),
    footer: () => schemaErrors(schemas.footer, doc),
    'geo key': () => geoKeyErrors(doc),
    unknown: () => ['not a template, registry, Collection, Item, Catalog, footer or geo key'],
  }[kind]();
  return { kind, errors };
};
