### Changed
- The setup checklist's Mac agent step links to [docs/integrations/compute-pool.md](../docs/integrations/compute-pool.md) instead of compute-pool's own install guide, which is not public. Its command hint is unchanged.

### Docs
- `docs/integrations/compute-pool.md`: compute-pool is an optional integration. The page describes the `GET /api/hosts` JSON Portboard reads, so any program can serve a compatible endpoint, the older `/api/state` fallback, how a pool host is matched to a device card, and the alert channel file. The README and the dashboard docs link there.
- Test and menu bar fixtures: a made-up Windows 11 dev box (stock services, WSL, a few dev tools) and example tailnet addresses.
