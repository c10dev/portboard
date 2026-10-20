### Security
- Mac app: the release build now fails if Portboard.app gains an entitlement, an `NSAppTransportSecurity` exception, or loses the hardened runtime, Developer ID signature or timestamp (`mac-app/scripts/check-bundle.sh`, also run by `build.sh`).

### Fixed
- Mac app: a plain `http://` server address with a host name (blocked by App Transport Security) now says so and suggests the `https://…ts.net` address or the Tailscale IP, instead of "Couldn't connect (error -1022)".
