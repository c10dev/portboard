### Added
- **English UI** ([docs/i18n](docs/i18n/README.md)). Every page, the 설정 modal, toasts, the palette and shortcut dialog, the inspector, the network tree, the memory view and the text the server writes (the setup checklist, access reasons, alert, digest, new-port and memory pushes, suggestions, MCP prompts and messages, the remote consent page) come from `public/i18n/en.json` and `ko.json`, read by `public/lib/i18n.js` in the pages and `src/core/i18n.ts` on the server. No dependency, no build step; plurals by `Intl.PluralRules`.
- **설정 › 화면 › 언어** (자동 · 한국어 · English), per device, applied before the first paint by `lib/shell-boot.js`. 자동 follows the server's locale when it is set, else the browser's language. The API text a page reads follows the page (the `pb_locale` cookie).
- **`locale`** in `portboard.json` and `PORTBOARD_LOCALE`: the language of the text the server sends on its own and of the shell it renders. The generic default is `en`; this install's checked-in `portboard.json` sets `ko`, so production is unchanged.
- **The Mac app follows the system language** (`mac-app/Resources/{en,ko}.lproj/Localizable.strings`, `PortboardCore/L10n.swift`).
- Tests: both catalogs complete and in step, no unused or missing key, no key built from parts, and no Korean outside the ko catalog and comments in `public/` and `src/` (`test/i18n.test.ts`, `test/i18n-hangul.test.ts`). `npm test` runs in Korean so the existing assertions keep checking production's text.

### Docs
- README: the UI languages; the public screenshots regenerated in English from example data. `docs/i18n/` has both languages side by side.

### Fixed
- Dates and times follow the page's language instead of the browser's, so an English page on a Korean browser doesn't mix in 오전/오후 (and the reverse).
- 기기 › Windows/Proxmox port readers: "마지막 성공 5분 전 전" said 전 twice; 기기 › 아무도 안 쓰는 서비스 no longer says "방금 동안 사용 기록 없음" right after the history starts.
