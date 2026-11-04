# Agent map for stac-opensensor

The OpenSensor STAC extension and the Thing profile. This repo is the contract that the board firmware
([opensensor-space-firmware](https://github.com/walkthru-earth/opensensor-space-firmware)), the mobile app
([opensensor-space-mobile](https://github.com/walkthru-earth/opensensor-space-mobile)) and the catalog host share.
It holds JSON Schemas, worked examples and the checks that prove them. There is no runtime code here.
Both consumers pin tag `v0.1.0` at commit `83787768cc8451109d48a03d4ef5493ffcd403dd`.
Read [PROFILE.md](PROFILE.md) for the rules and [docs/decisions.md](docs/decisions.md) for why they hold.

## Layout

| Path | Holds |
| --- | --- |
| [README.md](README.md) | The extension fields, what to reuse instead, tests and release steps |
| [PROFILE.md](PROFILE.md) | The Thing profile, layout, Writers, Canonical form, footer and board template |
| [CHANGELOG.md](CHANGELOG.md) | Keep a Changelog, with an `Unreleased` section on top |
| [json-schema/](json-schema) | `schema.json`, `profile.json`, `template.json` and `footer.json`, published to Pages on release |
| [examples/](examples) | Root Catalog, one fixed and one moving Thing Collection, one File Item each |
| [templates/](templates) | Example copies of the two real board templates, `templates/<board>/<firmware.dict>.json` |
| [footers/](footers) | The `opensensor` Parquet footer and the GeoParquet `geo` key of each example file |
| [fixtures/](fixtures) | Rows of each example file and each Thing's `owner.json`, the input of the rebuild |
| [scripts/canonical.mjs](scripts/canonical.mjs) | Reference builder for the canonical File Item and Thing Collection |
| [scripts/check-profile.mjs](scripts/check-profile.mjs) | Cross document checks and the broken cases that must fail |
| [docs/](docs) | Decision register and the 2026-10-25 overlap review |
| [.github/](.github) | `remark.yaml`, the test workflow on push and PR, the publish workflow on release |

## Frozen release

- v0.1.0 is released and frozen (OD-2026-11-04-A). Never edit a released schema, template, footer, fixture or example in place.
  A change ships as a new version with an entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
- The extension, profile, template and footer share one version. While it is 0.x a minor bump is breaking.
- The version string is hard coded beyond `json-schema/`. A new version also moves the `--schemaMap` URLs in
  [package.json](package.json), `BASE` in [scripts/canonical.mjs](scripts/canonical.mjs), `base` in
  [scripts/check-profile.mjs](scripts/check-profile.mjs), the examples' `stac_extensions` and the footer `version`.
  `grep -rn v0.1.0 --exclude-dir=node_modules .` lists every URL that names it.
- Every `$id` keeps the `walkthru-earth.github.io` host even though it redirects to `walkthru.earth`.
- Release steps are in [README.md](README.md#releasing). Do not tag or publish without the owner.

## Writers (owner decision D)

| Document | Writer |
| --- | --- |
| File Item, the sidecar `<file>.json` | The board, at file close |
| Thing Collection | The board, from its upload ledger and owner config |
| Root Catalog and optional `items.parquet` | The catalog host's publish job |

The phone app and an indexer transport and validate. They MAY rebuild a File Item or a Thing Collection,
and the result MUST equal the board's under the Canonical form. The phone writes an Item only when it is the Thing.
See [PROFILE.md](PROFILE.md#writers).

## Contract facts that are easy to get wrong

- Every published Thing uses H3 resolution 8, fixed or moving (OD-2026-11-04-B). A publisher never coarsens.
  `anon:size` is `0.01`.
- H3 C 4.5.0 is the geometry reference, the version the firmware vendors and h3-js 4.5.0 wraps.
  The mobile app uses `com.uber:h3` 4.5.1 (h3-java) on the JVM.
- Canonical geometry, `bbox` and Collection `extent.spatial` compare within 1e-9 degrees (`TOLERANCE` in `canonical.mjs`).
  Change the builder and the PROFILE Canonical form table together.
- The window start is floor(first row seconds / `rotation_interval_s`) × `rotation_interval_s`.
  File name `HHMM` is the UTC window start, not the first row time. A board that boots at 13:07 writes `data_1300_`.
  The `year=/month=/day=` partition is the window's UTC date. The window is 600, 900, 1800 or 3600 s.
- The File Item data `href` is relative, `./<file>.parquet`. Item links are relative too and `datetime` is `null`.
- A fixed Item lists Grid and sets `grid:code`. A moving Item leaves Grid out and its geometry is the union of its cells.
- Template bytes are minified with no final newline and are never reformatted, so their SHA-256 stays stable.
  `npm run format-examples` touches only STAC documents, never `templates/`.

## Templates and downstream repos

- Templates are canonical in the firmware repo at `docs/shared/templates/<board>/<dict>.json`, pinned to a full
  40 character commit (OD-2026-11-04-C). The [templates/](templates) folder here holds byte for byte example copies,
  not a template host. Never hand edit them. Refresh them from a pinned firmware commit and rebuild the examples.
- The firmware repo vendors `json-schema/`, `PROFILE.md` and `footers/m5stack-cores3.json` under
  `tools/stac_opensensor/` at `83787768`, and its contract tests validate board templates and footers against them.
- The mobile app copies the schemas, example Items, footers and rows into
  `core/stac/src/commonTest/fixtures/stac-opensensor` (mobile PR 256), and its tests compare its Item builder with these examples.
- So any contract change needs matching firmware and mobile PRs that move their pins to the new release.
  Record cross repo decisions in [docs/decisions.md](docs/decisions.md), newest at the top of the first table.

## Validate locally

Use node LTS, as CI does. Install once with `npm ci`, then run the gate.

```bash
npm ci
npm test
```

`npm test` runs these three, each can run alone.

- `npm run check-markdown` lints every Markdown file with [.github/remark.yaml](.github/remark.yaml),
  including links and a 150 character line limit.
- `npm run check-examples` validates the examples with stac-node-validator against the local schemas.
- `npm run check-profile` rebuilds every Item and Collection from `fixtures/`, checks templates, footers, `geo` keys and
  the Catalog, and must end with `Profile OK` and the count of broken cases rejected.

Other scripts.

- `npm run format-examples` rewrites the examples in the validator's format. Run it after editing an example and commit the diff.
- `npm run check-examples-live` validates against the published schemas. It needs network and only proves released versions.

## Before a PR

- `npm test` passes, the same command the `Check Markdown and Examples` workflow runs on every push and PR.
- `npm run format-examples` leaves no diff.
- A broken case is added to `check-profile.mjs` for every new rule, so the rule cannot pass by accident.
- `CHANGELOG.md` has an `Unreleased` entry for any contract change.
- The PR body names the firmware and mobile changes the contract change needs.
- No em dashes in docs, commits, PR text or replies.
