const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const APPS = path.join(ROOT, 'kits', 'apps');
const OUT = path.join(ROOT, 'kits', 'out');
const { generate } = require('../kits/build.js');

const specs = fs.readdirSync(APPS).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(APPS, f), 'utf8')));

let built = false;
function build() {
  if (built) return;
  for (const s of specs) generate(s);
  built = true;
}
const kitDir = (s) => path.join(OUT, `exit-kit-${s.id}`);
const read = (s, f) => fs.readFileSync(path.join(kitDir(s), f), 'utf8');

test('there is at least one kit spec', () => {
  assert.ok(specs.length >= 1);
});

for (const s of specs) {
  test(`${s.id}: every promised file is generated`, () => {
    build();
    for (const f of ['docker-compose.yml', 'Caddyfile', '.env.example', 'install.sh',
                     'backup.sh', 'restore-drill.sh', 'crontab.example', 'README.md', 'RUNBOOK.md']) {
      assert.ok(fs.existsSync(path.join(kitDir(s), f)), `${f} is missing`);
    }
  });

  test(`${s.id}: scripts are executable`, () => {
    build();
    for (const f of ['install.sh', 'backup.sh', 'restore-drill.sh']) {
      assert.ok(fs.statSync(path.join(kitDir(s), f)).mode & 0o111, `${f} is not executable`);
    }
  });

  test(`${s.id}: INTEGRITY — every variable the stack needs is documented in .env.example`, () => {
    // The classic kit failure: compose requires a variable that .env.example
    // never mentions, so the stack dies on someone else's first run.
    build();
    const documented = new Set(
      [...read(s, '.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
    const used = new Set();
    for (const f of ['docker-compose.yml', 'backup.sh', 'restore-drill.sh', 'install.sh']) {
      for (const m of read(s, f).matchAll(/\$\{([A-Z][A-Z0-9_]*)(:[?-][^}]*)?\}/g)) used.add(m[1]);
    }
    // Variables the scripts set for themselves are not configuration.
    for (const local of ['STAMP', 'WORK', 'LATEST', 'DRILL_DB', 'DRILL_PW', 'FAILURES',
                         'AGE_DAYS', 'DB_BYTES', 'VERSION_CODENAME', 'KITDIR']) used.delete(local);
    const missing = [...used].filter((v) => !documented.has(v));
    assert.deepEqual(missing, [], `not documented in .env.example: ${missing.join(', ')}`);
  });

  test(`${s.id}: INTEGRITY — no default or placeholder credentials ship in the stack`, () => {
    build();
    const compose = read(s, 'docker-compose.yml');
    for (const bad of [/password:\s*["']?(admin|changeme|password|secret|postgres)["']?/i,
                       /POSTGRES_PASSWORD:\s*[a-z0-9]/i,
                       /SECRET_KEY:\s*[a-z0-9]/i]) {
      assert.doesNotMatch(compose, bad, 'a literal credential reached the compose file');
    }
    // Every secret must come from the environment and be required, not defaulted.
    for (const key of ['POSTGRES_PASSWORD', 'BASEROW_SECRET_KEY']) {
      if (compose.includes(key)) {
        assert.match(compose, new RegExp(`\\$\\{${key}(:\\?[^}]*)?\\}`),
          `${key} must be injected from the environment`);
      }
    }
  });

  test(`${s.id}: INTEGRITY — only the proxy is exposed to the network`, () => {
    build();
    const d = read(s, 'docker-compose.yml');
    // A published port on the database is the single worst default in self-hosting.
    const published = [...d.matchAll(/^\s*-\s*"(\d+):(\d+)"/gm)].map((m) => m[1]);
    assert.deepEqual(published.sort(), ['443', '80'], 'only 80 and 443 may be published');
    assert.match(d, /db:[\s\S]*?expose:\s*\n\s*-\s*"5432"/, 'the database must be exposed, not published');
  });

  test(`${s.id}: the restore drill fails loudly rather than reporting a hollow success`, () => {
    build();
    const drill = read(s, 'restore-drill.sh');
    assert.match(drill, /set -Eeuo pipefail/);
    assert.match(drill, /--exit-on-error/, 'a partial restore must count as a failure');
    assert.match(drill, /exit 1/, 'the drill must exit non-zero on failure');
    assert.match(drill, /docker rm -f/, 'the throwaway container must be cleaned up');
    assert.ok(!/docker compose exec[^\n]*db\b/.test(drill),
      'the drill must never touch the live database');
    for (const a of s.restore_assertions) {
      assert.ok(drill.includes(a.label), `assertion "${a.label}" is not in the drill`);
    }
  });

  test(`${s.id}: the backup refuses to call a suspiciously small dump a success`, () => {
    build();
    const b = read(s, 'backup.sh');
    assert.match(b, /set -Eeuo pipefail/);
    assert.match(b, /-lt 5000/, 'a tiny dump must be rejected');
    assert.match(b, /openssl enc -aes-256-cbc/, 'backups must be encrypted before leaving the host');
    assert.match(b, /--min-age 14d/, 'retention must be bounded');
    assert.match(b, /--include "\*\.tar\.gz\.enc"/, 'retention must only ever delete our own files');
  });

  test(`${s.id}: the README states what the kit does not do`, () => {
    build();
    const r = read(s, 'README.md');
    assert.match(r, /does not do/i, 'the honest-limits section is missing');
    assert.match(r, /one server/i);
    assert.match(r, /restore drill/i);
  });

  test(`${s.id}: shellcheck passes on every script`, () => {
    build();
    for (const f of ['install.sh', 'backup.sh', 'restore-drill.sh']) {
      try {
        execFileSync('shellcheck', ['-S', 'warning', f], { cwd: kitDir(s), stdio: 'pipe' });
      } catch (e) {
        assert.fail(`shellcheck failed on ${f}:\n${e.stdout?.toString() || e.message}`);
      }
    }
  });

  test(`${s.id}: every image is pinned to an explicit tag`, () => {
    build();
    const d = read(s, 'docker-compose.yml');
    const images = [...d.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(images.length >= 3);
    for (const i of images) {
      assert.match(i, /:/, `${i} has no tag`);
      assert.doesNotMatch(i, /:latest$/, `${i} is pinned to "latest", which is not pinned`);
    }
  });

  test(`${s.id}: the spec names a comparison that exists on the site`, () => {
    const escapes = fs.readdirSync(path.join(ROOT, 'data', 'escapes')).map((f) => f.replace('.json', ''));
    assert.ok(escapes.includes(s.escape), `${s.escape} is not a published comparison`);
  });
}
