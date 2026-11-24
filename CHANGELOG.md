# Changelog

Each data release is a folder `data/<version>/` with `typical-routes.json` and its `README.txt`. Released files are never
changed. A new version is a new folder.

## 2026.11 (2026-11)

- First release. `data/2026.11/typical-routes.json`, `format: 2`, 6,881 directional airport-pair routes of 250 to 2,000 km,
  350,873 bytes, SHA-256 `83d2c851e56645824d4e5a13414e2e85b75c07fff835b7139c113096664ebac8`.
- Built from five ADSB.lol archive days of 2025 (releases `v2025.03.26-planes-readsb-prod-0`,
  `v2025.05.21-planes-readsb-prod-0`, `v2025.07.30-planes-readsb-prod-0`, `v2025.08.27-planes-readsb-staging-0`,
  `v2025.11.26-planes-readsb-staging-0`).
- Routes with an end in Africa, the Middle East, Southeast Asia, Russia/CIS or an unlisted region are left out.
