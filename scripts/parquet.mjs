// Reads one board data file into the { file, rows, footer } that scripts/canonical.mjs buildItem takes.
// rows maps each column name to its values in row order, null for a null cell.
// int64 values become doubles, h3_cell_id becomes 15 character lowercase hex and event_time_utc_us
// stays integer microseconds. Geometry columns are left out, since the Item takes its geometry from the cells.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

export const FOOTER_KEY = 'opensensor';
const SPATIAL = new Set(['GEOMETRY', 'GEOGRAPHY']);

const cellHex = (v) => (v === null || v === undefined ? null : BigInt.asUintN(64, BigInt(v)).toString(16).padStart(15, '0'));
const plain = (v) => (typeof v === 'bigint' ? Number(v) : v ?? null);
const micros = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'bigint' && !Number.isInteger(v)) {
    throw new Error('event_time_utc_us is not an int64 microsecond column');
  }
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`event_time_utc_us ${v} does not fit a double`);
  return n;
};

export const readDataFile = async (path) => {
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const metadata = parquetMetadata(buffer);
  const entry = metadata.key_value_metadata?.find((e) => e.key === FOOTER_KEY);
  let footer = null;
  if (entry?.value !== undefined) {
    try {
      footer = JSON.parse(entry.value);
    } catch (error) {
      throw new Error(`the ${FOOTER_KEY} key is not JSON, ${error.message}`);
    }
  }
  const columns = metadata.schema.slice(1)
    .filter((s) => !s.num_children && !SPATIAL.has(s.logical_type?.type))
    .map((s) => s.name);
  const records = await parquetReadObjects({
    file: buffer,
    metadata,
    columns,
    compressors,
    parsers: { timestampFromMicroseconds: (us) => us },
  });
  const rows = {};
  for (const name of columns) {
    const convert = name === 'h3_cell_id' ? cellHex : name === 'event_time_utc_us' ? micros : plain;
    rows[name] = records.map((r) => convert(r[name]));
  }
  return {
    file: { name: basename(path), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    rows,
    footer,
  };
};
