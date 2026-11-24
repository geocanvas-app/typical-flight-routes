#!/usr/bin/env node
/**
 * node src/cli.mjs decode <typical-routes.json> [ORIGIN-DESTINATION]   print one route (or the route count) as JSON
 * node src/cli.mjs verify <typical-routes.json> [expected SHA-256]     print the file's SHA-256; exit 1 on a mismatch
 */
import {readFileSync} from 'node:fs';
import {decodeFile, routeKey} from './decode.mjs';
import {sha256Hex, verifyFile} from './verify.mjs';

const [command, path, extra] = process.argv.slice(2);
if (!command || !path) {
  console.error('usage: cli.mjs decode <file> [ORIGIN-DESTINATION] | cli.mjs verify <file> [sha256]');
  process.exit(2);
}
if (command === 'verify') {
  const bytes = readFileSync(path);
  console.log(`${sha256Hex(bytes)}  ${path} (${bytes.length} bytes)`);
  if (extra) {
    const ok = verifyFile(bytes, extra);
    console.log(ok ? 'match' : 'MISMATCH');
    process.exit(ok ? 0 : 1);
  }
} else if (command === 'decode') {
  const routes = decodeFile(JSON.parse(readFileSync(path, 'utf8')));
  if (!extra) console.log(JSON.stringify({routes: Object.keys(routes).length}));
  else if (routes[extra]) console.log(JSON.stringify(routes[extra]));
  else {
    console.error(`No route ${extra}. Routes are keyed ${routeKey('ORIGIN', 'DESTINATION')} in ICAO codes.`);
    process.exit(1);
  }
} else {
  console.error(`Unknown command ${command}`);
  process.exit(2);
}
