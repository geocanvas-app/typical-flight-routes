import assert from 'node:assert/strict';
import {test} from 'node:test';
import {confirmedRange, typicalRoutesVerdict, worldDecisions, worldGroupClass} from '../src/lib/rules.mjs';

const MIB3 = 3 * 1024 * 1024;

// The first gate.
const passing = {coverage: 0.6, gcSidewaysKm: 20, libSidewaysKm: 8, gcLengthPct: 6, libLengthPct: 2, activeTimeMin: 10, libTimeMin: 8, zippedBytes: 1024 * 1024};
const verdict = (o) => typicalRoutesVerdict({...passing, ...o});

test('the first gate goes when every rule passes', () => assert.deepEqual(verdict({}), {go: true, failed: []}));

for (const [rule, edge, past] of [
  ['coverage', {coverage: 0.5}, {coverage: 0.4999}],
  ['sideways', {libSidewaysKm: 10}, {libSidewaysKm: 10.01}],
  ['length', {libLengthPct: 3}, {libLengthPct: 3.01}],
  ['time', {libTimeMin: 10}, {libTimeMin: 10.01}],
  ['size', {zippedBytes: MIB3}, {zippedBytes: MIB3 + 1}],
]) {
  test(`the first gate: ${rule} passes on its boundary and fails just past it`, () => {
    assert.deepEqual(verdict(edge), {go: true, failed: []});
    assert.deepEqual(verdict(past), {go: false, failed: [rule]});
  });
}

test('the first gate reports every failing rule and fails closed on NaN and infinity', () => {
  assert.deepEqual(verdict({coverage: 0.1, libTimeMin: 20, zippedBytes: 1e9}).failed, ['coverage', 'time', 'size']);
  for (const key of Object.keys(passing)) assert.equal(verdict({[key]: NaN}).go, false, key);
  assert.equal(verdict({gcSidewaysKm: Infinity}).go, false);
  assert.equal(verdict({libLengthPct: -Infinity}).go, false);
});

// The world confirmation.
const good = {scoredLegs: 100, scoredPairs: 10, coverage: 0.5, gcSidewaysKm: 20, libSidewaysKm: 10, gcLengthPct: 6, libLengthPct: 3, pairsBetterShare: 2 / 3};
const group = (o) => worldGroupClass({...good, ...o});

test('a world group meeting every rule on its boundary is confirmed', () => assert.equal(group({}), 'confirmed'));

test('too few legs or pairs is insufficient evidence, whatever the numbers', () => {
  for (const o of [{scoredLegs: 99}, {scoredPairs: 9}, {scoredLegs: 0, scoredPairs: 0}]) {
    assert.equal(group(o), 'insufficient evidence');
    assert.equal(group({...o, coverage: 0, libSidewaysKm: 1e9}), 'insufficient evidence');
  }
  for (const key of ['scoredLegs', 'scoredPairs']) {
    assert.equal(group({[key]: NaN}), 'insufficient evidence');
    assert.equal(group({[key]: Infinity}), 'insufficient evidence');
  }
});

test('a world group is not confirmed just past a limit, on NaN or on infinity', () => {
  for (const o of [{coverage: 0.4999}, {libSidewaysKm: 10.01}, {libLengthPct: 3.01}, {pairsBetterShare: 0.66}, {libSidewaysKm: 20, libLengthPct: 6}]) {
    assert.equal(group(o), 'not confirmed');
  }
  for (const key of ['coverage', 'gcSidewaysKm', 'libSidewaysKm', 'gcLengthPct', 'libLengthPct', 'pairsBetterShare']) assert.equal(group({[key]: NaN}), 'not confirmed', key);
  assert.equal(group({gcSidewaysKm: Infinity}), 'not confirmed');
  assert.equal(group({libLengthPct: -Infinity}), 'not confirmed');
});

const band = (lowKm, highKm, cls) => ({lowKm, highKm, cls});
const C = 'confirmed', N = 'not confirmed', I = 'insufficient evidence';
const bands = (...cls) => [band(250, 500, cls[0]), band(500, 1000, cls[1]), band(1000, 1500, cls[2]), band(1500, 2000, cls[3])];

test('confirmedRange takes the longest contiguous run, the shorter-distance run on a tie', () => {
  assert.equal(confirmedRange(bands(N, I, N, I)), null);
  assert.equal(confirmedRange([]), null);
  assert.deepEqual(confirmedRange(bands(N, N, C, N)), {lowKm: 1000, highKm: 1500});
  assert.deepEqual(confirmedRange(bands(C, C, C, N)), {lowKm: 250, highKm: 1500});
  assert.deepEqual(confirmedRange(bands(C, N, C, C)), {lowKm: 1000, highKm: 2000});
  assert.deepEqual(confirmedRange(bands(C, I, C, C)), {lowKm: 1000, highKm: 2000});
  assert.deepEqual(confirmedRange(bands(C, C, N, C)), {lowKm: 250, highKm: 1000});
  assert.deepEqual(confirmedRange(bands(C, N, N, C)), {lowKm: 1500, highKm: 2000});
  assert.deepEqual(confirmedRange(bands(N, C, N, C)), {lowKm: 500, highKm: 1000});
  assert.deepEqual(confirmedRange([band(0, 10, C), band(10, 20, N), band(20, 30, C)]), {lowKm: 0, highKm: 10});
});

const input = {pooledClass: C, libTimeMin: 8, activeTimeMin: 10, zippedBytes: 1024 * 1024, matcherRight: 98, matcherWrong: 2, bands: bands(C, C, C, N), restOfWorldClass: C};
const decide = (o) => worldDecisions({...input, ...o});

test('world decisions: go, range and world flag', () => {
  assert.deepEqual(decide({}), {go: true, failed: [], confirmedRange: {lowKm: 250, highKm: 1500}, worldConfirmed: true});
  for (const cls of [N, I]) assert.deepEqual(decide({restOfWorldClass: cls}), {go: true, failed: [], confirmedRange: {lowKm: 250, highKm: 1500}, worldConfirmed: false});
  assert.deepEqual(decide({bands: bands(N, I, N, N)}), {go: true, failed: [], confirmedRange: null, worldConfirmed: true});
});

test('world decisions: without go no range and no world', () => {
  for (const [rule, o] of [['pooled', {pooledClass: N}], ['pooled', {pooledClass: I}], ['time', {libTimeMin: 10.01}], ['size', {zippedBytes: MIB3 + 1}], ['matcher', {matcherRight: 97, matcherWrong: 3}]]) {
    assert.deepEqual(decide(o), {go: false, failed: [rule], confirmedRange: null, worldConfirmed: false});
  }
  for (const o of [{libTimeMin: 10}, {zippedBytes: MIB3}, {matcherRight: 98, matcherWrong: 2}, {matcherRight: 4900, matcherWrong: 100}]) assert.equal(decide(o).go, true);
  assert.equal(decide({matcherRight: 4899, matcherWrong: 101}).go, false);
});

test('world decisions fail closed', () => {
  for (const o of [{matcherRight: 0, matcherWrong: 0}, {matcherRight: NaN}, {matcherWrong: -1}, {matcherRight: Infinity}]) assert.deepEqual(decide(o).failed, ['matcher']);
  for (const key of ['libTimeMin', 'activeTimeMin', 'zippedBytes']) {
    const d = decide({[key]: NaN});
    assert.equal(d.go, false);
    assert.equal(d.confirmedRange, null);
    assert.equal(d.worldConfirmed, false);
  }
  assert.equal(decide({activeTimeMin: Infinity}).go, false);
  assert.equal(decide({libTimeMin: -Infinity}).go, false);
  assert.deepEqual(decide({pooledClass: N, libTimeMin: 20, zippedBytes: 1e9, matcherWrong: 50}).failed, ['pooled', 'time', 'size', 'matcher']);
});
