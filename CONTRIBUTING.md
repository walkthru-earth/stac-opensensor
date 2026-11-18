# Contributing

This repository is the contract between a sensor board, the
[opensensor.space app](https://github.com/walkthru-earth/opensensor-space-mobile) and a catalog.
Describe your board here and the app shows its readings, its setup wizard and its settings with no app change.
All contributions follow the [STAC Specification Code of Conduct](https://github.com/radiantearth/stac-spec/blob/master/CODE_OF_CONDUCT.md).

This guide walks through adding a board. Adding a sensor to a board you already have is the same steps, minus the slug.

| Piece | Where it lives | What it does |
| --- | --- | --- |
| Board slug | [registry/boards.json](registry/boards.json) | Names your board in paths and Parquet footers |
| Board template | Your firmware repo at a pinned commit, copied to `templates/<slug>/` here | Columns, LIVE keys, setup wizard and settings |
| Property entries | [registry/properties.json](registry/properties.json) | Label, unit, rounding and group of each quantity |
| Scale | [registry/scales.json](registry/scales.json) | Optional health or comfort bands with a cited source |

Read [PROFILE.md](PROFILE.md) once first. The sections [Board template](PROFILE.md#board-template),
[Display hints](PROFILE.md#display-hints) and [Conventions](PROFILE.md#conventions) hold every rule this guide points at.

## 1. Claim a board slug

A slug names one board model. It is the folder of its templates, the footer `thing.board` and the catalog mirror path.

1. Pick `<vendor>-<model>`, lower case letters and digits joined by single hyphens, at most 64 characters.
   Add `-<variant>` only when vendor and model alone do not tell two boards apart, as in `elecrow-crowpanel-epaper-42`.
2. Check that [registry/boards.json](registry/boards.json) does not list it. A slug is unique.
3. Add your row in the pull request that brings your first template.

```json
"acme-soilprobe": {
  "vendor": "Acme",
  "model": "SoilProbe",
  "title": "Acme SoilProbe with a capacitive soil moisture sensor",
  "home": "https://github.com/acme/soilprobe-firmware/tree/main/templates/acme-soilprobe",
  "first_template": {
    "sha256": "<64 hex SHA-256 of the template bytes>",
    "href": "https://raw.githubusercontent.com/acme/soilprobe-firmware/<40 hex commit>/templates/acme-soilprobe/<firmware.dict>.json"
  }
}
```

`home` is where your templates are published. `first_template.href` is an immutable link that ends in `/<slug>/<64 hex>.json`,
and its bytes hash to `first_template.sha256`. A `raw.githubusercontent.com` link names a full 40 hex commit, never a branch.
A slug is never renamed and never reused, even after a board is retired.
A new firmware build keeps the slug and ships a new template. A different board gets a new slug.

## 2. Write the board template

The template is plain JSON, not STAC. Your firmware build generates it, and the SHA-256 of its bytes is the template digest.
The device reports that digest, and the app fetches the template and checks its bytes before it trusts a single column.
The schema is [json-schema/template.json](json-schema/template.json). The three files in [templates/](templates) are full examples.

- `id` and `firmware.schema` name your column set, such as `crowpanel-epaper-telemetry-v1`.
- `firmware.dict` is the SHA-256 of your column dictionary. The template file name is that digest.
- `firmware.live_keys` maps each column to its LIVE JSON key, at most 15 characters.
- `firmware.proto_min` is the lowest sync protocol your board speaks.
- `links` holds a `describedby` link to the dictionary with its `file:checksum`.
- `item_assets.data` holds `table:columns`, one object per Parquet column.

Each column carries these fields. The example is the CrowPanel PM2.5 column.

```json
{
  "name": "pm25_mass_ug_m3",
  "type": "float",
  "unit": "ug/m3",
  "roles": ["physicalMeasurement"],
  "opensensor:property": "http://vocab.nerc.ac.uk/collection/P07/current/YUDG9DXK/",
  "opensensor:procedure": "sen63c",
  "opensensor:field_id": 14,
  "opensensor:valid_when": {"column": "sen6x_status", "equals": 4},
  "opensensor:settle_s": 30,
  "opensensor:aggregate": "mean",
  "opensensor:plausible_range": [0, 1000]
}
```

- `unit` is a UCUM code. Keep the firmware label in `firmware.unit_labels` when it differs.
- `opensensor:property` says what is measured, never which board or sensor measured it. That goes in `opensensor:procedure`.
- `opensensor:field_id` counts from 1 in dictionary order. New columns go at the end and an id is never reused.
- A status code column lists its codes in `classification:classes`. A bit mask column lists its bits in `classification:bitfields`.
- Display hints are optional. The column hints `title`, `opensensor:title_i18n`, `opensensor:decimals` and `opensensor:group`
  change how a value is shown, never what it means. A column without them falls back to the property registry.
- `opensensor:primary` sits on the template, not on a column. It names the main metric column.

Template bytes are minified with no final newline. Never reformat a template, or its digest moves.

### Setup wizard and settings

The `firmware` block MAY carry `setup`, `settings` and `config_keys`. The app draws its setup wizard and Device settings from them.
The rules and an example are in [Setup manifest](PROFILE.md#setup-manifest).

- `setup` lists wizard steps in order, 31 at most. `settings` lists Device settings sections.
- A step id from the app catalog, such as `location` or `wifi`, reuses the app's own screen.
  Any other id is a generic form built from its `keys`.
- Each key in `config_keys` has a `type`, `applies`, the `GET_CONFIG` `page` that reads it back and a `label`.
- Key names have two or more dot separated parts, such as `panel.theme`.
  The prefixes `ble.`, `wifi.`, `lan.`, `ntp.`, `location.`, `thing.`, `owner.` and `sensor.` belong to the app and are refused.
- A key holds a name and a type, never a value. Never put a PIN, a Wi-Fi password or a LAN token in a template or an example.

## 3. Add property entries

Every `opensensor:property` your columns use needs an entry in [registry/properties.json](registry/properties.json).
`npm test` fails on a property the registry lacks, or on a column unit that differs from the registry `unit`.

1. Reuse an existing entry when it means the same quantity. Two boards that measure the same thing share one property.
2. Otherwise pick a URI in this order.
   A [NERC P07](https://vocab.nerc.ac.uk/collection/P07/current/) term first.
   Then `http://vocab.nerc.ac.uk/standard_name/<cf name>/` for an exact CF match.
   Else `urn:walkthru-earth:property:<quantity>`, with the quantity in lower case words joined by `_` like the existing entries.
3. Write the entry. `label`, `definition`, `group` and `decimals` are required. `short_label`, `symbol`, `unit`, `scale` and `note` are optional.
   English is required. Add another language only when a speaker has checked the term.

```json
"urn:walkthru-earth:property:soil_volumetric_water_content": {
  "label": {"en": "Soil moisture"},
  "short_label": {"en": "Soil moisture"},
  "definition": {"en": "Volume of water in the soil as a percentage of the soil volume."},
  "group": "climate",
  "unit": "%",
  "decimals": 0,
  "scale": null
}
```

`group` is one of the values in [opensensor:group](README.md#opensensorgroup).
Set `scale` to `null` when no scale applies on purpose, and say why in `note`.

## 4. Add a scale, if you have one

A scale colours a value by health or comfort bands. Add one to [registry/scales.json](registry/scales.json)
only with a published source, such as a WHO guideline.
It needs a `source` URI, the ISO 8601 averaging `period` its bounds apply to and `steps` in rising order.
Each step has an `upper` bound, `null` for the top step, a `label` and a `color_hint`.
Point the property entry `scale` at the new id. See [Scale Object](README.md#scale-object).

## 5. Check it

You need `npm`, which comes with [node.js](https://nodejs.org/en/download/).

1. Copy your template's exact bytes to `templates/<slug>/<firmware.dict>.json`, with no reformatting.
2. Run the checks from the root of this repository.

```bash
npm ci
npm test
```

`npm test` checks the Markdown, validates the examples and runs `scripts/check-profile.mjs`.
That check validates every template, its setup manifest, its display hints and its properties against the registries.
It also fails when a slug in `templates/`, `footers/` or `examples/` is missing from `registry/boards.json`,
and when a registered `first_template.sha256` matches no template copy in `templates/`.
`npm run check-remote` needs network. It fetches your `first_template.href` and fails unless its bytes hash to `first_template.sha256`.
Run `npm run format-examples` if you changed a STAC example. It never touches `templates/`.

## 6. Open the pull request

One pull request per board. It holds the `registry/boards.json` row, the template copy and any new property or scale entries.
Add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
Say in the description where the template is published and which commit pins it.

A maintainer reviews the slug, the property URIs and any translation.
Contributors never tag or publish. The maintainers release, and the app and the firmware pin the new tag,
see [Releasing](README.md#releasing).
