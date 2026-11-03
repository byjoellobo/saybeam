/**
 * Pure helpers for CHANGELOG.md in the Keep a Changelog 1.1.0 format:
 *
 *   ## [Unreleased]
 *   ## [1.2.0] - 2026-11-03
 *   ...
 *   [Unreleased]: https://github.com/OWNER/REPO/compare/v1.2.0...HEAD
 *   [1.2.0]: https://github.com/OWNER/REPO/compare/v1.1.0...v1.2.0
 *
 * Used by scripts/release.mjs and scripts/changelog-section.mjs.
 */
import { compareVersions, parseVersion } from './versioning.mjs';

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "## [label]" at the start of a line, with anything after it (such as " - 2026-11-03"). */
const headingRe = (label) => new RegExp(`^## \\[${escapeRegExp(label)}\\][^\\n]*(?:\\n|$)`, 'm');

/** A link reference definition line: "[label]: url". */
const LINK_DEF = /^\[[^\]]+\]:\s*\S+\s*$/;

/**
 * Released versions, newest first, in the order their headings appear.
 * @param {string} text
 * @returns {string[]}
 */
export function releasedVersions(text) {
  // Exact versions only: "[v1.0.0]" is not the Keep a Changelog format and would break the compare links.
  return [...text.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1] ?? '').filter((label) => parseVersion(label)?.version === label);
}

/**
 * The text under "## [label]" up to the next "## " heading, without the trailing
 * link definitions. Null when there is no such heading.
 * @param {string} text
 * @param {string} label a version such as "0.2.0", or "Unreleased"
 * @returns {string | null}
 */
export function changelogSection(text, label) {
  const heading = headingRe(label).exec(text);
  if (!heading) return null;
  const start = heading.index + heading[0].length;
  const rest = text.slice(start);
  const next = /^## /m.exec(rest);
  const lines = (next ? rest.slice(0, next.index) : rest).split('\n');
  // The last section is followed by the link definitions block: leave it out.
  while (lines.length && (lines[lines.length - 1]?.trim() === '' || LINK_DEF.test(lines[lines.length - 1] ?? ''))) lines.pop();
  return lines.join('\n').trim();
}

/**
 * Turns "## [Unreleased]" into "## [version] - date" under a fresh, empty
 * Unreleased heading, and updates the compare links at the bottom.
 * @param {string} text
 * @param {{ version: string, date: string, repoUrl: string }} release
 * @returns {string}
 */
export function releaseChangelog(text, { version, date, repoUrl }) {
  if (!parseVersion(version)) throw new Error(`Not a semantic version: ${version}`);
  const unreleased = headingRe('Unreleased').exec(text);
  if (!unreleased) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
  if (headingRe(version).test(text)) throw new Error(`CHANGELOG.md already has a section for ${version}`);
  if (!changelogSection(text, 'Unreleased')) throw new Error('The [Unreleased] section of CHANGELOG.md is empty: add the changes first');

  const previous = releasedVersions(text)[0];
  if (previous && compareVersions(version, previous) <= 0) throw new Error(`${version} is not newer than the latest release in CHANGELOG.md (${previous})`);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  const withHeading = `${text.slice(0, unreleased.index)}## [Unreleased]\n\n## [${version}] - ${date}\n${text.slice(unreleased.index + unreleased[0].length)}`;

  const unreleasedLink = `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`;
  const versionLink = `[${version}]: ${previous ? `${repoUrl}/compare/v${previous}...v${version}` : `${repoUrl}/releases/tag/v${version}`}`;
  const linkLine = /^\[Unreleased\]:[^\n]*$/m;
  if (linkLine.test(withHeading)) return withHeading.replace(linkLine, () => `${unreleasedLink}\n${versionLink}`);
  return `${withHeading.replace(/\n*$/, '')}\n\n${unreleasedLink}\n${versionLink}\n`;
}

/**
 * Problems that would make the changelog disagree with `version`: a missing
 * section, or compare links that do not point at it.
 * @param {string} text
 * @param {string} version
 * @returns {string[]}
 */
export function changelogProblems(text, version) {
  const problems = [];
  if (!headingRe(version).test(text)) problems.push(`no "## [${version}]" section`);
  if (!new RegExp(`^\\[Unreleased\\]:\\s*\\S+/compare/v${escapeRegExp(version)}\\.\\.\\.HEAD\\s*$`, 'm').test(text)) {
    problems.push(`the [Unreleased] link does not compare v${version}...HEAD`);
  }
  if (!new RegExp(`^\\[${escapeRegExp(version)}\\]:\\s*\\S+`, 'm').test(text)) problems.push(`no "[${version}]:" link`);
  return problems;
}

/**
 * Rewrites relative Markdown link targets ("docs/a.md", "./b.md") as absolute
 * URLs, so they still work in a GitHub release body. Links go to
 * `${repoUrl}/blob/${ref}/...` and images to `${repoUrl}/raw/${ref}/...`.
 * Absolute URLs, "/root" paths, "#anchors" and anything inside `code` are left alone.
 * @param {string} markdown
 * @param {{ repoUrl: string, ref: string }} where for example { repoUrl: "https://github.com/o/r", ref: "v1.2.0" }
 */
export function absolutizeLinks(markdown, { repoUrl, ref }) {
  const repo = repoUrl.replace(/\/+$/, '');
  const rewrite = (text) =>
    text.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (all, bang, label, target, title = '') => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return all;
      return `${bang}[${label}](${repo}/${bang ? 'raw' : 'blob'}/${ref}/${target.replace(/^\.\//, '')}${title})`;
    });
  // Odd-numbered parts are code spans: keep them exactly as written.
  return markdown
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : rewrite(part)))
    .join('');
}
