<div align="center">
<h1>
  Stoat for Desktop
  
  [![Stars](https://img.shields.io/github/stars/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/stargazers)
  [![Forks](https://img.shields.io/github/forks/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/network/members)
  [![Pull Requests](https://img.shields.io/github/issues-pr/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/pulls)
  [![Issues](https://img.shields.io/github/issues/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/issues)
  [![Contributors](https://img.shields.io/github/contributors/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/graphs/contributors)
  [![License](https://img.shields.io/github/license/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/blob/main/LICENSE)
</h1>
Application for Windows, macOS, and Linux.
</div>
<br/>

## Installation

<a href="https://repology.org/project/stoat-desktop/versions">
    <img src="https://repology.org/badge/vertical-allrepos/stoat-desktop.svg" alt="Packaging status" align="right">
</a>

- All downloads and instructions for Stoat can be found on our [Website](https://stoat.chat/download).

## Releases & Auto-Update

Releases are cut automatically by [`win-app-audio.yml`](.github/workflows/win-app-audio.yml) on every push to `main`. It looks at the commits since the last `v[0-9]*` tag and applies [release-please](https://github.com/googleapis/release-please)'s own bump rule to their subjects: any `feat:` bumps minor, else any `fix:`/`perf:`/`revert:` bumps patch, else (only `chore:`/`docs:`/`ci:`/`style:`/`test:`/`refactor:`) nothing is released. A `!` before the colon, or a `BREAKING CHANGE:`/`BREAKING-CHANGE:` footer at the start of a line, forces a major bump regardless.

**`main`'s current version is read from the latest `v<version>` git tag, not from `package.json`.** When a release is warranted, the workflow writes the new version into `package.json` *in the CI runner's working tree only* — it is never committed, and nothing is ever pushed to `main` — then tags and pushes `v<version>`, and only *after* that builds from that bumped source and publishes a real GitHub release (not a pre-release) containing the full Squirrel output (`RELEASES`, the `*-full.nupkg`, and `Setup.exe`) — no portable `.zip` is included in a versioned release; see below. **`package.json` on `main` is consequently stale by design and does not reflect the released version** — do not read it as one. The `v<version>` tags are the only durable record of what has actually shipped, and every release is computed from the latest one.

This is a deliberate change from an earlier version of this workflow, which *did* commit the bump (as `chore(release): v<version>`) and push it straight to `main`. `main` carries a repository ruleset requiring changes to go through a pull request, and that direct push was rejected by it (GitHub error `GH013`) on this workflow's first two real release-worthy runs. The clean fix — adding the `github-actions` app to the ruleset's bypass list — needs the repo owner and was not adopted, so the workflow stopped pushing to `main` at all rather than continuing to fail against a rule that was never going to open for it. If that bypass is ever added later, restoring the commit-and-push is possible but not a small change — the version this replaced also deleted a 5-attempt fetch/rebase retry loop and its branch-ruleset GH013 detection, both needed only because a direct push races a `main` that can move underneath it, so reverting means rewriting that from scratch. Reading the current version from the latest tag rather than `package.json` should stay either way — it isn't something this change should undo, since the tag is the one record that can't silently stop advancing.

If a build or publish step fails *after* the version's tag has already been pushed, the workflow deletes that `v<version>` tag so there's never a tag without a matching release. There is no version-bump commit to worry about cleaning up on `main` in this case any more — nothing is ever committed there.

If instead the tag push itself never lands, the workflow does not abort. It restores `package.json` to its pre-bump state in the runner's working tree and still builds and republishes the rolling `win-per-app-audio` pre-release below from that unbumped source, exactly as it would on a push that never warranted a release at all. The run still ends red on purpose, because a release that was due and silently didn't happen needs to be noticed — check the last step's log for the actual cause rather than assuming the rolling build failed too. (The likeliest cause is a plain "tag already exists" rejection, not a ruleset — no tag-protection ruleset is known to exist on this repo, and both real `GH013` failures hit here so far were on the branch ruleset governing `main`, not a tag ruleset; see the workflow's own comments for how it tells the two apart.)

`CHANGELOG.md` and `release-please-config.json`/`.release-please-manifest.json` are left over from when this repo ran the actual [release-please](https://github.com/googleapis/release-please) GitHub Action; that workflow was removed, so nothing updates `CHANGELOG.md` anymore. `win-app-audio.yml` no longer writes to `.release-please-manifest.json` either — with no commit ever landing on `main`, doing so would be a pure no-op, so that step was removed along with the branch push. The manifest file (and `release-please-config.json`) now sit entirely unused.

Two things to know about how updates actually reach users:

- **Auto-update only works for the `Setup.exe` install.** The app uses Squirrel.Windows for updates, and Squirrel only knows how to patch an install it made itself. The portable `.zip` build (only ever produced by the rolling pre-release below, not by a versioned release) has no updater wired into it at all -- it has to be re-downloaded by hand for a new version.
- **The rolling `win-per-app-audio` build is not, and cannot be, an update source.** It publishes a "latest main build" download on a fixed tag for testing, and it's deliberately marked as a pre-release so it doesn't fight with real releases for that tag name. `update.electronjs.org` (what the app's auto-updater talks to) only ever serves the latest release that is *both* semver-tagged *and* not a pre-release, so it ignores that build entirely -- by design, not by accident.

## Development Guide

_Contribution guidelines for Desktop app TBA!_

<!-- Before contributing, make yourself familiar with [our contribution guidelines](https://developers.revolt.chat/contrib.html), the [code style guidelines](./GUIDELINES.md), and the [technical documentation for this project](https://revoltchat.github.io/frontend/). -->

Before getting started, you'll want to install:

- [Git](https://git-scm.com/install/)
- [mise-en-place](https://mise.jdx.dev/getting-started.html)

Then proceed to setup:

```bash
# clone the repository
git clone --recursive https://github.com/stoatchat/for-desktop stoat-for-desktop
cd stoat-for-desktop

# Install tools from mise
mise install

# install all packages
mise install:frozen

# start the application
mise dev
# ... or build the bundle
mise build
# ... or build all distributables
mise make
```

Various useful commands for development testing:

```bash
# connect to the development server
mise exec -- pnpm start -- --force-server http://localhost:5173

# test the flatpak (after `make`)
mise exec -- pnpm install:flatpak
mise exec -- pnpm run:flatpak
# ... also connect to dev server like so:
mise exec -- pnpm run:flatpak --force-server http://localhost:5173

# Nix-specific instructions for testing
pnpm package
pnpm run:nix
# ... as before:
pnpm run:nix --force-server=http://localhost:5173
# a better solution would be telling
# Electron Forge where system Electron is
```

### Pulling in Stoat's assets

If you want to pull in Stoat brand assets after pulling, run the following:

```bash
# update the assets
mise assets
```

Currently, this is required to build, any forks are expected to provide their own assets.
