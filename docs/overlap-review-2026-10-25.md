# Overlap review of the first draft

Review date 2026-10-25. Three research passes checked every `opensensor:` field of the first draft for overlap.
The first pass covered STAC core 1.1 and the official extensions.
The second covered CF, ACDD, SOSA/SSN, SWE Common, SensorThings, QUDT and Croissant.
The third covered prior art for in-situ sensors in STAC and asked which fields are public metadata at all.
Every claim below was checked against the current spec text or schema online. Sources are at the end.

## Verdict

The concern is right. Of the 22 fields in the first draft, 3 duplicate existing STAC fields and 8 are not public metadata.
Of those 8, 4 belong to our firmware protocol and 4 to our app UI.
That leaves 11 fields that nobody else defines. They are the real extension.

No STAC extension for fixed sensor stations exists today.
Time Series `ts:` is archived and never shipped per-column fields. Moving Features covers trajectories only.
Planetary Computer's NOAA climate normals table is the closest real catalog, and it only has free-text units and descriptions.
So a small extension is still justified. It just has to be smaller.

## Field by field

| First draft field | Decision | Why |
| --- | --- | --- |
| `ucum` | Replace with core `unit` | STAC 1.1 and CF v1.0.0 both accept UCUM in `unit`. One unit system, no second field |
| `codes` | Replace with `classification:classes` | Same shape as Classification v2.0.0 classes, including `color_hint` and `nodata` |
| `role` | Replace with core `roles` | Values from ACDD `coverage_content_type`, see below |
| `unit_label` | Move to firmware fields | The raw firmware string. The digest already pins it |
| `live_key` | Move to firmware fields | A BLE and LAN LIVE JSON key. Meaningless to a Parquet reader |
| `digest` | Move to firmware fields | Also add `file:checksum` on the dictionary asset |
| `proto_min` | Move to firmware fields | A device protocol gate |
| `primary` | Move to the app profile | Card and chart order |
| `hero` | Move to the app profile | An app plugin id |
| `family` | Move to the app profile | Routes to an app plugin. Add core `keywords` for search |
| `precision` | Move to the app profile as `display_step` | SSN Precision means repeatability, a false friend |
| `property` | Keep | No STAC field for an observed property URI. Use shared URIs, see below |
| `procedure` | Keep | Sensor model or URI. Also fill core `instruments` on the Collection |
| `field_id` | Keep | Also propose it upstream to the Table extension, it fits any Parquet file |
| `valid_when` | Keep | No row gating construct exists. CF `ancillary_variables` is only a link |
| `settle_s` | Keep | No warm-up term exists. SSN `ResponseTime` means something else |
| `aggregate` | Keep | Use CF `cell_methods` words as values |
| `range` | Keep as `plausible_range` | CF `valid_range` masks values outside it. Ours does not, so the name must differ |
| `scale` | Keep | Points at a scale in the Collection |
| `derived` | Keep | `method` becomes a URI. `processing:expression` does not reach columns |
| `scales` | Keep | Render needs raster assets. No machine readable WHO 2021 encoding exists |
| `sample_interval_s` | Keep | Datacube `step` would pull in the whole `cube:dimensions` model |

## Details

### Units

Core `unit` takes a UCUM code, for example `ug/m3`, `Cel`, `%` or `[g]`.
Our v0.1.0 README says the CF extension expects UDUNITS. That is wrong. Its README prefers UCUM or UDUNITS-2.
An optional `unit_uri` pointing at QUDT, such as `http://qudt.org/vocab/unit/MicroGM-PER-M3`, can carry both systems later if needed.

### Roles

Core `roles` is an open list. Taking the values from ACDD `coverage_content_type` reuses a known vocabulary.

| First draft role | ACDD value |
| --- | --- |
| measurement | `physicalMeasurement` |
| health | `auxiliaryInformation` |
| status | `qualityInformation` |
| identity | `referenceInformation` |
| time | `coordinate` |

### Aggregate

Values become `mean`, `minimum`, `maximum`, `sum`, `point` and `mode`, the CF `cell_methods` words.
`last` from the first draft has no CF word. `point` covers an instantaneous status read, and `mode` covers coded columns.

### Property URIs

Use shared URIs where they exist instead of `urn:walkthru-earth:...`.
For PM2.5 the NERC P07 term matches `cf:standard_name` exactly, <http://vocab.nerc.ac.uk/collection/P07/current/YUDG9DXK/>.
The EEA pollutant 6001 and OpenAQ parameter `pm25` can sit next to it as related links.
Columns without a shared term keep a local URI.

### Items

Item geometry stays the H3 cell polygon, with Grid v1.1.0 `grid:code`.
The DGGS extension is a Proposal with no release and describes DGGS datasets, so it is not a fit yet.
Add Anonymized Location v1.0.0 `anon:warning` so clients know the position is coarse.
Days use core `statistics` on their columns for real minimum, maximum and mean.

### Labels

The Language extension translates by whole alternate documents. It has no inline `{en, ar}` maps.
So the inline label map in scale steps is our own construct, and the README must say so.

### Layout

A Collection with no Items and a whole world extent, our profile Collection, has no precedent.
Standard STAC puts `table:columns` in the station Collection's `item_assets` and links a shared document with `describedby`.
The proposal is that each station Collection carries the columns, and the digest keyed profile becomes a plain JSON document.
Phones still cache it forever by digest.

## Outcome

The current v0.1.0 implements the public layer below. Three layers instead of one.

1. **Public extension.**
   Column fields are `property`, `procedure`, `field_id`, `valid_when`, `settle_s`, `aggregate`, `plausible_range`, `scale` and `derived`.
   Collection fields are `scales` and `sample_interval_s`.
   It reuses core `unit`, `roles`, `instruments`, `keywords` and `statistics`, plus `classification:classes`,
   `cf:standard_name`, `grid:code`, `anon:warning` and `file:checksum`.
2. **Firmware facts.** The digest is `file:checksum` on a `describedby` link to the firmware dictionary.
   `proto_min`, `live_key` and `unit_label` stay in the firmware descriptor the phone reads over BLE or LAN.
3. **App profile.** `primary`, `hero`, `family` and `display_step` live in a small app file keyed by digest, outside any schema we publish.

## Still open

1. Prefix of the public extension. It stays `opensensor:` for now. A neutral name such as `obs:` would help other networks adopt it.
2. Upstream proposals, opened 2026-10-25. If they land, the matching field here moves upstream.
   - Table [#16](https://github.com/stac-extensions/table/issues/16) adds `field_id` to the Column Object.
   - Table [#17](https://github.com/stac-extensions/table/issues/17) validates common metadata such as `unit` in columns.
   - Classification [#55](https://github.com/stac-extensions/classification/issues/55) allows `classification:classes` in table columns.
   - CF [#11](https://github.com/stac-extensions/cf/issues/11) allows `cf:standard_name` and `cf:cell_methods` in table columns.
3. Scales, `aggregate`, `valid_when`, `settle_s`, `property`, `procedure` and `derived` stay here.
   Classification [#33](https://github.com/stac-extensions/classification/issues/33) leaned against ranges in classes,
   and CF `cell_methods` describes how values were made, not how to roll them up.

## Sources

- STAC 1.1 common metadata <https://github.com/radiantearth/stac-spec/blob/v1.1.0/commons/common-metadata.md>
- Table <https://github.com/stac-extensions/table>
- Classification <https://github.com/stac-extensions/classification>
- CF <https://github.com/stac-extensions/cf>
- Processing <https://github.com/stac-extensions/processing>
- File <https://github.com/stac-extensions/file>
- Render <https://github.com/stac-extensions/render>
- Language <https://github.com/stac-extensions/language>
- Anonymized Location <https://github.com/stac-extensions/anonymized-location>
- DGGS <https://github.com/stac-extensions/dggs>
- Time Series <https://github.com/stac-extensions/timeseries>
- Moving Features <https://github.com/stac-extensions/moving-features>
- Planetary Computer NOAA climate normals <https://planetarycomputer.microsoft.com/api/stac/v1/collections/noaa-climate-normals-tabular>
- CF 1.12 <https://cfconventions.org/Data/cf-conventions/cf-conventions-1.12/cf-conventions.html>
- ACDD 1.3 <https://wiki.esipfed.org/Attribute_Convention_for_Data_Discovery_1-3>
- SOSA and SSN <https://www.w3.org/TR/vocab-ssn/>
- SWE Common 3.0 <https://docs.ogc.org/is/24-014/24-014.html>
- NERC P07 PM2.5 <http://vocab.nerc.ac.uk/collection/P07/current/YUDG9DXK/>
- EEA pollutant 6001 <https://dd.eionet.europa.eu/vocabularyconcept/aq/pollutant/6001/view>
- OpenAQ parameters <https://docs.openaq.org/resources/parameters>
- QUDT <https://qudt.org/vocab/unit/MicroGM-PER-M3>
