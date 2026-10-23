### Docs
- CONTRIBUTING.md: the preview example uses port 8800. 8797 is the agent's default port.
- The pull request template lists the four checks that CI runs: `npm test`, `npm run test:en`, `npm run typecheck` and `npm run typecheck:public`.
- docs/architecture.md: MCP prompts and page labels come from the language catalogs (`public/i18n/en.json`, `ko.json`), not fixed Korean text.
