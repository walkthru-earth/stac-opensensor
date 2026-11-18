# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Breaking, ships as v0.2.0 together with regenerated firmware templates.

### Added

- Display hints on columns. Core `title` and `description`, `opensensor:title_i18n` and `opensensor:description_i18n` maps,
  `opensensor:decimals` and `opensensor:group`, in templates and Collections
- `opensensor:primary` names the main metric column of a template or Collection, and a template MAY carry `opensensor:scales`
- Property registry `registry/properties.json`, keyed by `opensensor:property` URI, with labels, definitions, group,
  default decimals and default scale for every property the bundled templates use
- Scale registry `registry/scales.json` with the WHO 2021 PM2.5 and PM10 scales, and `json-schema/registry.json` for both registries
- `classification:bitfields` on `{bitmask}` columns, with the SEN6x device status bits as the worked example
- ELECROW CrowPanel e-paper template `crowpanel-epaper-telemetry-v1` with a SEN63C, and a fixed CrowPanel example Thing
  whose owner config sets display hints
- `check-profile` checks every template column against the registry, registry scales against their copies, and the new hints
- Setup manifest in the template `firmware` block, as in firmware decision 0003. `setup` lists the wizard steps, `settings`
  the Device settings sections and `config_keys` the typed `SET_CONFIG` keys they show. Never a value, never a secret or
  app owned key. `check-profile` checks that every listed key is declared and refuses a broken manifest
- An optional `label` and `label_i18n` on each setup step and settings section, the page or card title.
  A board's own step or section should carry one, and an app catalog id may omit it
- `opensensor:title_i18n` and `opensensor:description_i18n` on `classification:classes` entries and on bit fields and their classes
- Board registry `registry/boards.json` with every board slug, its vendor, model, template home and first template.
  `check-profile` fails on a slug in `templates/`, `footers/` or `examples/` that the registry does not list.
  `npm run check-remote` fetches each first template href and fails unless its bytes hash to the registered SHA-256
- `CONTRIBUTING.md`, a step by step guide to adding a board or a sensor, from the slug to `npm test`
- Property registry entries for air pressure (`hPa`) and nitrogen dioxide (`[ppb]`), with English and Arabic labels
- Arabic for every `short_label` and for the particle count labels. The Arabic waits for a native speaker check
- `check-profile` refuses a registry unit that is not printable ASCII, such as `µg/m³`

### Changed

- WHO scale step labels read as the app shows them, such as "Within the WHO guideline", "Within WHO interim target 4"
  and "Above every WHO target", in English and Arabic
- Display hints are published. The rule that the app profile never goes into published STAC is gone.
  A user's own overrides still stay in the app
- A Collection's columns may differ from its template's only in display hints, and its scales are the template's overlaid by the owner's
- A Scale object requires `period`, the ISO 8601 averaging period its bounds apply to
- The publish workflow also serves `registry/` beside the schemas
- The publish workflow checks that every served schema and registry equals its repo file,
  and a daily workflow repeats the check for every released tag

### Fixed

- The WHO scales mixed averaging periods. Both are now the WHO 2021 24-hour guideline and interim targets the app uses,
  PM2.5 15, 25, 37.5, 50 and 75 ug/m3 and PM10 45, 50, 75, 100 and 150 ug/m3, with the app's step colours

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
- Writers section. The board writes the File Item and the Thing Collection, the catalog host writes the root Catalog,
  the phone and an indexer transport, validate and MAY rebuild
- Canonical form, the exact rules that make a rebuilt Item or Collection equal to the board's, with `scripts/canonical.mjs` as the reference builder
- Versioning section. The extension, profile, template and footer share one version
- OGC SensorThings mapping and a DuckDB reading example with `hive_types`
- Examples from the real CoreS3 and Waveshare firmware templates, one fixed and one moving Thing, with a footer per board
- Decision register in `docs/decisions.md`, merging the ecosystem bridge and the owner decisions of 2026-11-04
- Row fixtures and GeoParquet `geo` key examples for both example files
- `check-profile` rebuilds every Item and Collection from the fixtures, checks the rotation window, the Catalog, the footers and the `geo` keys,
  and rejects broken Items, Collections, footers and `geo` keys

### Rules

- One Item per uploaded file, beside the file under `thing=<uuid>/year=YYYY/month=MM/day=DD/`
- The rotation window is 600, 900, 1800 or 3600 s. File name `HHMM` and the partition date come from the window start
- The footer `version` and template `template_version` accept any 0.1 patch
- File Item `href` and links are relative. `datetime` is `null`
- Every published Thing uses H3 resolution 8. `anon:size` is `0.01`
- A fixed Item lists Grid and sets `grid:code`. A moving Item leaves Grid out and its geometry is the union of the cells it visited
- No location is null in all four location columns. `location_source` 0 is reserved
- Templates are fetched from any immutable URL and readers check their SHA-256
- Property URIs are board neutral. The local fallback is `urn:walkthru-earth:property:<quantity>`

[Unreleased]: <https://github.com/walkthru-earth/stac-opensensor/compare/v0.1.0...HEAD>
[v0.1.0]: <https://github.com/walkthru-earth/stac-opensensor/tree/v0.1.0>
