// Reference builder for the canonical File Item and Thing Collection of PROFILE.md.
// The board, the phone and an indexer must produce documents equal to these under `differences`.
// Inputs are the rows of one file, its footer, its board template, the file facts and the owner config.
import { cellsToMultiPolygon, getResolution, isValidCell } from 'h3-js';

export const RESOLUTION = 8;
export const TOLERANCE = 1e-9;
const BASE = 'https://walkthru-earth.github.io/stac-opensensor/v0.1.0/';
export const EXT = {
  table: 'https://stac-extensions.github.io/table/v1.3.0/schema.json',
  cf: 'https://stac-extensions.github.io/cf/v1.0.0/schema.json',
  classification: 'https://stac-extensions.github.io/classification/v2.0.0/schema.json',
  file: 'https://stac-extensions.github.io/file/v2.1.0/schema.json',
  grid: 'https://stac-extensions.github.io/grid/v1.1.0/schema.json',
  anon: 'https://stac-extensions.github.io/anonymized-location/v1.0.0/schema.json',
  contacts: 'https://stac-extensions.github.io/contacts/v0.1.1/schema.json',
  partition: 'https://schemas.portolan-sdi.org/incubating/partition/v1.0.0/schema.json',
  opensensor: `${BASE}schema.json`,
  profile: `${BASE}profile.json`,
};
export const ANON_SIZE = 0.01;
export const WARNING = {
  fixed: 'The geometry is the H3 cell chosen by the owner, not the device position.',
  moving: 'The geometry is the H3 cells the device visited, not its track.',
};
const NUMERIC = new Set(['int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'float', 'double']);
const INTEGER = new Set(['int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64']);
const MEASUREMENT = new Set(['physicalMeasurement', 'modelResult']);
const pad = (n, width = 2) => String(n).padStart(width, '0');

// Half away from zero to 2 decimals, in IEEE 754 doubles.
export const round2 = (v) => Math.sign(v) * Math.floor(Math.abs(v) * 100 + 0.5) / 100;

// RFC 3339 in UTC with Z. Whole seconds have no fraction, otherwise the microseconds with trailing zeros removed.
export const rfc3339 = (us) => {
  const seconds = Math.floor(us / 1e6);
  const micros = us - seconds * 1e6;
  const text = new Date(seconds * 1000).toISOString().slice(0, 19);
  return micros === 0 ? `${text}Z` : `${text}.${pad(micros, 6).replace(/0+$/, '')}Z`;
};

// The rotation window that holds a time, as the board names the file and its partition.
export const windowOf = (us, rotationSeconds) => {
  const seconds = Math.floor(us / 1e6);
  return new Date((seconds - (seconds % rotationSeconds)) * 1000);
};
export const partitionOf = (thing, window) => `thing=${thing}/year=${window.getUTCFullYear()}`
  + `/month=${pad(window.getUTCMonth() + 1)}/day=${pad(window.getUTCDate())}`;
export const hhmmOf = (window) => `${pad(window.getUTCHours())}${pad(window.getUTCMinutes())}`;

const gatePasses = (gate, rows, i) => {
  const values = rows[gate.column];
  if (values === undefined || values[i] === null || values[i] === undefined) return false;
  const v = values[i];
  if (gate.finite) return Number.isFinite(v);
  if ('equals' in gate) {
    if (typeof v === 'boolean') return v === (gate.equals !== 0);
    return v === gate.equals;
  }
  return false;
};

// Core statistics of every numeric measurement column the file has, in template order.
export const columnStatistics = (template, rows, rowCount) => {
  const out = [];
  for (const column of template.item_assets.data['table:columns']) {
    if (!MEASUREMENT.has(column.roles?.[0]) || !NUMERIC.has(column.type) || !(column.name in rows)) continue;
    const gate = column['opensensor:valid_when'];
    const widen = column.type === 'float' ? Math.fround : (v) => v;
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    rows[column.name].forEach((raw, i) => {
      if (raw === null || raw === undefined) return;
      const v = widen(raw);
      if (!Number.isFinite(v) || (gate && !gatePasses(gate, rows, i))) return;
      count += 1;
      sum += v;
      min = Math.min(min, v);
      max = Math.max(max, v);
    });
    const statistics = count === 0
      ? { valid_percent: 0 }
      : { minimum: min, maximum: max, mean: round2(sum / count), valid_percent: round2((100 * count) / rowCount) };
    out.push({ name: column.name, type: column.type, statistics });
  }
  return out;
};

const closeRing = (ring) => {
  const [first] = ring;
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
};

// Geometry of the distinct cells, sorted ascending as 15 character lowercase hex.
export const geometryOf = (cells) => {
  const polygons = cellsToMultiPolygon([...new Set(cells)].sort(), true).map((p) => p.map(closeRing));
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
};
export const bboxOf = (geometry) => {
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
  const points = rings.flat();
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};

// Builds the File Item, or returns { none: reason } when the profile says the file gets no Item.
// file is { name, size, sha256 }. rows maps a column name to its values, null for a null cell.
// h3_cell_id values are 15 character hex strings, since an int64 cell does not fit a JSON number.
export const buildItem = ({ file, rows, footer, template }) => {
  const match = /^(data_[0-9]{4}_[0-9a-f]{32}_[0-9]+-[0-9]+-[0-9]+)\.parquet$/.exec(file.name);
  if (!match) return { none: 'not a dated data_HHMM_ file' };
  const id = match[1];
  const thing = footer?.thing?.id;
  const mobility = footer?.thing?.mobility;
  if (!thing || !mobility) return { none: 'no Thing id or mobility in the footer' };
  const times = rows.event_time_utc_us ?? [];
  if (times.length === 0) return { none: 'no rows' };
  if (times.some((t) => t === null || t === undefined)) return { none: 'a row has no UTC time' };
  const located = (rows.h3_cell_id ?? []).filter((c) => c !== null && c !== undefined && !/^0+$/.test(c));
  if (located.length === 0) return { none: 'no located row' };
  const cells = [...new Set(located)].sort();
  if (cells.some((c) => !isValidCell(c) || getResolution(c) !== RESOLUTION)) {
    return { none: `a cell is not resolution ${RESOLUTION}` };
  }
  if (mobility === 'fixed' && cells.length > 1) return { none: 'a fixed Thing file holds more than one cell' };

  const start = Math.min(...times);
  const end = Math.max(...times);
  const geometry = geometryOf(cells);
  const properties = {
    datetime: null,
    start_datetime: rfc3339(start),
    end_datetime: rfc3339(end),
    'opensensor:mobility': mobility,
    'opensensor:sample_interval_s': footer.acquisition.sample_interval_ms / 1000,
  };
  if (mobility === 'fixed') properties['grid:code'] = `H3-${cells[0]}`;
  properties['anon:size'] = ANON_SIZE;
  properties['anon:warning'] = WARNING[mobility];

  const data = {
    href: `./${id}.parquet`,
    type: 'application/vnd.apache.parquet',
    roles: ['data'],
    'file:size': file.size,
    'file:checksum': `1220${file.sha256}`,
    'table:row_count': times.length,
  };
  const statistics = columnStatistics(template, rows, times.length);
  if (statistics.length > 0) data['table:columns'] = statistics;

  return {
    item: {
      type: 'Feature',
      stac_version: '1.1.0',
      stac_extensions: [EXT.table, EXT.file, ...(mobility === 'fixed' ? [EXT.grid] : []), EXT.anon, EXT.opensensor,
        EXT.profile],
      id,
      collection: thing,
      geometry,
      bbox: bboxOf(geometry),
      properties,
      links: [
        { rel: 'root', href: '../../../../catalog.json', type: 'application/json' },
        { rel: 'parent', href: '../../../collection.json', type: 'application/json' },
        { rel: 'collection', href: '../../../collection.json', type: 'application/json' },
      ],
      assets: { data },
    },
    path: `${partitionOf(thing, windowOf(start, footer.file.rotation_interval_s))}/${id}.json`,
  };
};

// Builds the Thing Collection from the template, the newest footer, the owner config and the ledger summary.
// ledger is { start, bbox }, the earliest uploaded start_datetime and the union of uploaded Item boxes.
export const buildCollection = ({ template, footer, owner, ledger }) => {
  const columns = template.item_assets.data['table:columns'].map((column) => {
    const extra = owner.columns?.[column.name];
    return extra ? { ...column, ...extra } : column;
  });
  const usesScales = columns.some((c) => 'opensensor:scale' in c);
  const collection = {
    type: 'Collection',
    stac_version: '1.1.0',
    stac_extensions: [EXT.table, EXT.cf, EXT.classification, EXT.file, EXT.partition,
      ...(owner.contacts ? [EXT.contacts] : []), EXT.opensensor, EXT.profile],
    id: footer.thing.id,
    title: owner.title,
    description: owner.description,
    license: 'CC-BY-4.0',
    keywords: template.keywords,
    instruments: template.instruments,
    providers: owner.providers,
    ...(owner.contacts ? { contacts: owner.contacts } : {}),
    extent: {
      spatial: { bbox: [ledger.bbox] },
      temporal: { interval: [[ledger.start, null]] },
    },
    'opensensor:sample_interval_s': template['opensensor:sample_interval_s'],
    'opensensor:mobility': footer.thing.mobility,
    'partition:scheme': 'hive',
    'partition:strategy': 'temporal',
    'partition:keys': ['year', 'month', 'day'].map((name) => ({
      name,
      type: 'int32',
      description: `UTC ${name} of the file window, zero padded on disk`,
    })),
    'partition:glob': `s3://${owner.prefix}/thing=${footer.thing.id}/year=*/month=*/day=*/*.parquet`,
    ...(usesScales ? { 'opensensor:scales': owner.scales } : {}),
    item_assets: { data: { ...template.item_assets.data, 'table:columns': columns } },
    links: [
      { rel: 'root', href: '../catalog.json', type: 'application/json' },
      { rel: 'parent', href: '../catalog.json', type: 'application/json' },
      template.links.find((l) => l.rel === 'describedby' && l.type === 'text/plain'),
      {
        rel: 'describedby',
        href: footer.template.href,
        type: 'application/json',
        title: 'Board template',
        'file:checksum': `1220${footer.template.sha256}`,
      },
      { rel: 'license', href: 'https://creativecommons.org/licenses/by/4.0/', type: 'text/html', title: 'CC BY 4.0' },
    ],
  };
  return collection;
};

// Lists where two documents differ under the canonical rules. Key order does not matter, array order does.
// Numbers compare as IEEE 754 doubles. Geometry coordinates and bbox compare within 1e-9 degrees,
// because H3 libraries differ in the last bits.
export const differences = (a, b, path = '', loose = false) => {
  const here = path || '(root)';
  const near = loose || /^\.(geometry|bbox)|\.extent\.spatial/.test(path);
  if (typeof a === 'number' && typeof b === 'number') {
    const same = near ? Math.abs(a - b) <= TOLERANCE : a === b;
    return same ? [] : [`${here} ${a} != ${b}`];
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return [`${here} is an array on one side only`];
    if (a.length !== b.length) return [`${here} has ${a.length} entries, not ${b.length}`];
    return a.flatMap((v, i) => differences(v, b[i], `${path}[${i}]`, near));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => {
      if (!(k in a) || !(k in b)) return [`${path}.${k} is on one side only`];
      return differences(a[k], b[k], `${path}.${k}`, near);
    });
  }
  return a === b ? [] : [`${here} ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
};
