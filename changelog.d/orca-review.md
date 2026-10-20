### Fixed
- Every text colour now meets WCAG AA (4.5:1) on the backgrounds it sits on, in light and dark mode, and a test keeps it that way (`test/contrast.test.ts`). The largest gaps were the third text level in light mode (sidebar headings and counts, 3.4:1 → 5.3:1) and white text on the primary button and error toasts in dark mode (3.2:1 and 2.5:1), which is now dark text. The light accent, ok and warn colours and the dark accent and third text level moved slightly.
- The highlight on a worktree row the palette jumps to no longer animates under reduced motion.

### Security
- Portboard.app sends only `http`, `https` and `mailto` links from the dashboard to other apps; a `file://` path or another app's URL scheme is ignored.
- Portboard.app's Web Inspector is off in release builds unless turned on with `defaults write … PortboardInspectable -bool YES`.
