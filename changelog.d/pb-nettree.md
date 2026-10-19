### Added
- **네트워크 구조** in the sidebar's 기기 section and on the 기기 tab (구조 / 카드): an indented tree of the subnet routers and Proxmox hosts, their guests (VM/CT, 이 서버, LAN 전용, 오프라인) and the LANs they route, each LAN machine with how the tailnet reaches it (tailnet 직접, `<router>` 경유로만, ARP로만 확인), then 직접 연결 (direct or DERP). Groups fold, and the sidebar paints its folds from the cache before anything loads. A row opens the device's detail ([docs/devices-tab](docs/devices-tab/README.md#네트워크-구조)).
- `tree` on `GET /api/devices`, `GET /api/usage` and MCP `list_devices` (`src/core/nettree.ts`); the remote `list_devices` drops subnets and addresses unless `showAddresses`. Devices gain `standbyRoutes` (a subnet another router serves now, from Tailscale `AllowedIPs`).

### Changed
- "<router> 경유" chips say which route they came through ("10.0.0.0/24를 hv1이 라우팅해서 출발지가 hv1로 보여요") and link to the router. A guest that is offline on the tailnet but running on Proxmox says so. A device link on the 기기 tab (the sidebar) opens its detail without a reload.
