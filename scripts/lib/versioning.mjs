/**
 * Pure helpers for scripts/release.mjs: semantic versions, and reading and
 * writing the version field of every file that carries the release version.
 * Nothing here touches the file system, so it is easy to test
 * (scripts/test/release.test.mjs).
 */

// The regular expression suggested by the SemVer 2.0.0 specification (semver.org).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * @typedef {{ version: string, major: number, minor: number, patch: number, prerelease: string[], build: string[] }} Version
 */

/**
 * Parses "1.2.3", "1.2.3-rc.1" or "v1.2.3". Returns null for anything that is not SemVer 2.0.0.
 * @param {string} input
 * @returns {Version | null}
 */
export function parseVersion(input) {
  const text = String(input ?? '')
    .trim()
    .replace(/^v/, '');
  const m = SEMVER.exec(text);
  if (!m) return null;
  return {
    version: text,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split('.') : [],
    build: m[5] ? m[5].split('.') : [],
  };
}

/**
 * SemVer precedence (section 11 of the spec): negative if a < b, 0 if equal, positive if a > b.
 * Build metadata is ignored.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Not a semantic version: ${!x ? a : b}`);
  for (const key of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (x[key] !== y[key]) return x[key] - y[key];
  }
  // A version without a prerelease ranks higher than the same version with one.
  if (!x.prerelease.length || !y.prerelease.length) return y.prerelease.length - x.prerelease.length;
  const n = Math.max(x.prerelease.length, y.prerelease.length);
  for (let i = 0; i < n; i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1; // numeric identifiers rank lower than alphanumeric ones
    return p < q ? -1 : 1;
  }
  return 0;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces one regex match's second group with `value`, failing loudly when the pattern is missing.
 * @param {string} text
 * @param {RegExp} re a pattern with three groups: before, value, after
 * @param {string} value
 * @param {string} what for the error message
 */
function replaceGroup(text, re, value, what) {
  if (!re.test(text)) throw new Error(`Could not find ${what}`);
  return text.replace(re, (_all, before, _old, after) => `${before}${value}${after}`);
}

// ---- package.json --------------------------------------------------------

/** The top-level "version" of a package.json (two-space indent, as npm writes it). */
const PACKAGE_VERSION = /^( {2}"version":\s*")([^"]*)(")/m;

/** @param {string} text */
export function packageJsonVersion(text) {
  const version = JSON.parse(text).version;
  return typeof version === 'string' ? version : null;
}

/**
 * Sets the top-level version and keeps the rest of the file byte for byte.
 * @param {string} text
 * @param {string} version
 */
export function setPackageJsonVersion(text, version) {
  return replaceGroup(text, PACKAGE_VERSION, version, 'a top-level "version" field');
}

// ---- package-lock.json ---------------------------------------------------

/**
 * The versions package-lock.json records for the root package and each workspace.
 * @param {string} text
 * @param {readonly string[]} workspaceDirs repository-relative, forward slashes ("apps/web")
 * @returns {{ where: string, version: string | null }[]}
 */
export function lockfileVersions(text, workspaceDirs) {
  const lock = JSON.parse(text);
  const packages = lock.packages ?? {};
  return [
    { where: 'version', version: lock.version ?? null },
    { where: 'packages[""]', version: packages['']?.version ?? null },
    ...workspaceDirs.map((dir) => ({ where: `packages["${dir}"]`, version: packages[dir]?.version ?? null })),
  ];
}

/**
 * Returns a new package-lock.json with the root and workspace versions set,
 * formatted exactly as npm writes it.
 * @param {string} text
 * @param {string} version
 * @param {readonly string[]} workspaceDirs
 */
export function setLockfileVersions(text, version, workspaceDirs) {
  const lock = JSON.parse(text);
  const packages = lock.packages ?? {};
  for (const key of ['', ...workspaceDirs]) {
    if (!packages[key]) throw new Error(`package-lock.json has no entry for ${key === '' ? 'the root package' : key}. Run npm install first.`);
  }
  const next = {
    ...lock,
    version,
    packages: Object.fromEntries(Object.entries(packages).map(([key, entry]) => [key, key === '' || workspaceDirs.includes(key) ? { ...entry, version } : entry])),
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

// ---- Cargo ---------------------------------------------------------------

/** The [package] table of a Cargo.toml: from its header to the next table header. */
function packageTable(text) {
  const start = /^\[package\][ \t]*\r?$/m.exec(text);
  if (!start) throw new Error('Could not find a [package] table');
  const from = start.index + start[0].length;
  const rest = text.slice(from);
  const next = /^\[/m.exec(rest);
  const to = next ? from + next.index : text.length;
  return { from, to };
}

const TOML_VERSION = /^(version\s*=\s*")([^"]*)(")/m;

/** @param {string} text */
export function cargoPackageVersion(text) {
  const { from, to } = packageTable(text);
  return TOML_VERSION.exec(text.slice(from, to))?.[2] ?? null;
}

/**
 * @param {string} text
 * @param {string} version
 */
export function setCargoPackageVersion(text, version) {
  const { from, to } = packageTable(text);
  const table = replaceGroup(text.slice(from, to), TOML_VERSION, version, 'version in the [package] table');
  return text.slice(0, from) + table + text.slice(to);
}

/** @param {string} crate */
const lockEntry = (crate) => new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(crate)}"\\r?\\nversion = ")([^"]*)(")`);

/**
 * @param {string} text
 * @param {string} crate
 */
export function cargoLockVersion(text, crate) {
  return lockEntry(crate).exec(text)?.[2] ?? null;
}

/**
 * @param {string} text
 * @param {string} crate
 * @param {string} version
 */
export function setCargoLockVersion(text, crate, version) {
  return replaceGroup(text, lockEntry(crate), version, `the ${crate} entry in Cargo.lock`);
}

// ---- wrangler.jsonc ------------------------------------------------------

/** vars.APP_VERSION, which the Worker reports in GET /api/info. */
const APP_VERSION = /("APP_VERSION"\s*:\s*")([^"]*)(")/;

/** @param {string} text */
export function wranglerAppVersion(text) {
  return APP_VERSION.exec(text)?.[2] ?? null;
}

/**
 * @param {string} text
 * @param {string} version
 */
export function setWranglerAppVersion(text, version) {
  return replaceGroup(text, APP_VERSION, version, '"APP_VERSION" in wrangler.jsonc');
}

// ---- Odds and ends -------------------------------------------------------

/**
 * The https web address of a GitHub repository from package.json's "repository" field.
 * Accepts "git+https://github.com/o/r.git", "https://github.com/o/r" and "github:o/r".
 * @param {string | { url?: string } | undefined} repository
 */
export function repoWebUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) throw new Error('package.json has no "repository" field');
  const m = /^(?:(?:git\+)?https:\/\/github\.com\/|github:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(raw.trim());
  if (!m) throw new Error(`Unrecognised repository URL: ${raw}`);
  return `https://github.com/${m[1]}/${m[2]}`;
}

/**
 * Today's date on this machine as YYYY-MM-DD (the release date in CHANGELOG.md).
 * @param {Date} [now]
 */
export function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** @param {string} s */
export function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
