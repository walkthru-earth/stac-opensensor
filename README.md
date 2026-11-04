# OpenSensor Extension Specification

| Item | Value |
| --- | --- |
| Title | OpenSensor |
| Identifier | <https://walkthru-earth.github.io/stac-opensensor/v0.1.0/schema.json> |
| Field Name Prefix | opensensor |
| Scope | Collection, Item |
| [Maturity Classification](https://github.com/radiantearth/stac-spec/tree/master/extensions/README.md#extension-maturity) | Proposal |
| Owner | Walkthru.Earth |

This document explains the OpenSensor Extension to the [SpatioTemporal Asset Catalog](https://github.com/radiantearth/stac-spec) (STAC) specification.

Sensor Things, fixed or moving, write their samples as tables, often Parquet files with one row per sample.
A Thing is the OGC SensorThings term for a device that carries sensors.
A client needs to know what each column measures, when a value is valid and how it rolls up over time before it can show it.
This extension adds those few facts to the column objects of the [Table](https://github.com/stac-extensions/table) extension.
It only defines what STAC core and existing extensions do not already cover, see [What to reuse](#what-to-reuse).

- [Thing profile](PROFILE.md) fixes how a whole catalog of Things uses these fields, with a full worked example
- Examples
  - [Catalog example](examples/catalog.json) is the root of a network of Things
  - [Fixed Thing Collection](examples/thing=3f2b9c1e-6a7d-4e58-9b1c-2d4f6a8e0c13/collection.json)
    is one CoreS3 Thing in one place, with its columns in `item_assets`
  - [Fixed File Item](examples/thing=3f2b9c1e-6a7d-4e58-9b1c-2d4f6a8e0c13/year=2026/month=10/day=24/data_1300_0f3a9c2e5b7d41e8a6c3f0b2d9e4a713_2881-2970-0.json)
    is one uploaded file of that Thing, located by its H3 cell
  - [Moving Thing Collection](examples/thing=7c1e4b9a-3d52-4f86-a0b7-e9d2c5f81a46/collection.json)
    is one Waveshare Thing on a bike
  - [Moving File Item](examples/thing=7c1e4b9a-3d52-4f86-a0b7-e9d2c5f81a46/year=2026/month=10/day=24/data_0815_5e9d0c7b31a84f62b8d47a10c3e6f295_412-501-0.json)
    is located by the union of the H3 cells it visited
  - [Board templates](templates) are what a firmware build knows about its columns, copied byte for byte
  - [Footers](footers) are the `opensensor` Parquet footer of each example file
- [JSON Schema](json-schema/schema.json), plus the [profile](json-schema/profile.json), [template](json-schema/template.json)
  and [footer](json-schema/footer.json) schemas
- [Decision register](docs/decisions.md) lists what was decided and what is still open
- [Overlap review](docs/overlap-review-2026-10-25.md) explains why each field exists or was left out
- [Changelog](./CHANGELOG.md)

## Fields

The fields in the tables below can be used in these parts of STAC documents.

- [ ] Catalogs
- [x] Collections
- [x] Item Properties
- [x] Table columns, inside `table:columns` of Collections, Item Properties, Assets and Item Asset Definitions
- [ ] Links
- [ ] Bands

All fields are optional.

### Column fields

Used inside entries of `table:columns`.

| Field Name                 | Type                              | Description |
| -------------------------- | --------------------------------- | ----------- |
| opensensor:property        | string (URI)                      | Observed property, preferably from a shared vocabulary such as NERC P07 |
| opensensor:procedure       | string                            | Sensor model or procedure id that produced the column |
| opensensor:field_id        | integer                           | Parquet `field_id` of the column, a join key that survives renames |
| opensensor:valid_when      | [Gate Object](#gate-object)       | Condition a row must meet before the value counts |
| opensensor:settle_s        | number                            | Warm-up seconds after power on before values count |
| opensensor:aggregate       | string                            | How values roll up over time, see [opensensor:aggregate](#opensensoraggregate) |
| opensensor:plausible_range | \[number, number]                 | Plausible minimum and maximum, see [opensensor:plausible_range](#opensensorplausible_range) |
| opensensor:scale           | string                            | Id of a scale in `opensensor:scales` |
| opensensor:derived         | [Derived Object](#derived-object) | Marks a column computed from other columns |

### Collection and Item fields

Used at the top of a Collection and in Item Properties.

| Field Name                   | Type                                        | Description |
| ---------------------------- | ------------------------------------------- | ----------- |
| opensensor:scales            | Map\<string, [Scale Object](#scale-object)> | Health or comfort scales, keyed by scale id |
| opensensor:sample_interval_s | number                                      | Seconds between samples |
| opensensor:mobility          | string                                      | `fixed` when the Thing stays in one place, `moving` when it changes place |

### Additional Field Information

#### opensensor:aggregate

Values are the CF `cell_methods` words `mean`, `minimum`, `maximum`, `sum`, `point` and `mode`.
Use `point` for an instantaneous reading and `mode` for coded columns.
This says how to roll values up. CF `cell_methods` says how stored values were made, which is a different question.

#### opensensor:plausible_range

Values outside the range are suspect and a client may flag them or use the range for chart axes.
Unlike CF `valid_range`, values outside it are not treated as missing.
The real range of a file goes in core `statistics` on the Item column.

### Scale Object

| Field Name | Type                           | Description |
| ---------- | ------------------------------ | ----------- |
| source     | string (URI)                   | **REQUIRED**. Citation for the scale, such as a WHO guideline |
| steps      | \[[Step Object](#step-object)] | **REQUIRED**. Steps in rising order |
| unit       | string                         | Unit the step bounds use |
| guideline  | number                         | Value of a guideline line drawn on charts |

### Step Object

| Field Name | Type                           | Description |
| ---------- | ------------------------------ | ----------- |
| upper      | number \| null                 | **REQUIRED**. Upper bound of the step, or `null` for the open top step |
| label      | string \| Map\<string, string> | **REQUIRED**. Label, or a map from language code to label |
| color_hint | string                         | RGB hex colour without `#`, as in the Classification extension |

The label map is part of this extension. The [Language](https://github.com/stac-extensions/language) extension
translates whole documents and has no inline form.

### Gate Object

Either form is allowed.

| Field Name | Type                        | Description |
| ---------- | --------------------------- | ----------- |
| column     | string                      | **REQUIRED**. Column the condition reads |
| equals     | number \| string \| boolean | The value counts when `column` equals this |
| finite     | `true`                      | The value counts when `column` is a finite number |

### Derived Object

| Field Name | Type         | Description |
| ---------- | ------------ | ----------- |
| from       | \[string]    | **REQUIRED**. Input column names |
| method     | string (URI) | **REQUIRED**. URI of the method, for example the paper that defines a correction |

## What to reuse

Use these instead of new fields.

| Need | Use |
| --- | --- |
| Unit | Core `unit` with a UCUM code, such as `ug/m3` or `Cel` |
| Column kind | Core `roles` with ACDD `coverage_content_type` values, such as `physicalMeasurement`, `auxiliaryInformation` or `qualityInformation` |
| Code meanings of a status column | `classification:classes` from [Classification](https://github.com/stac-extensions/classification) v2.0.0 |
| CF name | `cf:standard_name` from [CF](https://github.com/stac-extensions/cf) v1.0.0 |
| Sensor models | Core `instruments` on the Collection |
| Real minimum, maximum and mean | Core `statistics` on the Item column |
| Location cell of a fixed Thing | `grid:code` from [Grid](https://github.com/stac-extensions/grid) v1.1.0, such as `H3-887576970bfffff` |
| Coarse location, fixed or moving | `anon:size` and `anon:warning` from [Anonymized Location](https://github.com/stac-extensions/anonymized-location) v1.0.0 |
| Firmware dictionary and template digests | `file:checksum` on a `describedby` link, from [File](https://github.com/stac-extensions/file) v2.1.0 |
| Size and digest of a data file | `file:size` and `file:checksum` on the asset, from [File](https://github.com/stac-extensions/file) v2.1.0 |
| Hive partitions of a Thing's files | `partition:*` from the incubating [Partition](https://github.com/portolan-sdi/stac-partition-extension) extension v1.0.0 |
| Owner point of contact | `contacts` from [Contacts](https://github.com/stac-extensions/contacts) |
| All Items of a Thing in one file | A [stac-geoparquet](https://radiantearth.github.io/stac-geoparquet-spec/latest/) item mirror |
| Search terms | Core `keywords` |

Device wire details such as live JSON keys and protocol versions, and app choices such as which column shows first, are not part of this extension.
Wire details live in the [board template](PROFILE.md#board-template).

Some reused fields sit in table columns where their own extensions do not list them yet.
Proposals to fix that upstream are
[table#16](https://github.com/stac-extensions/table/issues/16),
[table#17](https://github.com/stac-extensions/table/issues/17),
[classification#55](https://github.com/stac-extensions/classification/issues/55) and
[cf#11](https://github.com/stac-extensions/cf/issues/11).

## Contributing

All contributions are subject to the
[STAC Specification Code of Conduct](https://github.com/radiantearth/stac-spec/blob/master/CODE_OF_CONDUCT.md).
For contributions, please follow the
[STAC specification contributing guide](https://github.com/radiantearth/stac-spec/blob/master/CONTRIBUTING.md).

### Running tests

The same checks that run on pull requests can run locally. You need `npm`, which comes with [node.js](https://nodejs.org/en/download/).

Install everything once from the root of this repository.

```bash
npm install
```

Then run the checks.

```bash
npm test
```

`npm test` checks the Markdown, validates the examples against the local schemas and runs `scripts/check-profile.mjs`.
The profile check also makes sure that broken Items, such as a resolution 7 cell, fail.
After a release, `npm run check-examples-live` validates the examples against the published schemas.
To format the examples, run `npm run format-examples`.

## Releasing

The extension, profile, template and footer schemas share one version, see [Versioning](PROFILE.md#versioning).

1. Make every `$id`, every `stac_extensions` URL and the footer `version` name the new version.
2. Move the changes under `Unreleased` in the [Changelog](CHANGELOG.md) to a dated section for the version.
3. Run `npm test` and push to `main`.
4. Create a GitHub release named after the tag, such as `v0.2.0`, with the changelog section as notes.
5. The `Publish JSON Schema` workflow runs the tests and copies `json-schema/` to `https://walkthru-earth.github.io/stac-opensensor/<tag>/`.
6. Run `npm run check-examples-live` once the pages are served.

A published version is never edited in place. A fix ships as a new version.

## License

[CC BY 4.0](LICENSE), Walkthru.Earth.
