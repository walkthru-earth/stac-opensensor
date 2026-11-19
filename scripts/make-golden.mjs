// Writes fixtures/golden/ from the JSON fixtures, one Parquet data file and its expected Item per Thing.
// Each file has the board layout, the opensensor and geo keys, and the column types of its template.
// The files are committed. Run `node scripts/make-golden.mjs` only to change the set, then review the diff.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cellToLatLng } from 'h3-js';
import { ByteWriter, parquetWrite } from 'hyparquet-writer';
import { buildItem } from './canonical.mjs';
import { readDataFile } from './parquet.mjs';

const GOLDEN = 'fixtures/golden';
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const templates = new Map(readdirSync('templates', { recursive: true })
  .filter((n) => n.endsWith('.json'))
  .map((n) => [sha256(readFileSync(join('templates', n))), read(join('templates', n))]));

// Small integers carry the legacy converted type. hyparquet-writer 0.18.0 writes the IntType logical type
// in a form DuckDB 2.0.0 rejects, and readers map the converted type to the same integer.
const INTS = { int8: 'INT_8', int16: 'INT_16', int32: undefined, uint8: 'UINT_8', uint16: 'UINT_16', uint32: 'UINT_32' };
const elementOf = (name, type) => {
  const element = { name, repetition_type: 'OPTIONAL' };
  if (name === 'event_time_utc_us') {
    return { ...element, type: 'INT64', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MICROS' } };
  }
  if (type in INTS) return { ...element, type: 'INT32', ...(INTS[type] ? { converted_type: INTS[type] } : {}) };
  if (type === 'int64') return { ...element, type: 'INT64' };
  if (type === 'uint64') return { ...element, type: 'INT64', converted_type: 'UINT_64' };
  if (type === 'float') return { ...element, type: 'FLOAT' };
  if (type === 'double') return { ...element, type: 'DOUBLE' };
  if (type === 'boolean') return { ...element, type: 'BOOLEAN' };
  if (type === 'geometry') return { ...element, type: 'BYTE_ARRAY', logical_type: { type: 'GEOMETRY' } };
  throw new Error(`no Parquet type for ${name} ${type}`);
};
const valuesOf = (name, type, values) => {
  if (name === 'h3_cell_id') return values.map((v) => (v === null ? null : BigInt(`0x${v}`)));
  if (type === 'int64' || type === 'uint64') return values.map((v) => (v === null ? null : BigInt(v)));
  return values;
};

rmSync(GOLDEN, { recursive: true, force: true });
for (const dir of readdirSync('fixtures').filter((n) => n.startsWith('thing='))) {
  for (const name of readdirSync(join('fixtures', dir)).filter((n) => n.endsWith('.rows.json'))) {
    const fixture = read(join('fixtures', dir, name));
    const footer = read(fixture.footer);
    const template = templates.get(footer.template.sha256);
    if (!template) throw new Error(`${name} names no template in templates/`);
    const types = new Map(template.item_assets.data['table:columns'].map((c) => [c.name, c.type]));
    const names = Object.keys(fixture.rows);
    const cells = fixture.rows.h3_cell_id;
    const columns = [...names, 'geometry'].map((column) => {
      const type = types.get(column);
      if (!type) throw new Error(`${name} column ${column} is not in the template`);
      const values = column === 'geometry'
        ? cells.map((c) => (c === null ? null : { type: 'Point', coordinates: cellToLatLng(c).reverse() }))
        : valuesOf(column, type, fixture.rows[column]);
      return { element: elementOf(column, type), source: { name: column, data: values } };
    });
    // The writer has no LZ4_RAW compressor, so the golden files are UNCOMPRESSED and the footer says so.
    const fileFooter = { ...footer, file: { ...footer.file, compression: 'UNCOMPRESSED' } };
    const writer = new ByteWriter();
    parquetWrite({
      writer,
      columnData: columns.map((c) => c.source),
      schema: [{ name: 'root', num_children: columns.length }, ...columns.map((c) => c.element)],
      codec: 'UNCOMPRESSED',
      rowGroupSize: footer.file.row_group_rows_max,
      kvMetadata: [
        { key: 'opensensor', value: JSON.stringify(fileFooter) },
        { key: 'geo', value: JSON.stringify(read(fixture.footer.replace(/\.json$/, '.geo.json'))) },
      ],
      createdBy: 'stac-opensensor scripts/make-golden.mjs',
    });
    const out = join(GOLDEN, footer.thing.board);
    mkdirSync(out, { recursive: true });
    const parquet = join(out, fixture.file.name);
    writeFileSync(parquet, new Uint8Array(writer.getBuffer()));
    const built = buildItem({ ...(await readDataFile(parquet)), template });
    if (built.none) throw new Error(`${name} gets no Item, ${built.none}`);
    writeFileSync(join(out, `${built.item.id}.json`), `${JSON.stringify(built.item, null, 2)}\n`);
    console.log(`${parquet} and its Item`);
  }
}
