### Changed
- Adding a feature no longer appends to the end of one list in `src/features/registry.ts`, the file most local merges conflicted on. Each module carries an `order` number (the existing ones 100 … 2900, so `tools/list`, routes, jobs and page scripts keep exactly the order they had), and the imports and the new `MODULES` list are alphabetical, so parallel branches add lines in different places. `FEATURES` is `MODULES` sorted by `order`; tests check the alphabetical order and that order numbers are unique.
- `npm run changelog -- <version> [title]` folds the `changelog.d/` fragments into CHANGELOG.md and `npm run changelog:check` validates them; `npm test` now parses every pending fragment too.

### Docs
- docs/architecture.md "How to add a feature" and CONTRIBUTING.md: the alphabetical registry lines, how to pick an `order`, and that branches add a `changelog.d/` fragment, never CHANGELOG.md.
