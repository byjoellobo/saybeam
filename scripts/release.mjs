#!/usr/bin/env node
/**
 * Sets the release version in every file that carries it, and turns the
 * [Unreleased] section of CHANGELOG.md into the new release.
 *
 *   node scripts/release.mjs 0.3.0               # or: npm run release -- 0.3.0
 *   node scripts/release.mjs 0.3.0 --dry-run     # show what would change, write nothing
 *   node scripts/release.mjs 0.3.0 --date 2026-11-03
 *   node scripts/release.mjs --check             # or: npm run version:check
 *   node scripts/release.mjs --check v0.3.0      # also require this version (the release workflow passes the tag)
 *
 * Kept in step: package.json, every workspace package.json and their entries
 * in package-lock.json, relay/Cargo.toml, the saybeam-relay entry in
 * relay/Cargo.lock, and vars.APP_VERSION in apps/worker/wrangler.jsonc (the
 * version GET /api/info reports). See docs/releasing.md.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions, planRelease, releaseFiles } from './lib/release-plan.mjs';
import { isIsoDate, localDate } from './lib/versioning.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inActions = process.env.GITHUB_ACTIONS === 'true';

const USAGE = `Usage:
  node scripts/release.mjs <x.y.z> [--date YYYY-MM-DD] [--dry-run]
  node scripts/release.mjs --check [x.y.z | vx.y.z]

  <x.y.z>     The new version (SemVer 2.0.0, for example 0.3.0 or 1.0.0-rc.1).
  --date      Release date for CHANGELOG.md. Default: today on this computer.
  --dry-run   Print what would change without writing anything.
  --check     Fail if the version fields or CHANGELOG.md disagree. With a
              version (or a tag such as v0.3.0), also require that version.`;

/** Workspace folders from the root package.json, such as ["apps/web", "apps/worker", "packages/protocol"]. */
function workspaceDirs() {
  const patterns = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).workspaces ?? [];
  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith('/*')) return [pattern.replace(/\/+$/, '')];
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent))
      .map((name) => `${parent}/${name}`)
      .filter((dir) => statSync(join(root, dir)).isDirectory() && existsSync(join(root, dir, 'package.json')));
  });
  return [...new Set(dirs)].sort();
}

function loadFiles(dirs) {
  return Object.fromEntries(
    releaseFiles(dirs).map((file) => {
      const path = join(root, file);
      if (!existsSync(path)) throw new Error(`${file} is missing`);
      return [file, readFileSync(path, 'utf8')];
    }),
  );
}

function fail(message) {
  console.error(inActions ? `::error::${message}` : `Error: ${message}`);
  process.exit(1);
}

function check(expected) {
  const dirs = workspaceDirs();
  const { version, entries, problems } = checkVersions(loadFiles(dirs), { workspaceDirs: dirs, ...(expected === undefined ? {} : { expected }) });
  for (const e of entries) console.log(`  ${(e.version ?? 'missing').padEnd(12)} ${e.file} (${e.where})`);
  if (problems.length) {
    console.error('');
    for (const p of problems) console.error(inActions ? `::error::${p}` : `  - ${p}`);
    const onlyTheTag = problems.every((p) => p.startsWith('the tag says') || p.includes('is not a semantic version tag'));
    fail(
      onlyTheTag
        ? 'The files agree with each other, but not with the tag. Tag the release commit instead (see docs/releasing.md).'
        : 'Versions disagree. Set them with: npm run release -- <x.y.z> (see docs/releasing.md).',
    );
  }
  console.log(`\nAll ${entries.length} version fields and CHANGELOG.md agree on ${version}${expected === undefined ? '' : `, matching ${expected}`}.`);
}

function release(version, { date, dryRun }) {
  if (!isIsoDate(date)) fail(`--date must be a real date as YYYY-MM-DD, not "${date}"`);
  const dirs = workspaceDirs();
  const files = loadFiles(dirs);
  // Everything is computed (and validated) before anything is written.
  const { from, to, changes } = planRelease(files, { version, date, workspaceDirs: dirs });
  const changed = Object.keys(changes).filter((file) => changes[file] !== files[file]);
  console.log(`Saybeam ${from} -> ${to} (${date})${dryRun ? ', dry run: nothing written' : ''}\n`);
  for (const file of changed) {
    if (!dryRun) writeFileSync(join(root, file), changes[file]);
    console.log(`  ${dryRun ? 'would update' : 'updated'} ${file}`);
  }
  if (dryRun) return;
  console.log(`
Next steps (docs/releasing.md):
  1. Review the diff, and fill in anything missing in the ${to} section of CHANGELOG.md.
  2. Commit only these files, signed off:
       git add ${changed.join(' ')}
       git commit -s -m "chore(release): v${to}"
  3. Push the commit and wait for CI to pass:
       git push origin main
  4. Tag it and push the tag. The Release workflow does the rest:
       git tag -a v${to} -m "Saybeam v${to}"
       git push origin v${to}`);
}

function main(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  if (argv[0] === '--check') {
    if (argv.length > 2) fail(`--check takes at most one version.\n\n${USAGE}`);
    check(argv[1]);
    return;
  }
  let version;
  let date = localDate();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--date') {
      date = argv[++i] ?? '';
    } else if (arg?.startsWith('-')) fail(`Unknown option ${arg}.\n\n${USAGE}`);
    else if (version === undefined) version = arg;
    else fail(`Only one version, please.\n\n${USAGE}`);
  }
  if (version === undefined) fail(`Which version? For example: npm run release -- 0.3.0\n\n${USAGE}`);
  release(version, { date, dryRun });
}

try {
  main(process.argv.slice(2));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
