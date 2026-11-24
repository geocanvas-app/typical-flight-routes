/**
 * Parity with the code this pipeline was ported from. The fixtures were produced by the original implementation from
 * the same small synthetic inputs: made-up traces between real airports, never archive data. The ported gates must
 * write byte-identical index.json and result.json, and the ported model the same floating-point times.
 */
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {runGate} from '../src/build/gate.mjs';
import {runWorldGate} from '../src/build/world-gate.mjs';
import {legacyProfile, modelledAirborne} from '../src/lib/model.mjs';

const fixture = (...p) => new URL(`./fixtures/${p.join('/')}`, import.meta.url);
const read = (dir, name) => readFileSync(join(dir, name));
const quiet = () => {};

test('the first gate writes the original implementation\'s index.json and result.json byte for byte', () => {
  const out = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    runGate(fileURLToPath(fixture('gate')), out, quiet);
    assert.deepEqual(read(out, 'index.json'), readFileSync(fixture('expected', 'gate-index.json')));
    assert.deepEqual(read(out, 'result.json'), readFileSync(fixture('expected', 'gate-result.json')));
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
});

test('the world gate writes the original implementation\'s index.json and result.json byte for byte, and runs only once per folder', () => {
  const out = mkdtempSync(join(tmpdir(), 'world-'));
  const dir = fileURLToPath(fixture('world'));
  try {
    runWorldGate(dir, out, quiet);
    assert.deepEqual(read(out, 'index.json'), readFileSync(fixture('expected', 'world-index.json')));
    assert.deepEqual(read(out, 'result.json'), readFileSync(fixture('expected', 'world-result.json')));
    assert.throws(() => runWorldGate(dir, out, quiet), /already exists/);
  } finally {
    rmSync(out, {recursive: true, force: true});
  }
});

test('the calm-wind model gives the original implementation\'s times to the last bit', () => {
  const {model} = JSON.parse(readFileSync(fixture('expected', 'original-decode-and-model.json'), 'utf8'));
  const p = legacyProfile();
  for (const m of model) {
    const run = (timing) => modelledAirborne({origin: m.origin, destination: m.destination, departureMs: 1_700_000_000_000, cruiseAltM: p.cruiseAltM, timing, wind: () => null}).airborneMs;
    assert.equal(run(p), m.active);
    assert.equal(run({...p, routeStretch: 1.087}), m.stretch109);
    assert.equal(run({...p, routeStretch: 1.2}), m.stretch12);
  }
});
