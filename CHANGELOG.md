# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
