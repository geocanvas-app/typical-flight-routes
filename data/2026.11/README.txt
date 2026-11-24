GeoCanvas.Fly typical routes 2026.11

Attribution: Contains information from ADSB.lol, which is made available under the Open Database License (ODbL 1.0).
Licence: Open Database License (ODbL 1.0), https://opendatacommons.org/licenses/odbl/1-0/
Source: ADSB.lol historical data, https://www.adsb.lol/docs/open-data/historical
Source releases (globe_history_2025): v2025.03.26-planes-readsb-prod-0, v2025.05.21-planes-readsb-prod-0, v2025.07.30-planes-readsb-prod-0, v2025.08.27-planes-readsb-staging-0, v2025.11.26-planes-readsb-staging-0

typical-routes.json: format 2, 6881 routes, 350873 bytes, SHA-256 83d2c851e56645824d4e5a13414e2e85b75c07fff835b7139c113096664ebac8
Built from the world confirmation library index.json (SHA-256 2e3d2e7bea14dbbc05ba2090cec0e732b265d9a4200f582ad25dad684307f72c, 6978 routes).

Method: each route is one directional ICAO pair, `ORIGIN-DESTINATION`, holding the real flight nearest the others on that pair (a medoid, not an average)
simplified to at most 24 points and rounded to hundredths of a degree. A route is written as one URL-safe text: the integers of `encodeRoute`
(the first point, then the deltas, longitude wrapped) are zigzagged and written as base-32 digits, least significant first, in the alphabet
`A-Za-z0-9-_` with bit 5 of a digit as the continuation bit (`encodeRouteText`). Every route here decodes to exactly the same points as the gate file.
Routes with an end in Africa, the Middle East, Southeast Asia, Russia/CIS or an unlisted region (by ICAO prefix, the confirmation protocol's order) are left out,
because the confirmation could not judge them. The file holds no flight, aircraft or operator identity.
