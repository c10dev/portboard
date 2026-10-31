# Design system

The dashboard's design system is kept in this repository and built into the files of a claude.ai Design System
artifact. The repository is the source. The artifact is a read-only view of it for people and agents that design
new screens.

| What | Source |
|---|---|
| Colour tokens (light and dark) | the custom properties of `:root` and `:root[data-theme="dark"]` in `public/style.css` and `public/settings.css` |
| Type scale and font families | `--fs-1` … `--fs-5`, `--mono` and the `body` font in `public/style.css`; figure styles from the `.port`, `.hp-port` and `.ac-code code` rules |
| Layout sizes | the `:root` custom properties in `public/shell.css` |
| Radius and shadow names | `design-system/tokens.notes.json` (the CSS writes these values directly) |
| Usage note of every token | `design-system/tokens.notes.json` |
| Brand book | `design-system/README.md` |
| Components | `design-system/components/<Name>/README.md` (guidelines) and `preview.html` (a static rendition of the real markup) |
| Cover | `design-system/components/Cover/preview.html` |
| Logo | `public/icon.svg` |

## Build

```bash
npm run design-system -- --out /tmp/portboard-ds
```

The script writes `/tmp/portboard-ds/project/`: `design-system.json` (the index), `tokens.json`, `tokens.css`,
`README.md`, `assets/Logos/README.md`, `components/…` and `components/bundle.css`. `bundle.css` is the dashboard's stylesheets without the token
declarations, so the previews are styled by the real CSS and every value has one source. Nothing is published.

| Option | |
|---|---|
| `--out DIR` | where to write; the folder must not exist or must be empty |
| `--logo-blob ID` | the artifact's upload id of `public/icon.svg`; adds the Logos asset group to the index |
| `--logo-size BYTES` | the size the upload reports; the artifact store may rewrite an SVG (default: the file's size) |
| `--by NAME` | who made the change (default: `git config user.name`) |
| `--at ISO-8601` | when (default: now) |

The index says `"editing": "code"`, so the artifact page is read-only and points people back to the code.

## Change it

1. Change the CSS, `design-system/README.md`, a component or a token note.
2. A new colour custom property in `style.css` or `settings.css` needs a note in `tokens.notes.json`. The build fails
   without one, and it fails for a note whose token is gone.
3. Run `npm test`. `test/design-system.test.ts` checks that every colour token reaches `tokens.json` with the same
   value in both themes, that every value is in a form the artifact reads, that `bundle.css` keeps every other rule,
   and that each component has guidelines and a preview that loads nothing from outside.
4. Build, then publish the folder to the artifact. In Claude Code, ask Claude to publish
   `<out>/project` to the design-system artifact: it uploads `public/icon.svg` first, rebuilds with `--logo-blob`,
   then sends the files. Each publish replaces the files it sends.

A component preview is markup only. The artifact's preview frame loads `tokens.css` and `bundle.css` before it, the
same way the dashboard pages load `style.css` and `shell.css`.
