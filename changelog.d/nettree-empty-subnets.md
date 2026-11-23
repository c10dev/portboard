### Fixed
- Network tree: a subnet router that also advertises a /32 of its own LAN address or one of its guests' no longer gets an empty "LAN x.x.x.x/32" row for each; the host or guest row already shows that address. An empty /24, and a /32 that another router advertises, are still drawn.
- Korean router labels no longer put a particle after the router name, which was wrong for names such as "pve1" ("pve1가 라우팅" → "pve1 경유").
