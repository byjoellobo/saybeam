/**
 * What scripts/release.mjs reads and writes, as pure functions over an
 * in-memory map of file contents ({ "package.json": "...", ... }). The CLI
 * does the file system work; this module decides what changes.
 */
import { changelogProblems, releaseChangelog } from './changelog.mjs';
import {
  cargoLockVersion,
  cargoPackageVersion,
  compareVersions,
  lockfileVersions,
  packageJsonVersion,
  parseVersion,
  repoWebUrl,
  setCargoLockVersion,
  setCargoPackageVersion,
  setLockfileVersions,
  setPackageJsonVersion,
  setWranglerAppVersion,
  wranglerAppVersion,
} from './versioning.mjs';

export const RELAY_CRATE = 'saybeam-relay';
export const CHANGELOG = 'CHANGELOG.md';

/**
 * @typedef {{ file: string, read: (text: string) => { where: string, version: string | null }[], write: (text: string, version: string) => string }} Carrier
 * @typedef {Readonly<Record<string, string>>} Files
 */

/**
 * Every file that carries the release version.
 * @param {readonly string[]} workspaceDirs repository-relative, forward slashes ("apps/web")
 * @returns {Carrier[]}
 */
export function versionCarriers(workspaceDirs) {
  const packageJson = (file) => ({
    file,
    read: (text) => [{ where: 'version', version: packageJsonVersion(text) }],
    write: setPackageJsonVersion,
  });
  return [
    packageJson('package.json'),
    ...workspaceDirs.map((dir) => packageJson(`${dir}/package.json`)),
    {
      file: 'package-lock.json',
      read: (text) => lockfileVersions(text, workspaceDirs),
      write: (text, version) => setLockfileVersions(text, version, workspaceDirs),
    },
    {
      file: 'relay/Cargo.toml',
      read: (text) => [{ where: '[package] version', version: cargoPackageVersion(text) }],
      write: setCargoPackageVersion,
    },
    {
      file: 'relay/Cargo.lock',
      read: (text) => [{ where: `${RELAY_CRATE} version`, version: cargoLockVersion(text, RELAY_CRATE) }],
      write: (text, version) => setCargoLockVersion(text, RELAY_CRATE, version),
    },
    {
      file: 'apps/worker/wrangler.jsonc',
      read: (text) => [{ where: 'vars.APP_VERSION', version: wranglerAppVersion(text) }],
      write: setWranglerAppVersion,
    },
  ];
}

/**
 * Files the release touches, so the CLI knows what to load.
 * @param {readonly string[]} workspaceDirs
 */
export function releaseFiles(workspaceDirs) {
  return [...versionCarriers(workspaceDirs).map((c) => c.file), CHANGELOG];
}

/**
 * @param {Files} files
 * @param {string} file
 */
function need(files, file) {
  const text = files[file];
  if (text === undefined) throw new Error(`${file} is missing`);
  return text;
}

/**
 * The new contents of every file for releasing `version` on `date`.
 * @param {Files} files
 * @param {{ version: string, date: string, workspaceDirs: readonly string[] }} options
 * @returns {{ from: string, to: string, changes: Record<string, string> }}
 */
export function planRelease(files, { version, date, workspaceDirs }) {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`"${version}" is not a semantic version (expected x.y.z, for example 0.3.0)`);
  // Docker tags cannot contain "+", so the release would fail halfway.
  if (parsed.build.length) throw new Error(`"${version}" has build metadata (+...), which release tags and Docker images do not support`);
  const to = parsed.version;
  const rootPackage = JSON.parse(need(files, 'package.json'));
  const from = rootPackage.version;
  if (parseVersion(from) && compareVersions(to, from) <= 0) throw new Error(`${to} is not newer than the current version ${from}`);

  /** @type {Record<string, string>} */
  const changes = {};
  for (const carrier of versionCarriers(workspaceDirs)) changes[carrier.file] = carrier.write(need(files, carrier.file), to);
  changes[CHANGELOG] = releaseChangelog(need(files, CHANGELOG), { version: to, date, repoUrl: repoWebUrl(rootPackage.repository) });
  return { from, to, changes };
}

/**
 * Checks that every version field matches the root package.json, that the
 * changelog has a section and compare links for it, and (optionally) that it
 * equals `expected`, for example the pushed tag.
 * @param {Files} files
 * @param {{ workspaceDirs: readonly string[], expected?: string }} options
 * @returns {{ version: string, entries: { file: string, where: string, version: string | null }[], problems: string[] }}
 */
export function checkVersions(files, { workspaceDirs, expected }) {
  const entries = versionCarriers(workspaceDirs).flatMap((carrier) => carrier.read(need(files, carrier.file)).map((e) => ({ file: carrier.file, ...e })));
  const version = packageJsonVersion(need(files, 'package.json')) ?? '';
  const problems = [];
  const parsed = parseVersion(version);
  if (!parsed) problems.push(`package.json: "${version}" is not a semantic version`);
  else if (parsed.build.length) problems.push(`package.json: "${version}" has build metadata (+...), which release tags and Docker images do not support`);
  for (const e of entries) {
    if (e.version !== version) problems.push(`${e.file} (${e.where}) is ${e.version ?? 'missing'}, expected ${version}`);
  }
  for (const p of changelogProblems(need(files, CHANGELOG), version)) problems.push(`${CHANGELOG}: ${p}`);
  if (expected !== undefined) {
    const want = parseVersion(expected);
    if (!want) problems.push(`"${expected}" is not a semantic version tag (expected vX.Y.Z)`);
    else if (want.version !== version) problems.push(`the tag says ${want.version}, but the files say ${version}`);
  }
  return { version, entries, problems };
}
