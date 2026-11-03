# Releasing Saybeam

This page is for maintainers. It covers how Saybeam is versioned, the steps to cut a release, what the workflows do after you push the tag, and how to fix a release that went wrong.

The workflows themselves, and the settings they need, are described in [ci-cd.md](ci-cd.md).

## Versions

Saybeam follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), with one version for the whole project. The same `X.Y.Z` is used by:

- the root `package.json`, every workspace `package.json` (`@saybeam/protocol`, `@saybeam/web`, `@saybeam/worker`) and their entries in `package-lock.json`;
- the relay crate (`relay/Cargo.toml` and its entry in `relay/Cargo.lock`), which the relay prints at startup and reports in `/api/info`;
- `vars.APP_VERSION` in `apps/worker/wrangler.jsonc`, which the cloud Worker reports in `/api/info`;
- the git tag `vX.Y.Z`, the GitHub release and the Docker image tags.

`npm run release` changes all of them at once, and `npm run version:check` (run by CI) fails if they ever disagree.

### What the numbers mean

- **While the version is 0.x**, a minor release (0.2.0 to 0.3.0) may include breaking changes. A patch release (0.2.0 to 0.2.1) only fixes things and never breaks anything.
- **From 1.0.0 on**, breaking changes need a new major version.
- **Breaking** means something a user or self-hoster has to act on: a relay flag or Docker default that changed, a `wrangler.jsonc` setting they must edit, a removed feature, a changed export format, or saved rooms and settings that are lost. List these first in the changelog section.
- **Prereleases** such as `0.3.0-rc.1` become GitHub prereleases. The Docker image gets only the `0.3.0-rc.1` tag (not `latest` or `0.3`), and nothing is deployed automatically.

### The wire protocol has its own version

The protocol between the app and the servers has a separate version: the heading of [protocol.md](protocol.md) ("v1") and the `v` field that clients send when they join. It only changes when clients and servers would stop understanding each other, and then [protocol.md](protocol.md), `packages/protocol` and the Rust relay change together (see [CONTRIBUTING.md](../CONTRIBUTING.md#the-golden-rule-one-protocol-two-servers)). An app release does not change the protocol version, and a protocol change is always a breaking change for the app version.

## Cutting a release

Before you start:

- Everything for the release is on `main`, and CI is green.
- The `## [Unreleased]` section of [CHANGELOG.md](../CHANGELOG.md) lists every user-visible change, under **Added**, **Changed**, **Fixed** or **Security**. Write for the people who use Saybeam, not for developers.
- The [one-time repository settings](ci-cd.md#one-time-repository-settings) are done (only needed before the first release).

The steps, for example for 0.3.0:

1. **Start from an up-to-date `main`.**

   ```bash
   git switch main
   git pull --ff-only
   ```

2. **Set the version.** Try a dry run first, then the real thing:

   ```bash
   npm run release -- 0.3.0 --dry-run
   npm run release -- 0.3.0
   ```

   This sets the version in every file listed under [Versions](#versions), and turns `## [Unreleased]` into `## [0.3.0] - <today>` under a new, empty `## [Unreleased]`. It also updates the compare links at the bottom of the changelog. `--date YYYY-MM-DD` sets a different release date. It refuses to run if the version is not newer than the current one, if the changelog already has that version, or if the Unreleased section is empty.

3. **Review.** Read `git diff`, polish the new changelog section if needed, and confirm:

   ```bash
   npm run version:check
   ```

4. **Commit, signed off**, with only the release changes. The script prints the exact `git add` line:

   ```bash
   git add package.json package-lock.json apps/*/package.json packages/*/package.json relay/Cargo.toml relay/Cargo.lock apps/worker/wrangler.jsonc CHANGELOG.md
   git commit -s -m "chore(release): v0.3.0"
   ```

5. **Push the commit and wait for CI to pass on it.**

   ```bash
   git push origin main
   ```

   If `main` only accepts pull requests, push a branch such as `release/v0.3.0`, open a pull request, and merge it. Then tag the commit that landed on `main` in the next step.

6. **Tag and push the tag.** Use an annotated tag (`git tag -s` instead of `-a` if you sign tags):

   ```bash
   git tag -a v0.3.0 -m "Saybeam v0.3.0"
   git push origin v0.3.0
   ```

Pushing the tag starts the **Release** workflow. Follow it under **Actions**.

## What the workflows do next

The **Release** workflow ([details](ci-cd.md#release)):

1. Checks that the tag matches every version field and the changelog, and that the tagged commit is on `main`. If not, it stops before building anything.
2. Builds and publishes, as assets of the GitHub release `v0.3.0`:
   - `saybeam-relay-0.3.0-x86_64-pc-windows-msvc.zip`
   - `saybeam-relay-0.3.0-x86_64-unknown-linux-gnu.tar.gz`
   - `saybeam-relay-0.3.0-aarch64-apple-darwin.tar.gz`
   - `saybeam-relay-0.3.0-x86_64-apple-darwin.tar.gz`
   - `saybeam-web-0.3.0.zip`, the built web app
   - `SHA256SUMS`
3. Records build provenance attestations for the archives, so anyone can check where they came from:

   ```bash
   gh attestation verify saybeam-relay-0.3.0-x86_64-unknown-linux-gnu.tar.gz --repo byjoellobo/saybeam
   ```

4. Pushes the Docker image `ghcr.io/byjoellobo/saybeam` as `0.3.0`, `0.3` and `latest`.
5. Uses the changelog section (`node scripts/changelog-section.mjs 0.3.0`) as the release notes, followed by GitHub's list of merged pull requests.
6. Starts the **Deploy** workflow on the tag, which deploys the Worker and the web app to Cloudflare. Without Cloudflare credentials, the deploy is skipped with a notice.

Afterwards, check:

- the release page: notes, the six files, and the attestations;
- `docker pull ghcr.io/byjoellobo/saybeam:0.3.0`;
- `/api/info` on the cloud deployment reports `"version":"0.3.0"` (the Deploy workflow checks this on the `workers.dev` address).

## The first public release

The repository starts with two versions: 0.1.0 (29 October 2026) and 0.2.0 (3 November 2026). `v0.1.0` goes on the first commit and `v0.2.0` on the release commit.

- The first commit has no workflow files, so pushing `v0.1.0` builds nothing and creates no GitHub release. That is expected. If you want a release page for 0.1.0, create it by hand after pushing the tag:

  ```bash
  node scripts/changelog-section.mjs 0.1.0 > notes-0.1.0.md
  gh release create v0.1.0 --verify-tag --title "Saybeam v0.1.0" --notes-file notes-0.1.0.md
  ```

  A `release` event runs the workflows of the tagged commit, which has none, so this deploys nothing.

- Push `main` first, then the tags one at a time. GitHub does not start workflows for tags when more than three are pushed at once.
- Do the [one-time repository settings](ci-cd.md#one-time-repository-settings) before pushing `v0.2.0`, and make the container package public after its Release run.

## Fixing a bad release

**Never move or reuse a tag that has been published.** Downloads, checksums, attestations and Docker caches already refer to it. Fix forward with a new patch release instead. The one exception is below: a tag whose Release run published nothing at all.

### The Release workflow failed

- **At "Check versions"**: nothing was built or published. Usually the tag is on the wrong commit (one that is not on `main`, or not the release commit), or the versions were not set. Delete the tag, fix the cause, and tag again:

  ```bash
  git push --delete origin v0.3.0
  git tag -d v0.3.0
  ```

- **During a build, for a passing reason** (a network error, a runner problem): open the run and choose **Re-run failed jobs**.
- **During a build, because of the code**: if the Docker and Publish jobs did not run, nothing was published, so you may delete the tag as above, fix `main`, and tag the fixed commit. If the image was already pushed, leave the tag alone and release 0.3.1 instead.
- **At "Publish GitHub release"**: re-run the failed jobs. If the release was already created, the re-run only replaces its files.

### The notes are wrong

Edit the release on GitHub. Re-runs do not overwrite the notes. Fix `CHANGELOG.md` on `main` as well, so the two agree.

### A broken version was published

1. **Warn people.** Edit the GitHub release and put a short warning at the top of the notes.
2. **Roll back the cloud deployment.** Run the **Deploy** workflow by hand on the previous tag (**Use workflow from**, then the tag), or roll back from your computer with `npx wrangler rollback` in `apps/worker`. If the bad release added a Durable Object migration to `wrangler.jsonc`, a rollback cannot undo it: fix forward instead.
3. **Point `latest` back** at the previous image, if self-hosters may pull it. Log in to `ghcr.io` with a token that can write packages, then:

   ```bash
   docker buildx imagetools create --tag ghcr.io/byjoellobo/saybeam:latest ghcr.io/byjoellobo/saybeam:0.2.0
   ```

4. **Release the fix** as 0.3.1 with the normal steps, and describe the problem under **Fixed** in the changelog.

If the problem is a security issue, follow [SECURITY.md](../SECURITY.md) as well: fix it privately, release, then publish the advisory.

### Deleting a release

Only delete a release if it must disappear, for example because an asset contains something private. Deleting the GitHub release does not delete the tag, the attestations or the Docker image: remove the image version under the package's settings, and the tag with `git push --delete origin vX.Y.Z`. Then release a new version.
