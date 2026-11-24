# Citara Audit

A GitHub Action that audits a deployed site for AI discoverability (`/llms.txt`, crawler access, static parseability, schema.org) and gates your pull requests on the result.

It is a thin client of the Citara scan API, in the same way SonarQube scanners use `SONAR_TOKEN`. The action sends your organization API key and a URL. The service runs the audit and returns the verdict plus a ready-made markdown report. The action contains no audit engine.

## Quick start

1. Create an API key at `<server-url>/account/api-keys`.
2. Store it as a repository secret named `LLMSEO_API_KEY` (Settings, Secrets and variables, Actions).
3. Add a workflow:

```yaml
name: Citara
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # sticky PR comment

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: aiden-buckstone/citara-github-action@v1
        with:
          api-key: ${{ secrets.LLMSEO_API_KEY }}
          url: https://example.com
```

## Inputs

| Input           | Required | Default               | Description                                                                         |
| --------------- | -------- | --------------------- | ----------------------------------------------------------------------------------- |
| `api-key`       | yes      |                       | Organization API key. Store it as a secret.                                         |
| `url`           | yes      |                       | Target URL to audit.                                                                |
| `server-url`    | no       | production service    | Base URL of the scan service.                                                       |
| `min-score`     | no       | `75`                  | Minimum composite score (0-100).                                                    |
| `min-grade`     | no       | `B`                   | Minimum letter grade (A-F).                                                         |
| `site-type`     | no       | `auto`                | `auto`, `saas`, `portfolio`, `docs`, `ecommerce`, `local-business` or `blog-media`. |
| `scope`         | no       | service default       | `site` or `page`.                                                                   |
| `comment-on-pr` | no       | `true`                | Post or update one sticky report comment on the pull request.                       |
| `github-token`  | no       | `${{ github.token }}` | Token used to write the PR comment.                                                 |
| `timeout`       | no       | `10000`               | Per-fetch timeout in ms used by the audit (1000-15000, clamped by the service).     |
| `report-style`  | no       | `technical`           | `technical` or `plain`.                                                             |
| `resolve-links` | no       | `true`                | Verify `llms.txt` links with HEAD requests.                                         |
| `agent-fetch`   | no       | `true`                | Compare a fetch as GPTBot and OAI-SearchBot to expose firewall blocks.              |
| `headers`       | no       |                       | Headers sent to the audited site, one `Name: value` per line.                       |
| `fail-on-error` | no       | `true`                | Fail the job on API or network errors. `false` only warns.                          |

A missed score or grade threshold always fails the job, whatever `fail-on-error` says.

## Outputs

| Output        | Description                             |
| ------------- | --------------------------------------- |
| `score`       | Composite score (0-100).                |
| `grade`       | Composite letter grade (A-F).           |
| `passed`      | `true` when the thresholds were met.    |
| `report-url`  | Link to the full report in the web app. |
| `scan-id`     | Identifier of the recorded scan.        |
| `report-json` | JSON report (reduced on the free plan). |

## Vercel preview example

Pass the protection bypass secret as a header. Its value is masked in logs and sent only to the audited site.

```yaml
on:
  deployment_status:

jobs:
  audit:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: aiden-buckstone/citara-github-action@v1
        with:
          api-key: ${{ secrets.LLMSEO_API_KEY }}
          url: ${{ github.event.deployment_status.target_url }}
          headers: |
            x-vercel-protection-bypass: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

## Pull requests from forks

GitHub does not pass secrets to workflows triggered by pull requests from forks, so `api-key` is empty. On a `pull_request` from a fork the action prints a warning and exits successfully without scanning. In any other event an empty key fails the job.

## Privacy

The action sends the target `url`, your scan settings and any `headers` to the scan service, which fetches the site on your behalf. Header values are used only for that fetch and are not stored or logged by the service. The action masks your API key and header values in workflow logs. Do not audit URLs you are not allowed to share with the service.

## Versioning

Pin `@v1` for compatible updates (the `v1` tag moves with each `v1.x.y` release), or a full tag such as `@v1.0.0` or a commit SHA for reproducibility. Breaking changes ship under a new major version.

Releases are cut automatically. When CI passes on `main`, [semantic-release](https://semantic-release.org) reads the [Conventional Commits](https://www.conventionalcommits.org) since the last tag, publishes the next version as a GitHub Release with generated notes, and moves the major tag to it:

| Commit                                                   | Release |
| -------------------------------------------------------- | ------- |
| `fix:`, `perf:`, `revert:`                               | patch   |
| `feat:`                                                  | minor   |
| `!` after the type, or a `BREAKING CHANGE:` footer       | major   |
| `docs:`, `ci:`, `chore:`, `refactor:`, `test:`, `style:` | none    |

Merge commits are ignored, so the commits on the branch (or the pull request title, when squash merging) must follow the convention. The tag is the version; `package.json` is not updated.

## Development

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
```

`dist/` is committed because GitHub runs it directly. CI fails when it is stale, so run `pnpm build` and commit the result after changing `src/`.

## License

MIT
