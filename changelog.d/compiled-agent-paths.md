### Fixed
- A single executable of Portboard (Node SEA or `bun build --compile`) now keeps the UI text. The server imports both i18n catalogs statically, so a bundler puts them in the executable. Before, the catalogs were read from `public/i18n/` next to the code, and an executable got empty catalogs without an error.
- In a single executable, the checkout folder and its `portboard.json` are now the folder that holds the executable. Before, they pointed at a path that did not exist. A checkout and the npm package keep the folder above `src/` or `dist/`.
