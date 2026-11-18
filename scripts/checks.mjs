// Checks that need only one document and the registries. scripts/check-profile.mjs and scripts/validate.mjs
// both import them, so the repository checks and the validator for outside files cannot drift.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { cellsToMultiPolygon, cellToBoundary, getResolution, gridDisk, isValidCell, latLngToCell } from 'h3-js';
import { RESOLUTION, TOLERANCE, bboxOf, differences } from './canonical.mjs';

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
  extension: ajv.getSchema(`${base}schema.json`),
  boardRegistry: ajv.getSchema(`${base}registry.json#/definitions/boardRegistry`),
};
export const schemaErrors = (validate, doc) => (validate(doc) ? [] : [ajv.errorsText(validate.errors)]);

// The registries of this repository, the ones a template is checked against.
export const loadRegistries = () => ({
  registry: readRepo('registry/properties.json'),
  scaleRegistry: readRepo('registry/scales.json'),
  boards: readRepo('registry/boards.json'),
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Only ids a map declares itself count, so constructor or toString never name a scale.
const declares = (map, id) => isObject(map) && typeof id === 'string' && Object.hasOwn(map, id);
const same = (a, b) => differences(a, b).length === 0;
const close = (a, b) => differences(a, b, '', true).length === 0;
export const columnsOf = (doc) => doc.item_assets?.data?.['table:columns'] ?? [];

// The property and scale registries validate, and every default scale exists.
export const checkRegistry = (properties, scales) => {
  const errors = [...schemaErrors(schemas.registry, properties), ...schemaErrors(schemas.registry, scales)];
  for (const [uri, entry] of Object.entries(properties.properties ?? {})) {
    if (typeof entry.scale === 'string' && !declares(scales.scales, entry.scale)) {
      errors.push(`${uri} points at scale ${entry.scale}, which registry/scales.json does not have`);
    }
  }
  return errors;
};

// A scale id names one scale everywhere. A document that reuses a registry id must carry the same scale.
export const scaleErrors = (scales, scaleRegistry) => Object.entries(scales ?? {})
  .filter(([id, scale]) => declares(scaleRegistry.scales, id) && !same(scale, scaleRegistry.scales[id]))
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
    if (scale !== undefined && !declares(doc['opensensor:scales'], scale)) {
      errors.push(`column ${column.name} points at missing scale ${scale}`);
    }
    if ('classification:bitfields' in column && column.unit !== '{bitmask}') {
      errors.push(`column ${column.name} has classification:bitfields but its unit is not {bitmask}`);
    }
  }
  return [...errors, ...scaleErrors(doc['opensensor:scales'], scaleRegistry)];
};

// Every column property is in the registry, with the same unit. A column whose role makes the property optional,
// such as the geometry coordinate, may leave it out. The schema requires it for a physical measurement.
export const registryErrors = (doc, registry) => {
  const errors = [];
  for (const column of columnsOf(doc)) {
    if (!('opensensor:property' in column)) continue;
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

// A GeoJSON Polygon or MultiPolygon whose rings are closed arrays of numeric positions, the last the same as the
// first. The schema checks the type but not the nesting, and the cell checks below read every position.
const isPosition = (p) => Array.isArray(p) && p.length >= 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n));
const isClosed = (ring) => ring[0].every((n, i) => n === ring[ring.length - 1][i]) && ring[0].length === ring[ring.length - 1].length;
const isPolygon = (rings) => Array.isArray(rings) && rings.length > 0
  && rings.every((ring) => Array.isArray(ring) && ring.length >= 4 && ring.every(isPosition) && isClosed(ring));
const wellFormed = (geometry) => (geometry?.type === 'Polygon' && isPolygon(geometry.coordinates))
  || (geometry?.type === 'MultiPolygon' && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0
    && geometry.coordinates.every(isPolygon));

const ringsOf = (geometry) => {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
};

// The cells of a File Item geometry are rebuilt from its boundary, in time linear in its positions and its cells.
// polygonToCells is not used, as its time grows with the bounds of a polygon times its positions. A long thin
// polygon or a ring with many positions could hold it for minutes.
//
// MAX_CELLS is a hard cap that does not grow with the number of positions. One file covers at most one hour, as
// rotation_interval_s is at most 3600. A moving Thing writes the cell of each fix, so a file has at most one cell
// per fix, and a path crosses about one resolution 8 cell per 0.8 km. 10000 cells is more than 3600 fixes at one
// per second, or 8000 km of path. A fixed Thing has one cell. A cell has 6 corners and up to 4 more where it
// crosses an icosahedron edge, which bounds the positions.
export const MAX_CELLS = 10000;
const MAX_POSITIONS = 10 * MAX_CELLS;
const RAD = Math.PI / 180;

// A position is a corner of a resolution 8 cell. The cell that holds it, or one of its neighbours, has it as a
// boundary vertex.
const isCellCorner = ([lng, lat]) => {
  const holder = latLngToCell(lat, lng, RESOLUTION);
  const corner = (cell) => cellToBoundary(cell, true)
    .some(([x, y]) => Math.abs(x - lng) <= TOLERANCE && Math.abs(y - lat) <= TOLERANCE);
  return corner(holder) || gridDisk(holder, 1).some(corner);
};

const wrap = (dLng) => (dLng > 180 ? dLng - 360 : dLng < -180 ? dLng + 360 : dLng);

// Twice the signed area of a ring on the sphere, by the trapezoid rule on longitude and sine of latitude.
// It is negative when the ring runs counterclockwise.
const signedArea = (ring) => ring.slice(1).reduce((sum, b, i) => sum
  + wrap(b[0] - ring[i][0]) * RAD * (Math.sin(ring[i][1] * RAD) + Math.sin(b[1] * RAD)), 0);

// The cells on each side of every boundary edge, found a few metres off the middle of the edge. Inside is on the
// left of a counterclockwise outer ring and on the right of a counterclockwise hole.
const sideCells = (polygons) => {
  const inside = new Set();
  const outside = new Set();
  for (const rings of polygons) {
    rings.forEach((ring, index) => {
      const leftIsInside = (signedArea(ring) < 0) === (index === 0);
      for (let i = 0; i < ring.length - 1; i += 1) {
        const [lng, lat] = ring[i];
        const cos = Math.max(Math.cos(lat * RAD), 1e-6);
        const dx = wrap(ring[i + 1][0] - lng) * cos;
        const dy = ring[i + 1][1] - lat;
        if (dx === 0 && dy === 0) continue;
        const midLng = lng + (dx / cos) / 2;
        const midLat = lat + dy / 2;
        const left = latLngToCell(midLat + dx * 0.02, midLng - (dy * 0.02) / cos, RESOLUTION);
        const right = latLngToCell(midLat - dx * 0.02, midLng + (dy * 0.02) / cos, RESOLUTION);
        inside.add(leftIsInside ? left : right);
        outside.add(leftIsInside ? right : left);
      }
    });
  }
  return { inside, outside };
};

// The cells a union of resolution 8 cells holds. The cells just inside its boundary, and every cell reached from
// them without crossing to a cell just outside. Empty when the positions are not cell corners or there are more
// than MAX_CELLS cells, and the exact comparison then fails.
const cellsOf = (polygons) => {
  const positions = polygons.flat(2);
  if (positions.length > MAX_POSITIONS || !positions.every(isCellCorner)) return [];
  const { inside, outside } = sideCells(polygons);
  const found = new Set(inside);
  const queue = [...inside];
  while (queue.length > 0) {
    if (found.size > MAX_CELLS) return [];
    for (const next of gridDisk(queue.pop(), 1)) {
      if (!found.has(next) && !outside.has(next)) {
        found.add(next);
        queue.push(next);
      }
    }
  }
  return found.size > MAX_CELLS ? [] : [...found].sort();
};

// The geometry of a File Item is cellsToMultiPolygon of its distinct resolution 8 cells in ascending order,
// so every writer gets the same JSON. A fixed Item is the one polygon of its grid:code.
export const geometryErrors = (doc) => {
  if (!wellFormed(doc.geometry)) return ['geometry is not a Polygon or MultiPolygon of closed rings of positions'];
  const polygons = ringsOf(doc.geometry);
  if (polygons.flat(2).length > MAX_POSITIONS) {
    return [`geometry has more than ${MAX_POSITIONS} positions, so it is not a union of at most ${MAX_CELLS} cells`];
  }
  const errors = [];
  const cells = cellsOf(polygons);
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

// Whether datetime a is before datetime b. Date.parse keeps milliseconds, so the digits after them, the
// microseconds and below, break a tie.
const before = (a, b) => {
  const [ma, mb] = [Date.parse(a), Date.parse(b)];
  if (Number.isNaN(ma) || Number.isNaN(mb)) return false;
  if (ma !== mb) return ma < mb;
  const below = (value) => (/T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1] ?? '').slice(3).padEnd(9, '0');
  return below(a) < below(b);
};

// A File Item on its own. Its id is its file name and its data sits beside it.
export const itemErrors = (file, doc) => {
  const schema = [...schemaErrors(schemas.profile, doc), ...schemaErrors(schemas.extension, doc)];
  if (schema.length > 0) return schema;
  const errors = geometryErrors(doc);
  const stem = basename(file, '.json');
  if (doc.id !== stem) {
    errors.push(`id ${doc.id} is not the file name ${stem}`);
  }
  if (doc.assets?.data?.href !== `./${doc.id}.parquet`) {
    errors.push(`data href is not ./${doc.id}.parquet`);
  }
  if (before(doc.properties?.end_datetime, doc.properties?.start_datetime)) {
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
  const childPath = /^\.\/thing=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/collection\.json$/;
  for (const link of links.filter((l) => l?.rel === 'child')) {
    if (typeof link.href !== 'string') {
      errors.push('a child link href is not a string');
    } else if (!childPath.test(link.href)) {
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
    collection: () => afterSchema([...schemaErrors(schemas.profile, doc), ...schemaErrors(schemas.extension, doc)], () => [...hintErrors(doc, regs.scaleRegistry),
      ...columnErrors(doc), ...registryErrors(doc, regs.registry)]),
    item: () => itemErrors(file, doc),
    catalog: () => catalogErrors(doc),
    footer: () => schemaErrors(schemas.footer, doc),
    'geo key': () => geoKeyErrors(doc),
    unknown: () => ['not a template, registry, Collection, Item, Catalog, footer or geo key'],
  }[kind]();
  return { kind, errors };
};
