import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { absolutizeLinks, changelogProblems, changelogSection, releaseChangelog, releasedVersions } from '../lib/changelog.mjs';
import { checkVersions, planRelease } from '../lib/release-plan.mjs';
import {
  cargoLockVersion,
  cargoPackageVersion,
  compareVersions,
  isIsoDate,
  localDate,
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
} from '../lib/versioning.mjs';

const REPO = 'https://github.com/byjoellobo/saybeam';

describe('parseVersion', () => {
  it('accepts SemVer 2.0.0, with or without a leading v', () => {
    expect(parseVersion('0.2.0')).toMatchObject({ version: '0.2.0', major: 0, minor: 2, patch: 0, prerelease: [] });
    expect(parseVersion('v1.0.0-rc.1+build.5')).toMatchObject({ version: '1.0.0-rc.1+build.5', prerelease: ['rc', '1'], build: ['build', '5'] });
  });

  it.each(['', '1', '1.2', '01.2.3', '1.2.3-', '1.2.3-01', '1.2.3.4', 'latest', 'v'])('rejects %j', (input) => {
    expect(parseVersion(input)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders versions by SemVer precedence', () => {
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0'];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(ordered[i - 1], ordered[i])).toBeLessThan(0);
      expect(compareVersions(ordered[i], ordered[i - 1])).toBeGreaterThan(0);
    }
  });

  it('ignores build metadata', () => {
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0);
  });

  it('throws on non-versions', () => {
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(/semantic version/);
  });
});

describe('package.json', () => {
  const text = '{\n  "name": "x",\n  "version": "0.1.0",\n  "engines": {\n    "version": "keep"\n  }\n}\n';

  it('sets only the top-level version and keeps the formatting', () => {
    const next = setPackageJsonVersion(text, '0.2.0');
    expect(next).toBe(text.replace('"version": "0.1.0"', '"version": "0.2.0"'));
    expect(packageJsonVersion(next)).toBe('0.2.0');
  });

  it('fails when there is no version', () => {
    expect(() => setPackageJsonVersion('{\n  "name": "x"\n}\n', '1.0.0')).toThrow(/version/);
  });
});

describe('package-lock.json', () => {
  const lock = {
    name: 'saybeam',
    version: '0.1.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'saybeam', version: '0.1.0' },
      'apps/web': { name: '@saybeam/web', version: '0.1.0' },
      'node_modules/@saybeam/web': { resolved: 'apps/web', link: true },
      'node_modules/zod': { version: '4.6.7' },
    },
  };
  const text = `${JSON.stringify(lock, null, 2)}\n`;

  it('sets the root and workspace entries and nothing else', () => {
    const next = setLockfileVersions(text, '0.2.0', ['apps/web']);
    expect(lockfileVersions(next, ['apps/web']).map((e) => e.version)).toEqual(['0.2.0', '0.2.0', '0.2.0']);
    expect(JSON.parse(next).packages['node_modules/zod'].version).toBe('4.6.7');
    expect(next.endsWith('}\n')).toBe(true);
  });

  it('fails when a workspace is missing from the lockfile', () => {
    expect(() => setLockfileVersions(text, '0.2.0', ['apps/worker'])).toThrow(/npm install/);
  });
});

describe('Cargo', () => {
  const toml = '[package]\nname = "saybeam-relay"\nversion = "0.1.0"\nedition = "2024"\n\n[dependencies]\nserde = { version = "1" }\nversion = "not this"\n';
  const lock = '[[package]]\nname = "saybeam"\nversion = "9.9.9"\n\n[[package]]\nname = "saybeam-relay"\nversion = "0.1.0"\ndependencies = [\n "axum",\n]\n';

  it('sets the [package] version only', () => {
    const next = setCargoPackageVersion(toml, '0.2.0');
    expect(cargoPackageVersion(next)).toBe('0.2.0');
    expect(next).toContain('version = "not this"');
    expect(next).toContain('serde = { version = "1" }');
  });

  it('sets the named crate in Cargo.lock, not crates with a similar name', () => {
    const next = setCargoLockVersion(lock, 'saybeam-relay', '0.2.0');
    expect(cargoLockVersion(next, 'saybeam-relay')).toBe('0.2.0');
    expect(cargoLockVersion(next, 'saybeam')).toBe('9.9.9');
  });

  it('fails without a [package] table', () => {
    expect(() => cargoPackageVersion('[workspace]\n')).toThrow(/\[package\]/);
  });
});

describe('wrangler.jsonc', () => {
  it('sets vars.APP_VERSION and keeps comments', () => {
    const text = '{\n  // comment\n  "vars": {\n    "APP_VERSION": "0.1.0"\n  }\n}\n';
    const next = setWranglerAppVersion(text, '0.2.0');
    expect(wranglerAppVersion(next)).toBe('0.2.0');
    expect(next).toContain('// comment');
  });
});

describe('repoWebUrl', () => {
  it.each([
    ['git+https://github.com/byjoellobo/saybeam.git', REPO],
    ['https://github.com/byjoellobo/saybeam', REPO],
    ['https://github.com/byjoellobo/saybeam/', REPO],
    ['github:byjoellobo/saybeam', REPO],
  ])('%s', (input, expected) => {
    expect(repoWebUrl({ url: input })).toBe(expected);
    expect(repoWebUrl(input)).toBe(expected);
  });

  it('rejects other hosts and missing fields', () => {
    expect(() => repoWebUrl('https://gitlab.com/o/r')).toThrow(/Unrecognised/);
    expect(() => repoWebUrl(undefined)).toThrow(/repository/);
  });
});

describe('dates', () => {
  it('formats the local date', () => {
    expect(localDate(new Date(2026, 10, 3, 23, 59))).toBe('2026-11-03');
  });

  it('validates YYYY-MM-DD', () => {
    expect(isIsoDate('2026-11-03')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('3 Nov 2026')).toBe(false);
  });
});

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- A new thing. See [the guide](docs/user-guide.md).

## [0.1.0] - 2026-10-29

### Added

- The first release.

[Unreleased]: ${REPO}/compare/v0.1.0...HEAD
[0.1.0]: ${REPO}/releases/tag/v0.1.0
`;

describe('releaseChangelog', () => {
  it('dates the Unreleased section, opens a fresh one and updates the links', () => {
    const next = releaseChangelog(CHANGELOG, { version: '0.2.0', date: '2026-11-03', repoUrl: REPO });
    expect(next).toContain('## [Unreleased]\n\n## [0.2.0] - 2026-11-03\n\n### Added\n\n- A new thing.');
    expect(next).toContain(`[Unreleased]: ${REPO}/compare/v0.2.0...HEAD\n[0.2.0]: ${REPO}/compare/v0.1.0...v0.2.0\n[0.1.0]: ${REPO}/releases/tag/v0.1.0\n`);
    expect(releasedVersions(next)).toEqual(['0.2.0', '0.1.0']);
    expect(changelogSection(next, 'Unreleased')).toBe('');
    expect(changelogProblems(next, '0.2.0')).toEqual([]);
  });

  it('links the first release to its tag', () => {
    const first = '# Changelog\n\n## [Unreleased]\n\n- Everything.\n';
    const next = releaseChangelog(first, { version: '0.1.0', date: '2026-10-29', repoUrl: REPO });
    expect(next).toContain(`[Unreleased]: ${REPO}/compare/v0.1.0...HEAD\n[0.1.0]: ${REPO}/releases/tag/v0.1.0\n`);
  });

  it('refuses an empty Unreleased section, an existing version and an older version', () => {
    const released = releaseChangelog(CHANGELOG, { version: '0.2.0', date: '2026-11-03', repoUrl: REPO });
    expect(() => releaseChangelog(released, { version: '0.3.0', date: '2026-11-04', repoUrl: REPO })).toThrow(/empty/);
    expect(() => releaseChangelog(CHANGELOG, { version: '0.1.0', date: '2026-11-03', repoUrl: REPO })).toThrow(/already has/);
    expect(() => releaseChangelog(CHANGELOG, { version: '0.0.9', date: '2026-11-03', repoUrl: REPO })).toThrow(/not newer/);
    expect(() => releaseChangelog(CHANGELOG, { version: '0.2.0', date: 'today', repoUrl: REPO })).toThrow(/date/);
  });
});

describe('changelogSection', () => {
  it('returns one section without the link definitions after the last one', () => {
    expect(changelogSection(CHANGELOG, '0.1.0')).toBe('### Added\n\n- The first release.');
    expect(changelogSection(CHANGELOG, 'Unreleased')).toBe('### Added\n\n- A new thing. See [the guide](docs/user-guide.md).');
    expect(changelogSection(CHANGELOG, '9.9.9')).toBeNull();
  });

  it('reports missing sections and stale links', () => {
    expect(changelogProblems(CHANGELOG, '0.1.0')).toEqual([]);
    expect(changelogProblems(CHANGELOG, '0.2.0')).toHaveLength(3);
  });
});

describe('absolutizeLinks', () => {
  const where = { repoUrl: `${REPO}/`, ref: 'v0.2.0' };

  it('rewrites relative links only', () => {
    const md = 'See [a](docs/a.md), [b](./b.md "B"), [c](https://example.org), [d](#top) and [e](/root).';
    expect(absolutizeLinks(md, where)).toBe(`See [a](${REPO}/blob/v0.2.0/docs/a.md), [b](${REPO}/blob/v0.2.0/b.md "B"), [c](https://example.org), [d](#top) and [e](/root).`);
  });

  it('points images at the raw file and leaves code spans alone', () => {
    expect(absolutizeLinks('![Listener](docs/images/listener.png)', where)).toBe(`![Listener](${REPO}/raw/v0.2.0/docs/images/listener.png)`);
    expect(absolutizeLinks('Type `[c](docs/x.md)` or see [x](docs/x.md).', where)).toBe(`Type \`[c](docs/x.md)\` or see [x](${REPO}/blob/v0.2.0/docs/x.md).`);
  });
});

describe('changelog edge cases', () => {
  it('links a stable release to the prerelease before it', () => {
    const text = `## [Unreleased]\n\n- Done.\n\n## [1.0.0-rc.1] - 2026-11-01\n\n- Almost.\n\n[Unreleased]: ${REPO}/compare/v1.0.0-rc.1...HEAD\n`;
    const next = releaseChangelog(text, { version: '1.0.0', date: '2026-11-03', repoUrl: REPO });
    expect(next).toContain(`[1.0.0]: ${REPO}/compare/v1.0.0-rc.1...v1.0.0`);
  });

  it('ignores headings that are not exact versions', () => {
    expect(releasedVersions('## [Unreleased]\n## [v0.9.0]\n## [0.1.0] - 2026-10-29\n')).toEqual(['0.1.0']);
  });

  it('returns an empty Unreleased section, not the link definitions after it', () => {
    expect(changelogSection(`## [Unreleased]\n\n[Unreleased]: ${REPO}/compare/v0.1.0...HEAD\n`, 'Unreleased')).toBe('');
  });
});

describe('planRelease and checkVersions', () => {
  const dirs = ['apps/web'];
  const pkg = (name, version) => `{\n  "name": "${name}",\n  "version": "${version}",\n  "repository": {\n    "url": "git+${REPO}.git"\n  }\n}\n`;
  const files = (v, changelog = CHANGELOG) => ({
    'package.json': pkg('saybeam', v),
    'apps/web/package.json': pkg('@saybeam/web', v),
    'package-lock.json': `${JSON.stringify({ version: v, packages: { '': { version: v }, 'apps/web': { version: v } } }, null, 2)}\n`,
    'relay/Cargo.toml': `[package]\nname = "saybeam-relay"\nversion = "${v}"\n`,
    'relay/Cargo.lock': `[[package]]\nname = "saybeam-relay"\nversion = "${v}"\n`,
    'apps/worker/wrangler.jsonc': `{ "vars": { "APP_VERSION": "${v}" } }\n`,
    'CHANGELOG.md': changelog,
  });

  it('updates every carrier, and the result passes the check', () => {
    const { from, to, changes } = planRelease(files('0.1.0'), { version: 'v0.2.0', date: '2026-11-03', workspaceDirs: dirs });
    expect([from, to]).toEqual(['0.1.0', '0.2.0']);
    const result = checkVersions(changes, { workspaceDirs: dirs, expected: 'v0.2.0' });
    expect(result.problems).toEqual([]);
    expect(result.entries.every((e) => e.version === '0.2.0')).toBe(true);
  });

  it('refuses versions that are not newer, not versions, or carry build metadata', () => {
    expect(() => planRelease(files('0.1.0'), { version: '0.1.0', date: '2026-11-03', workspaceDirs: dirs })).toThrow(/not newer/);
    expect(() => planRelease(files('0.1.0'), { version: 'next', date: '2026-11-03', workspaceDirs: dirs })).toThrow(/not a semantic version/);
    expect(() => planRelease(files('0.1.0'), { version: '0.2.0+build.5', date: '2026-11-03', workspaceDirs: dirs })).toThrow(/build metadata/);
  });

  it('reports a changelog without the section or links for the version', () => {
    const { problems } = checkVersions(files('0.2.0'), { workspaceDirs: dirs });
    expect(problems).toEqual(['CHANGELOG.md: no "## [0.2.0]" section', 'CHANGELOG.md: the [Unreleased] link does not compare v0.2.0...HEAD', 'CHANGELOG.md: no "[0.2.0]:" link']);
  });

  it('reports every disagreeing field and a tag mismatch', () => {
    const mixed = { ...files('0.1.0'), 'relay/Cargo.toml': '[package]\nname = "saybeam-relay"\nversion = "0.0.9"\n' };
    const { problems } = checkVersions(mixed, { workspaceDirs: dirs, expected: 'v0.2.0' });
    expect(problems).toEqual(['relay/Cargo.toml ([package] version) is 0.0.9, expected 0.1.0', 'the tag says 0.2.0, but the files say 0.1.0']);
  });

  it('reports a missing file', () => {
    const { 'relay/Cargo.lock': _omitted, ...rest } = files('0.1.0');
    expect(() => checkVersions(rest, { workspaceDirs: dirs })).toThrow(/Cargo.lock is missing/);
  });
});

// The command lines, on paths that fail before writing anything (so the repository is never changed).
describe('command lines', () => {
  const scripts = fileURLToPath(new URL('..', import.meta.url));
  const run = (script, ...args) => spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } });

  it.each([
    [['--bogus'], /Unknown option --bogus/],
    [['0.9.0', '--date'], /--date must be a real date/],
    [['0.9.0', '--date', '2026-02-30'], /--date must be a real date/],
    [['next'], /not a semantic version/],
    [['0.9.0', '1.0.0'], /Only one version/],
    [['--check', 'v1', 'v2'], /at most one version/],
    [['--check', 'v0.0.1'], /Tag the release commit instead|Versions disagree/],
  ])('release.mjs %j fails', (args, message) => {
    const result = run('release.mjs', ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
  });

  it('release.mjs --help prints the usage', () => {
    const result = run('release.mjs', '--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/--check/);
  });

  it('changelog-section.mjs prints a released section, and fails for a missing one', () => {
    const ok = run('changelog-section.mjs', 'v0.1.0');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^### Added$/m);
    expect(ok.stdout).not.toMatch(/^## /m);
    expect(ok.stdout).not.toMatch(/^\[Unreleased\]:/m);
    const missing = run('changelog-section.mjs', '9.9.9');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/no "## \[9\.9\.9\]" section/);
  });
});
