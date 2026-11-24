# Notice for the data in this folder

Contains information from ADSB.lol, which is made available under the Open Database License (ODbL 1.0).

- Source database: ADSB.lol historical data, https://www.adsb.lol/docs/open-data/historical (GitHub releases of
  `adsblol/globe_history_2025`). The exact releases are listed in each version's `README.txt` and in the top-level README.
- Licence of everything in this folder: Open Database License (ODbL) 1.0, https://opendatacommons.org/licenses/odbl/1-0/.
  The full text is in [ODbL-1.0.txt](ODbL-1.0.txt).
- What this is: a Derivative Database of the ADSB.lol database (ODbL section 1.0 definitions, section 4.4). The files in
  `<version>/typical-routes.json` are that database, offered here whole and free of charge in a machine-readable form
  (section 4.6, option a). Anyone who uses it, or a database derived from it, in turn follows the ODbL: keep this notice, keep
  the ADSB.lol attribution, and offer a derivative database under the same licence.
- The route points are processed ADS-B positions. A file holds no aircraft identifier, callsign, operator or time. Airport
  ends are the airport index's coordinates (derived from OurAirports, public domain).
- The code, the tests and the documentation elsewhere in this repository are not part of this database. They are under the
  Apache License 2.0, see `../LICENSE` and `../NOTICE`.

This notice is a summary, not legal advice. The licence text governs.
