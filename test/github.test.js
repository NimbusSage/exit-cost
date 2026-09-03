const test = require('node:test');
const assert = require('node:assert/strict');
const { healthVerdict, NOT_RECOMMENDED } = require('../pipeline/collect/github.js');

test('healthVerdict: recent pushes and releases read active', () => {
  assert.equal(healthVerdict({ archived: false, days_since_push: 3, days_since_release: 20, has_release: true }), 'active');
});

test('healthVerdict: archived beats every other signal', () => {
  assert.equal(healthVerdict({ archived: true, days_since_push: 1, days_since_release: 1, has_release: true }), 'archived');
});

test('healthVerdict: over a year without a push is dormant', () => {
  assert.equal(healthVerdict({ archived: false, days_since_push: 400, days_since_release: 400, has_release: true }), 'dormant');
});

test('healthVerdict: active commits but a two-year-old release is still dormant', () => {
  assert.equal(healthVerdict({ archived: false, days_since_push: 10, days_since_release: 800, has_release: true }), 'dormant');
});

test('healthVerdict: six months quiet reads slowing, not dormant', () => {
  assert.equal(healthVerdict({ archived: false, days_since_push: 200, days_since_release: 100, has_release: true }), 'slowing');
});

test('healthVerdict: a project that never cuts releases is judged on commits alone', () => {
  assert.equal(healthVerdict({ archived: false, days_since_push: 5, days_since_release: null, has_release: false }), 'active');
  assert.equal(healthVerdict({ archived: false, days_since_push: 500, days_since_release: null, has_release: false }), 'dormant');
});

test('INTEGRITY: no activity data yields unknown, never active', () => {
  assert.equal(healthVerdict({ archived: false, days_since_push: null, days_since_release: null, has_release: false }), 'unknown');
});

test('archived and dormant projects are the ones we refuse to recommend', () => {
  assert.equal(NOT_RECOMMENDED.has('archived'), true);
  assert.equal(NOT_RECOMMENDED.has('dormant'), true);
  assert.equal(NOT_RECOMMENDED.has('slowing'), false);
  assert.equal(NOT_RECOMMENDED.has('active'), false);
});
