# For cloud sessions: read this first

This file is for Claude Code cloud sessions only. Local work on the owner's PC never loads it.

## House rules

- Work on a new branch and end with one pull request. Never push to `main`, never merge.
- Never ship, release, publish or deploy anything. Shipping happens on the owner's PC after the
  pull request is merged there, with the GPU checks this machine cannot run.
- No em dashes or en dashes in anything you write: code, comments, docs, commit messages. Use a
  comma or a new sentence.
- Stay inside the task you were given. No extra features, no cleanups nobody asked for.
- Anything that is the owner's call (how something should look or feel, what a feature should do)
  becomes a question in the pull request, never a guess.
- The pull request description is in plain words: what changed, how it was checked (each command
  and its exit code), and what needs a check on the owner's PC.

## What runs here, and what never does

This is a Windows Electron app. This machine is Linux with no GPU.

Runs here:

```bash
npm ci
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p tsconfig.electron.json
npx eslint .
npx vitest run
npx vite build
```

`npm ci` needs `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, set on the cloud environment.

Never run here: `npx playwright test` (several specs are timing and GPU sensitive and lie on
software rendering), anything under `_verify/`, `npm run dist`, `npm run dist:dir`,
`npm run patch`, `npm run release`, `npm run verify:ffmpeg`. List anything that needs them under
"needs a local check" in the pull request.
