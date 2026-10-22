### Security
- `unexpose_port` and `POST /api/ports/:port/unexpose` turn off only the entry that `expose_port` makes (`https:<port>` → `127.0.0.1:<port>`, not Funnel). Before, they could turn off another entry for the same upstream port, such as the dashboard's own `https:443`. The dashboard shows 공개 해제 only for that entry (`canUnexpose`).
