# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [v0.1.0] - 2026-11-04

The first public release. A pre-release tag named v0.1.0 was cut on 2026-10-25 for the Station draft.
It was replaced by this release before any outside use, so nothing published under that tag needs to keep working.

### Added

- Column fields for observed property, procedure, Parquet field id, validity gate, warm-up, roll-up method, plausible range,
  scale and derived columns
- Collection and Item fields for health scales, sample interval and mobility, `fixed` or `moving`
- Thing profile with its own schema, fixing required extensions, column rules per role and conventions
- Board template schema for what a firmware build knows about its columns
- Parquet footer contract, one `opensensor` key holding versioned JSON in the style of the GeoParquet `geo` key, with its JSON Schema
- Thing Collections declare their Hive partitions with the Portolan Partition extension v1.0.0
- Optional stac-geoparquet item mirror at `thing=<uuid>/items.parquet` with role `collection-mirror`
- Writers section. The board writes the File Item and the Thing Collection, the catalog host writes the root Catalog
- Versioning section. The extension, profile, template and footer share one version
- OGC SensorThings mapping and a DuckDB reading example with `hive_types`
- Examples from the real CoreS3 and Waveshare firmware templates, one fixed and one moving Thing, with a footer per board
- Decision register in `docs/decisions.md`, merging the ecosystem bridge and the owner decisions of 2026-11-04
- `check-profile` rebuilds Item geometry from H3 cells, checks footers against templates and Collections, and rejects broken Items

### Rules

- One Item per uploaded file of at most 1 hour, beside the file under `thing=<uuid>/year=YYYY/month=MM/day=DD/`
- File Item `href` and links are relative. `datetime` is `null`
- Every published Thing uses H3 resolution 8. `anon:size` is `0.01`
- A fixed Item lists Grid and sets `grid:code`. A moving Item leaves Grid out and its geometry is the union of the cells it visited
- No location is null in all four location columns. `location_source` 0 is reserved
- Templates are fetched from any immutable URL and readers check their SHA-256
- Property URIs are board neutral. The local fallback is `urn:walkthru-earth:property:<quantity>`

[Unreleased]: <https://github.com/walkthru-earth/stac-opensensor/compare/v0.1.0...HEAD>
[v0.1.0]: <https://github.com/walkthru-earth/stac-opensensor/tree/v0.1.0>
