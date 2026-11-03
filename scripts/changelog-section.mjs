#!/usr/bin/env node
/**
 * Prints the CHANGELOG.md section for one version: the release notes the
 * Release workflow puts on the GitHub release.
 *
 *   node scripts/changelog-section.mjs 0.2.0            # or v0.2.0
 *   node scripts/changelog-section.mjs 0.2.0 --relative
 *
 * Relative links (docs/deploy.md) are rewritten to point at the files as of
 * the version's tag, because a release page cannot resolve them. Pass
 * --relative to print the section exactly as written. Exits 1 when the
 * version has no section, or an empty one.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absolutizeLinks, changelogSection } from './lib/changelog.mjs';
import { parseVersion, repoWebUrl } from './lib/versioning.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const relative = args.includes('--relative');
const positional = args.filter((a) => !a.startsWith('--'));

function fail(message) {
  console.error(process.env.GITHUB_ACTIONS === 'true' ? `::error::${message}` : `Error: ${message}`);
  process.exit(1);
}

if (positional.length !== 1 || args.some((a) => a.startsWith('--') && a !== '--relative')) {
  fail('Usage: node scripts/changelog-section.mjs <x.y.z> [--relative]');
}
const parsed = parseVersion(positional[0] ?? '');
if (!parsed) fail(`"${positional[0]}" is not a semantic version`);
const version = parsed.version;

const section = changelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
if (section === null) fail(`CHANGELOG.md has no "## [${version}]" section`);
if (!section) fail(`The ${version} section of CHANGELOG.md is empty`);

const repoUrl = repoWebUrl(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).repository);
process.stdout.write(`${relative ? section : absolutizeLinks(section, { repoUrl, ref: `v${version}` })}\n`);
