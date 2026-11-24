// semantic-release: every push to `main` that passes CI is analysed, and if it
// contains a releasable Conventional Commit a `vX.Y.Z` tag and GitHub Release
// are created. .github/workflows/release.yml then moves the major tag (`v1`).
//
// fix: / perf: / revert:   -> patch
// feat:                     -> minor
// `!` or BREAKING CHANGE:   -> major (new `vN` tag; `v1` users are not moved)
// anything else (docs:, ci:, chore:, test:, ...) -> no release
//
// The action runs from the committed dist/ at the tagged commit, so nothing is
// built or committed back here; the tag is the version.

/** @type {import('semantic-release').GlobalConfig} */
const config = {
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        releaseRules: [
          { type: "perf", release: "patch" },
          { type: "revert", release: "patch" },
        ],
      },
    ],
    ["@semantic-release/release-notes-generator", { preset: "conventionalcommits" }],
    "@semantic-release/github",
  ],
};

export default config;
