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

- OD-2026-11-04-A freezes the published v0.1.0 schema files. This repo extends the freeze to templates, footers,
  fixtures and examples, because the firmware and the app copy them byte for byte. Never edit any of them in place.
  A change ships as a new version with an entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
- The extension, profile, template and footer share one version. While it is 0.x a minor bump is breaking.
- A version bump moves all of these together.
  - URLs. Every `$id` and `const` in `json-schema/`, the `--schemaMap` URLs in [package.json](package.json),
    `BASE` in [scripts/canonical.mjs](scripts/canonical.mjs), `base` in [scripts/check-profile.mjs](scripts/check-profile.mjs),
    the examples' `stac_extensions`, the Identifier row of [README.md](README.md) and the schema rows of [PROFILE.md](PROFILE.md).
  - Bare strings. `version` in `package.json`, the PROFILE Version row and "now 0.1.0" under Versioning, the footer
    `version` in `footers/` and `template_version` in `templates/`. The firmware generator sets `template_version`,
    so a minor bump needs new firmware templates first.
  - Patterns. `^0\\.1\\.[0-9]+$` in `json-schema/template.json` and `json-schema/footer.json`, and the PROFILE text
    "`0.1.` then the patch".
  - Test cases. In `check-profile.mjs` the broken footer `version 0.2.0` and the accepted patch `0.1.7`.
    After a minor bump to 0.2 the broken case would pass, so move both.
  - Search with `grep -rnF 0.1. --exclude-dir=node_modules --exclude=package-lock.json .` for URLs and bare strings,
    and `grep -rnF '^0' json-schema` for the patterns.
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
  The mobile app uses `com.uber:h3` 4.5.1 (h3-java) on the JVM and Android, and a vendored H3 C 4.5.0 on iOS.
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
  not a template host. Never hand edit them. A refresh from a newer firmware commit, and the rebuild of the examples
  it causes, is a contract change that ships as a new version.
- The copies here are named by `<firmware.dict>`, as in the firmware. A catalog mirror in PROFILE is named by the
  template SHA-256 instead. `check-profile` enforces the dict name, so never rename these files.
- The firmware repo vendors the four schemas in `tools/stac_opensensor/v0.1.0/`, and `PROFILE.md` and
  `footers/m5stack-cores3.json` in `tools/stac_opensensor/`, all at `83787768`. Its contract tests validate board
  templates and footers against them. A version bump there renames the folder and moves the paths that name it,
  in `tools/board_template.py`, `tools/footer_contract.py`, `tools/plugin_contract.py` and the `$ref` URLs in
  `docs/shared/plugins/README.md`.
- The mobile app copies the schemas, example Items, footers and rows into
  `core/stac/src/commonTest/fixtures/stac-opensensor`, and its tests compare its Item builder with these examples.
- So any contract change needs matching firmware and mobile PRs that move their pins to the new release.
  Record cross repo decisions in [docs/decisions.md](docs/decisions.md), newest at the top of the Owner decisions table.

## Validate locally

Use node LTS, as CI does. Install once with `npm ci`, then run the gate.

```bash
npm ci
npm test
```

`npm test` runs these three, each can run alone.

- `npm run check-markdown` lints every Markdown file with [.github/remark.yaml](.github/remark.yaml),
  including links and a 150 character line limit.
- `npm run check-examples` validates the examples with stac-node-validator against the local OpenSensor schemas.
  It fetches the third party extension schemas, such as Table, CF and Grid, so it needs network.
- `npm run check-profile` runs fully offline. It rebuilds every Item and Collection from `fixtures/`, checks templates,
  footers, `geo` keys and the Catalog, and must end with `Profile OK` and the count of broken cases rejected.

Other scripts.

- `npm run format-examples` rewrites the examples in the validator's format. Run it after editing an example and commit the diff.
- `npm run check-examples-live` validates against the published schemas and only proves released versions.

## Before a PR

- `npm test` passes, the same command the `Check Markdown and Examples` workflow runs on every push and PR.
- `npm run format-examples` leaves no diff.
- A broken case is added to `check-profile.mjs` for every new rule, so the rule cannot pass by accident.
- `CHANGELOG.md` has an `Unreleased` entry for any contract change.
- The PR body names the firmware and mobile changes the contract change needs.
- No em dashes in docs, commits, PR text or replies.
