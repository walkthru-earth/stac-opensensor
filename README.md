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

Low-cost sensor stations write their samples as Parquet files. A station app needs to know what each column means before it can show it.
Which column is the main reading, what unit it uses, when a value is valid, how it rolls up over an hour and which health scale colours it.
This extension carries that meaning in STAC, so one app can show air, weather, soil, water or noise stations without code that knows each sensor.

It builds on the [Table](https://github.com/stac-extensions/table) extension.
Each Parquet column is a `table:columns` entry, and this extension adds fields to those entries.
It works next to [CF](https://github.com/stac-extensions/cf) for `cf:standard_name`,
[Grid](https://github.com/stac-extensions/grid) for H3 cells and the STAC common `unit` field.
Field names follow the OGC SensorThings words, so a station is a Thing, a column is a Datastream and a quantity is an ObservedProperty.

- Examples
  - [Collection example](examples/collection.json) is a device profile for a CoreS3 air station
  - [Item example](examples/item.json) is one reconciled day of a station, located by an H3 cell
- [JSON Schema](json-schema/schema.json)
- [Changelog](./CHANGELOG.md)

## Profiles and stations

A device profile is a Collection with no Items.
It describes the columns of one firmware dictionary and is named by the SHA-256 digest of that dictionary.
Profiles never change, so a phone can cache them forever and a station only needs to send the digest.

A station day is an Item. Its geometry is the H3 cell polygon the owner chose to share, never the exact position.
It points to its profile with a `describedby` link and repeats `opensensor:digest`.

## Fields

The fields in the tables below can be used in these parts of STAC documents.

- [ ] Catalogs
- [x] Collections
- [x] Item Properties
- [x] Table columns, inside `table:columns` of Collections, Item Properties, Assets and Item Asset Definitions
- [ ] Links
- [ ] Bands

All fields are optional. A profile with only `table:columns` and `unit` still renders as plain numbers with raw names.

### Profile fields

Used at the top of a Collection and in Item Properties.

| Field Name                    | Type                                  | Description |
| ----------------------------- | ------------------------------------- | ----------- |
| opensensor:digest             | string                                | Lowercase hex SHA-256 of the firmware column dictionary this profile describes |
| opensensor:family             | string                                | Family id such as `air`, `weather`, `soil`, `water` or `noise` |
| opensensor:primary            | \[string]                             | Ordered column names an app shows first |
| opensensor:scales             | Map\<string, [Scale Object](#scale-object)> | Health or comfort scales, keyed by scale id |
| opensensor:hero               | string                                | Id of an optional hero card that an app plugin for the family can render |
| opensensor:sample_interval_s  | number                                | Seconds between samples |
| opensensor:proto_min          | integer                               | Lowest device protocol version that serves this profile |

### Column fields

Used inside entries of `table:columns`.

| Field Name              | Type                                  | Description |
| ----------------------- | ------------------------------------- | ----------- |
| opensensor:property     | string (URI)                          | Observed property URI |
| opensensor:procedure    | string                                | Sensor or firmware procedure id that produced the column |
| opensensor:ucum         | string                                | [UCUM](https://ucum.org/) code, next to the UDUNITS-2 string in `unit` |
| opensensor:unit_label   | string                                | Unit label exactly as the firmware writes it |
| opensensor:field_id     | integer                               | Parquet `field_id` of the column |
| opensensor:codes        | \[[Code Object](#code-object)]        | Meaning of each code in a status column |
| opensensor:live_key     | string                                | Key of this column in the live JSON sample, matching `^[a-z0-9_]{1,15}$` |
| opensensor:role         | string                                | One of `measurement`, `health`, `identity`, `time` or `status` |
| opensensor:valid_when   | [Gate Object](#gate-object)           | Condition a row must meet before the value counts |
| opensensor:settle_s     | number                                | Warm-up seconds after power on before values count |
| opensensor:aggregate    | string                                | How values roll up over time, one of `mean`, `min`, `max`, `last`, `sum` or `count` |
| opensensor:range        | \[number, number]                     | Plausible minimum and maximum, used for quality checks and chart axes |
| opensensor:precision    | number                                | Display step, for example `1` or `0.1` |
| opensensor:scale        | string                                | Id of a scale in `opensensor:scales` of the profile |
| opensensor:derived      | [Derived Object](#derived-object)     | Marks a column the app computes from other columns |

Labels use the STAC common fields `title` and `description`,
with the [Language](https://github.com/stac-extensions/language) extension for translations.

### Additional Field Information

#### Units

STAC allows UCUM or UDUNITS-2 in `unit`, and the CF extension expects UDUNITS.
A column puts the UDUNITS-2 string in `unit`, the UCUM code in `opensensor:ucum` and the firmware label in `opensensor:unit_label`.
For example PM2.5 has `unit` set to `ug m-3`, `opensensor:ucum` set to `ug/m3` and `opensensor:unit_label` set to `ug/m3`.
In UCUM `g` is gram and `[g]` is standard gravity, so accelerometer columns use `[g]`.

#### opensensor:role

| Value       | Meaning |
| ----------- | ------- |
| measurement | Environmental reading the station exists to make |
| health      | Board health such as battery, signal or board temperature |
| identity    | Station or session identifiers |
| time        | Timestamps and clock bookkeeping |
| status      | Coded state of a sensor, described by `opensensor:codes` |

### Scale Object

| Field Name | Type                                  | Description |
| ---------- | ------------------------------------- | ----------- |
| source     | string (URI)                          | **REQUIRED**. Citation for the scale, such as a WHO guideline |
| steps      | \[[Step Object](#step-object)]        | **REQUIRED**. Steps in rising order |
| unit       | string                                | Unit the step bounds use |
| guideline  | number                                | Value of a guideline line drawn on charts |

### Step Object

| Field Name | Type                          | Description |
| ---------- | ----------------------------- | ----------- |
| upper      | number \| null                | **REQUIRED**. Upper bound of the step, or `null` for the open top step |
| label      | string \| Map\<string, string> | **REQUIRED**. Label, or a map from language code to label |
| color_hint | string                        | RGB hex colour without `#`, such as `2E7D32` |

### Code Object

Same shape as a class in the [Classification](https://github.com/stac-extensions/classification) extension.
Classification documents assets, bands and properties, not table columns, so this extension carries the class list itself.

| Field Name  | Type    | Description |
| ----------- | ------- | ----------- |
| value       | integer | **REQUIRED**. Code stored in the column |
| name        | string  | **REQUIRED**. Short name, matching `^[0-9A-Za-z-_]+$` |
| title       | string  | Human readable title |
| description | string  | Longer description |
| color_hint  | string  | RGB hex colour without `#` |
| nodata      | boolean | `true` when the code means no data |

### Gate Object

Either form is allowed.

| Field Name | Type                       | Description |
| ---------- | -------------------------- | ----------- |
| column     | string                     | **REQUIRED**. Column the condition reads |
| equals     | number \| string \| boolean | The value counts when `column` equals this |
| finite     | `true`                     | The value counts when `column` is a finite number |

### Derived Object

| Field Name | Type      | Description |
| ---------- | --------- | ----------- |
| from       | \[string] | **REQUIRED**. Input column names |
| method     | string    | **REQUIRED**. Method id an app knows, for example `epa-2021-pm25` |

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

To format the examples, run `npm run format-examples`.

## License

[CC BY 4.0](LICENSE), Walkthru.Earth.
