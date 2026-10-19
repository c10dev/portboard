# changelog.d: CHANGELOG fragments

Branches don't edit `CHANGELOG.md`. Each branch adds **one fragment** here instead. That way parallel branches don't collide on the same lines (c10dev/portboard#22).

- **Name**: the issue number, e.g. `changelog.d/21.md`. If there is no issue, use the branch name. A follow-up for the same issue is `21-2.md`.
- **Content**: one or more `### <section>` headings, with bullet items under each, written exactly as they should appear in the CHANGELOG. Nothing goes before the first heading.
- **Sections**: `Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Docs`.

```markdown
### Changed
- What changed and why (#21).
```

## Releasing

```bash
npm run changelog:check                               # validates the fragments' format; exits 1 if a fragment is wrong
npm run changelog -- 0.7.0 "M6 구조 개선"               # folds every fragment into a new version section and deletes the fragments
```

`npm test` also parses every fragment here (`test/changelog.test.ts`), so a malformed one fails the tests before the release.

Within each section, fragments are sorted by name. Earlier releases are never touched.
