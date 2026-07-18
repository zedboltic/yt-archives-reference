# VT Archives Reference Data

Reference data for [VT Archives](https://vt-archives.pages.dev/), a searchable archive of VTuber livestreams and videos.

This repository contains human-maintained data used when building the search database. Corrections to the alias dictionary and requests to add channels are welcome through pull requests.

## Files

- `channels.yaml`: Source of truth for the channels included in the archive. Each entry is keyed by its YouTube channel ID and contains display metadata such as the name, group, and cohort.
- `noun_*.yaml`: Alias dictionary used to normalize names and related terms for search. Entries are split into one YAML file per `kind`.

## Contributing

Please open a pull request for either of the following:

- Corrections or additions to `noun_*.yaml`, including spelling variants, hiragana, katakana, and commonly used abbreviations.
- New or corrected entries in `channels.yaml`.

For channel additions, use the official YouTube channel ID and provide the display name, `class`, and `cohort` fields. Keep changes focused and avoid unrelated reformatting.

## Alias Dictionary Format

Each `noun_<english-kind>.yaml` has a versioned root object, its fixed `kind`, and an `entries` array.

```yaml
version: 1
kind: タレント
entries:
  - canonicalName: 大空スバル
    aliases:
      - スバル
      - スバちゃん
    relation: null
```

- `kind`: The category for every entry in the file. The file name uses the matching English category, for example `noun_talent.yaml` for `kind: タレント`.
- `canonicalName`: The preferred display form.
- `aliases`: An optional array of alternative spellings. The canonical name is added automatically during database generation.
- `relation`: Optional metadata for LLM-assisted relation handling. It is not used for alias normalization.
