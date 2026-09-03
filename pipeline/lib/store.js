/**
 * store.js — atomic JSON read/write for the file-as-database.
 *
 * The whole dataset is git-versioned JSON. That gives a free audit trail of every
 * price change, which is the cheapest possible way to keep the integrity promise.
 * Writes are atomic (tmp + rename) so an interrupted nightly run can never leave a
 * half-written price file behind.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const p = (...parts) => path.join(ROOT, ...parts);

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(`${file} is not valid JSON: ${e.message}`);
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function listJson(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => path.join(dir, f));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

module.exports = { readJson, writeJson, listJson, ROOT, p };
