# CI and CD

This page is for maintainers. It lists every GitHub Actions workflow, what starts it, what it checks or publishes, and the repository settings it needs. The last section shows how to run the same checks on your own computer.

How to cut a release is in [releasing.md](releasing.md).

## The workflows at a glance

| Workflow (file)                                                                               | Starts on                                             | What it does                                                                                   | Publishes                                    |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **CI** ([`ci.yml`](../.github/workflows/ci.yml))                                              | Every pull request, every push to `main`              | Lint, version check, type check, unit tests, web build, relay checks, conformance, end-to-end  | Nothing (build artifacts for 7 days)         |
| **CodeQL** ([`codeql.yml`](../.github/workflows/codeql.yml))                                  | Pull requests, pushes to `main`, Mondays at 04:23 UTC | Code scanning of TypeScript and JavaScript, Rust, and the workflows                            | Alerts in the Security tab                   |
| **Dependency review** ([`dependency-review.yml`](../.github/workflows/dependency-review.yml)) | Pull requests                                         | Fails if a pull request adds a dependency with a known vulnerability (moderate or worse)       | A report in the job summary                  |
| **Release** ([`release.yml`](../.github/workflows/release.yml))                               | A pushed `v*` tag; by hand for a dry run              | Checks versions, builds the web app, relay and Docker image, creates the GitHub release        | GitHub release, `ghcr.io/byjoellobo/saybeam` |
| **Deploy** ([`deploy.yml`](../.github/workflows/deploy.yml))                                  | A published release (started by Release); by hand     | Builds the web app and deploys the Worker to Cloudflare                                        | The production Worker                        |
| Dependabot ([`dependabot.yml`](../.github/dependabot.yml))                                    | Weekly                                                | Pull requests for npm, Cargo and GitHub Actions updates, minor and patch grouped per ecosystem | Pull requests                                |

### CI

Four jobs. The two later ones reuse the web build from the first.

- **Web app:** `npm ci`, `npm run lint` (Biome), `npm run version:check`, `npm run typecheck`, `npm run test:coverage` (fails below the thresholds in `vitest.config.ts`), `npm run build`.
- **LAN relay:** `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test`, all with `--locked`.
- **Protocol conformance:** starts `wrangler dev` (port 8787) and the release build of the relay (port 7300), then runs `scripts/conformance.mjs` against both. This is what keeps the two servers identical.
- **End-to-end tests:** Playwright in Chromium (`npm run e2e`), including the axe accessibility checks. On failure, the report is kept as an artifact for 14 days.

A new push to a pull request cancels its older CI runs. Runs on `main` always finish.

### CodeQL

Three analyses, each without a build (`build-mode: none`):

- `javascript-typescript`: the web app, Worker, protocol package and scripts.
- `rust`: the relay. Rust has been generally available in CodeQL since version 2.23.3 (October 2025).
- `actions`: the workflow files themselves, for problems such as script injection or excessive permissions.

Alerts appear under **Security**, **Code scanning**, and as checks on pull requests. This is CodeQL "advanced setup", so keep **default setup** turned off in the repository settings. The two cannot run side by side.

### Dependency review

Compares the dependencies of a pull request with its base branch: npm (`package-lock.json`), Cargo (`relay/Cargo.lock`) and the actions used by the workflows. It fails when a new or changed dependency has a known vulnerability of moderate severity or worse. The job summary also lists licenses: check them against the rules in [CONTRIBUTING.md](../CONTRIBUTING.md#license), because the workflow does not enforce a license list.

It needs the dependency graph, which is on by default for public repositories.

### Release

Starts when a `v*` tag is pushed. Jobs, in order:

1. **Check versions:** `node scripts/release.mjs --check vX.Y.Z` fails unless the tag, every `package.json`, `package-lock.json`, `relay/Cargo.toml`, `relay/Cargo.lock`, `vars.APP_VERSION` in `apps/worker/wrangler.jsonc` and `CHANGELOG.md` all agree. It also fails if the tagged commit is not on `main`. Then `node scripts/changelog-section.mjs` extracts the release notes.
2. **Web app:** builds `apps/web/dist` (with `SAYBEAM_SOURCE_URL` set to this repository) and zips it, with `LICENSE` and `THIRD_PARTY_NOTICES.md`, as `saybeam-web-<version>.zip`.
3. **Relay:** builds `saybeam-relay-<version>-<target>` with the web app embedded, for `x86_64-pc-windows-msvc` (`.zip`), `x86_64-unknown-linux-gnu` (built on Ubuntu 22.04 for an older glibc), `aarch64-apple-darwin` and `x86_64-apple-darwin` (`.tar.gz`). Each archive holds the binary, `relay/README.md`, `LICENSE` and `THIRD_PARTY_LICENSES.md`.
4. **Docker image:** builds the [`Dockerfile`](../Dockerfile) for `linux/amd64` and pushes `ghcr.io/byjoellobo/saybeam` with the tags `X.Y.Z`, `X.Y` and `latest`. A prerelease such as `0.3.0-rc.1` gets only its own tag.
5. **Checksums:** writes `SHA256SUMS` for every archive.
6. **Publish GitHub release:** creates [build provenance attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations) for the archives, then the release itself. Its notes are the `CHANGELOG.md` section, followed by GitHub's list of merged pull requests, grouped by the categories in [`.github/release.yml`](../.github/release.yml). Tags with a `-` become prereleases. If the release already exists (a re-run), only its files are replaced.
7. **Start the Cloudflare deploy:** runs `deploy.yml` on the tag. This step exists because a release created with the workflow's own token does not trigger other workflows, so `release: published` would never fire. Prereleases are not deployed.

**Dry run:** open **Actions**, **Release**, **Run workflow**. Everything is built, the archives and `SHA256SUMS` are kept as the `release-bundle` artifact for 7 days, and the image is pushed with a `sha-<commit>` tag only. Nothing is released or deployed, even when you choose a tag. Archive names use `dev-<commit>` instead of a version.

### Deploy

Builds the web app and deploys the Worker, with the app as its static assets. It runs the two halves of `npm run deploy` as separate steps (`npm run build`, then `npm run deploy -w @saybeam/worker`), so only the Wrangler step sees the Cloudflare token. Starts when a release is published (normally by the Release workflow, see above), or by hand: **Actions**, **Deploy**, **Run workflow**, then choose the branch or tag under **Use workflow from**. Prereleases published by hand are skipped; run the workflow by hand to deploy one.

- Runs in the `production` environment, one deploy at a time.
- Sets `SAYBEAM_SOURCE_URL` to this repository, for the app's "Source code" link.
- Runs `scripts/release.mjs --check` first (with the tag, for releases).
- After deploying, reads `/api/info` on the `workers.dev` address and fails if it does not report the new version within 2 minutes. Without a `workers.dev` address in Wrangler's output (for example, only a custom domain), this check is skipped.
- **Without `CLOUDFLARE_API_TOKEN`, the job finishes successfully with a "Deploy skipped" notice** and deploys nothing. Forks and new clones are not broken by it. The job still shows up as a (successful) deployment of the `production` environment.

## How the workflows are kept safe

- **Every third-party action is pinned to a full commit SHA**, with the version in a comment (`uses: actions/checkout@3d3c42e... # v7.0.1`). Dependabot's `github-actions` updates move the SHA and the comment together.
- **`permissions: contents: read`** at the top of every workflow. Jobs that need more ask for it, and only that job gets it: `packages: write` (Docker), `contents: write`, `id-token: write` and `attestations: write` (publishing the release), `actions: write` (starting the deploy), `security-events: write` (CodeQL).
- **`persist-credentials: false`** on every checkout, so the token is not left in `.git/config` for later steps.
- **No `pull_request_target`.** Pull requests from forks run with a read-only token and no secrets.
- **Untrusted values are passed through environment variables**, never pasted into scripts with `${{ }}`. The tag is validated as a semantic version before anything uses it.
- **Release jobs never cancel each other**, and only a pushed tag on a commit that is on `main` can publish.
- **Secrets reach only the step that needs them:** the Cloudflare token is not present while dependencies are installed or the app is built.

### Pinning a new action

Look up the commit behind a release tag. Annotated tags point to a tag object, which has to be dereferenced once more:

```bash
gh api repos/OWNER/REPO/git/ref/tags/v1.2.3 --jq '.object.type + " " + .object.sha'
# "commit <sha>": use that sha.
# "tag <sha>":    dereference it:
gh api repos/OWNER/REPO/git/tags/<sha> --jq '.object.sha'
```

Then write `uses: OWNER/REPO@<40-character sha> # v1.2.3`.

## Secrets and settings

### Secrets

| Secret                  | Where                        | Used by      | Needed?                                                          |
| ----------------------- | ---------------------------- | ------------ | ---------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | The `production` environment | `deploy.yml` | Only to deploy. Without it, the deploy is skipped with a notice. |
| `CLOUDFLARE_ACCOUNT_ID` | The `production` environment | `deploy.yml` | Together with the token.                                         |

Everything else uses the automatic `GITHUB_TOKEN`. Repository-level secrets with the same names also work, but environment secrets are only handed to jobs that use the environment, which is safer.

To create the Cloudflare token: in the Cloudflare dashboard, open **My Profile**, **API Tokens**, **Create Token**, and use the **Edit Cloudflare Workers** template, limited to your account. The account ID is shown on the **Workers & Pages** overview page.

On a brand-new Cloudflare account, choose a `workers.dev` subdomain in the dashboard (or deploy once from your computer with `npm run deploy`) before the first automated deploy. Wrangler cannot ask for it in CI. Also check that the rate limit `namespace_id`s in `apps/worker/wrangler.jsonc` are unique in your account ([deploy.md](deploy.md#rate-limits)).

### One-time repository settings

Do these after creating the repository on GitHub, before pushing the first release tag.

1. **The `production` environment.** **Settings**, **Environments**, **New environment**, name it `production`. Add the two secrets above. Under **Deployment branches and tags**, choose **Selected branches and tags** and allow the tag pattern `v*` (and `main`, if you want to deploy it by hand). Optionally add yourself as a required reviewer, so every deploy waits for approval.
2. **Private vulnerability reporting.** **Settings**, **Code security** (called **Security & analysis** on some accounts), turn on **Private vulnerability reporting**. [SECURITY.md](../SECURITY.md) tells reporters to use it. While there, turn on **Dependabot alerts** and **Dependabot security updates**, and leave CodeQL **default setup** off.
3. **GitHub Container Registry visibility.** The first Release run creates the `saybeam` package, and new packages are private. Open your profile, **Packages**, **saybeam**, **Package settings**, and under **Danger Zone** choose **Change visibility**, **Public**. Check that the package is linked to this repository (the image's `org.opencontainers.image.source` label does this) and that the repository has write access under **Manage Actions access**.
4. **Workflow permissions.** **Settings**, **Actions**, **General**: keep the default `GITHUB_TOKEN` permission at **Read repository contents and packages permissions**. The workflows ask for anything more themselves.
5. **Recommended: protect `main` and the tags.** A ruleset for `main` that requires the CI, CodeQL and dependency review checks, and a tag ruleset for `v*` so only maintainers can create release tags.

Contributions need a DCO sign-off ([CONTRIBUTING.md](../CONTRIBUTING.md#sign-your-commits-dco)). No workflow checks it yet; a DCO GitHub App can, if you want it enforced.

## Running the same checks locally

From the repository root, after `npm ci`:

```bash
npm run lint                 # Biome (CI: Web app)
npm run version:check        # every version field and CHANGELOG.md agree
npm run typecheck
npm run test:coverage        # unit tests with the coverage thresholds
npm run build                # apps/web/dist
```

The relay (needs Rust stable):

```bash
cargo fmt --manifest-path relay/Cargo.toml --check
cargo clippy --manifest-path relay/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path relay/Cargo.toml --locked
```

Protocol conformance, with both servers running (see [CONTRIBUTING.md](../CONTRIBUTING.md#the-golden-rule-one-protocol-two-servers)):

```bash
npm run conformance -- http://127.0.0.1:8787   # wrangler dev
npm run conformance -- http://127.0.0.1:7300   # the relay
```

End-to-end tests (install Chromium once with `npx playwright install --with-deps chromium`):

```bash
npm run e2e
```

Release pieces:

```bash
node scripts/release.mjs 0.3.0 --dry-run      # what a release would change
node scripts/changelog-section.mjs 0.2.0      # the notes a release would get
docker build -t saybeam .                     # the Docker image
```

To lint the workflow files, [actionlint](https://github.com/rhysd/actionlint) works well if you have it: run `actionlint` in the repository root.

## When something fails

- **"Versions disagree" in CI or Release.** Someone changed a version by hand, or tagged the wrong commit. `npm run version:check` shows which file is off. Use `npm run release` to change versions.
- **"Deploy skipped" notice.** `CLOUDFLARE_API_TOKEN` is not set for the `production` environment, or the job did not use that environment. See [Secrets](#secrets).
- **Deploy waits forever.** The `production` environment has a required reviewer: approve it in the run. Or the ref is not allowed by the environment's deployment branch and tag rules.
- **Docker push denied.** The package is not linked to this repository, or the repository lacks write access to it. See setting 3.
- **The release exists but has no deploy.** Check the **Start the Cloudflare deploy** job in the Release run, or run **Deploy** by hand on the tag.
