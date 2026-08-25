# AGENTS.md — Stoat for Desktop (s0ckz fork)

Working agreement for this fork. Read this before making any change.

## Where to contribute

| Change | Repo | Branch to base on and PR into |
| --- | --- | --- |
| Web client (all UI) | `s0ckz/for-web` | `feat/self-hosted-tweaks` |
| Desktop shell (Electron/native) | `s0ckz/for-desktop` | `feat/windows-per-app-audio` |

**`main` is not our trunk in either repo.** It tracks the upstream project
(`stoatchat/*`). Basing work on `main` produces a branch that is missing all of our
fork's changes — and a PR that cannot be merged cleanly.

For this repo, the trunk is **`feat/windows-per-app-audio`**.

## Rules

### 1. Nothing lands on the trunk without a PR

Never commit directly to `feat/windows-per-app-audio`, and never merge into it locally
and push. Every change — including docs and one-line fixes — goes through a pull request
targeting that branch, so it can be reviewed before it reaches a build.

### 2. Always branch from an up-to-date trunk

Fetch first, every time. A branch cut from a stale local copy silently drifts and turns
into conflicts or a wrong-base PR later.

```bash
git fetch origin
git checkout -b <type>/<short-description> origin/feat/windows-per-app-audio
```

Use `origin/feat/windows-per-app-audio` as the start point directly — don't check out a
local trunk branch and hope it's current.

### 3. Keep long-running branches current

If a branch has been open for more than a day, bring it up to date before pushing again:

```bash
git fetch origin
git rebase origin/feat/windows-per-app-audio
```

### 4. Before you start, verify your base

```bash
git fetch origin
git merge-base --is-ancestor origin/feat/windows-per-app-audio HEAD \
  && echo "base OK" || echo "STALE — rebase before continuing"
```

## Which repo does a bug belong to?

The desktop app **does not bundle the UI**. It opens a `BrowserWindow` pointed at a
hosted web client (`src/native/window.ts`, `getBuildUrl()`), so:

- **Anything the user sees or clicks → `for-web`.** Editing this repo cannot change it.
- **This repo owns only:** window chrome and lifecycle, tray, taskbar badges, Discord
  RPC, the screen-share source picker, per-app audio capture, the virtual mic, auto-launch
  and auto-update.

The two sides meet at exactly one bridge — `contextBridge` in `src/world/window.ts` and
`src/world/config.ts`, exposing `window.native` and `window.desktopConfig`. A bug that
spans both apps almost always lives there.

To run the shell against a local web client:

```bash
pnpm start -- --force-server http://localhost:5173
```

Without `--force-server` you are testing the deployed client, not your changes.

## Conventions

- **Conventional commits are required.** release-please derives versions from them:
  `fix:` → patch, `feat:` → minor, `chore:`/`docs:` → no release. A PR title that fails
  the `validate-pr-title` check will block the merge.
- **Do not hand-edit `package.json`'s `version` or `.release-please-manifest.json`** —
  release-please owns both. Editing them fights the automation.
- **pnpm only.** If a `package-lock.json` appears, delete it.
- Toolchain and tasks come from **mise** (`mise dev`, `mise build`, `mise make`).

## Security note

`ipcMain.on("config")` in `src/native/config.ts` enforces an explicit
`RENDERER_WRITABLE_KEYS` allowlist. The renderer is a **remote page**, so anything it can
write is attacker-writable if the web client is ever compromised. Do not add a key to
that list without deciding, deliberately, that remote JavaScript may set it. In
particular the persisted `server` value is main-process-only by design — it is read via
`getPersistedServer()` and is deliberately absent from `DesktopConfig` and `sync()`.
