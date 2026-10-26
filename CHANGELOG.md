# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Parquet footer contract, one `opensensor` key holding versioned JSON in the style of the GeoParquet `geo` key
- Footer JSON Schema, a CoreS3 example and a check that it names a known template and dictionary

### Changed

- A station is now a Thing, the OGC SensorThings term. The footer object `station` is now `thing`
- Things are fixed or moving. New field `opensensor:mobility` and footer member `thing.mobility`
- One Item per uploaded file of at most 1 hour replaces the day Item, under `thing=<uuid>/year=YYYY/month=MM/day=DD/`
- A moving Thing's Item geometry is the union of the H3 cells its rows visited
- Location lives in the rows, as an H3 cell, a `location_source` code and a native Parquet `geometry` cell centre
- The default H3 resolution is 8 for fixed and moving Things
- Board templates live at `templates/<board>/<dict>.json`, and only dated `data_HHMM_` files are published
- PROFILE spells out the location columns in `table:columns`, the footer `board` slug and the 32 hex `boot_id`
- Property URIs are board neutral. The local fallback is `urn:walkthru-earth:property:<quantity>`, and exact CF matches use the NERC standard name URI

## [v0.1.0] - 2026-10-25

### Added

- Column fields for observed property, procedure, Parquet field id, validity gate, warm-up, roll-up method, plausible range,
  scale and derived columns
- Collection and Item fields for health scales and sample interval
- Example air station Collection with its columns in `item_assets`
- Example station day Item located by a coarse H3 cell, with day statistics
- Station profile with its own schema, fixing required extensions, column rules per role and conventions
- Board template schema for what a firmware build knows about its columns, with a CoreS3 example
- Example root Catalog, and a check that a station's columns and checksums match its template

[Unreleased]: <https://github.com/walkthru-earth/stac-opensensor/compare/v0.1.0...HEAD>
[v0.1.0]: <https://github.com/walkthru-earth/stac-opensensor/tree/v0.1.0>
