# Bay Clock Menu Admin Worker

This Worker hosts the private menu admin flow and writes raw menu uploads into the `menu-upload-inbox` branch of `notkainoa/bay-clock-3`.

## What it does

Shell routes:

- `GET /`
- `GET /upload`
- `GET /review`
- `GET /status`

JSON API routes:

- `GET /api/session`
- `POST /api/auth`
- `POST /api/logout`
- `POST /api/confirm-upload`
- `GET /api/run-status?commit=<sha>`

Behavior:

- shared-code auth is stored in a signed `menu_admin_session` cookie
- selecting a file only creates a client-side preview
- GitHub is only written after `Confirm upload`
- uploads are written to `.menu-upload-inbox/upload`
- GitHub Actions status is polled from inside the app

The repo-side workflow at [`update-menu-image.yml`](/Users/knewton26/.t3/worktrees/bay-clock-3/t3code-c52a3698/.github/workflows/update-menu-image.yml) still processes the inbox branch, publishes `public/menu/menu.jpg`, rotates `public/menu/menu_old.jpg`, and pushes the result to `main`.

## Setup

1. `cd cloudflare/menu-admin`
2. `npm install`
3. `npx wrangler whoami`
4. `npx wrangler secret put MENU_UPLOAD_PASSWORD`
5. `npx wrangler secret put SESSION_SIGNING_SECRET`
6. `npx wrangler secret put GITHUB_TOKEN`
7. `npm run deploy`

## Required secrets

- `MENU_UPLOAD_PASSWORD`
- `SESSION_SIGNING_SECRET`
- `GITHUB_TOKEN`

`SESSION_SIGNING_SECRET` signs the `menu_admin_session` cookie with HMAC-SHA256.

Cookie behavior:

- `Trust this browser = true` creates a persistent cookie for 30 days
- `Trust this browser = false` creates a session cookie

The GitHub token must be a fine-grained token with:

- `Contents: Read and write`
- `Actions: Read`

## Worker vars

Configured in [`wrangler.jsonc`](/Users/knewton26/.t3/worktrees/bay-clock-3/t3code-c52a3698/cloudflare/menu-admin/wrangler.jsonc):

- `GITHUB_OWNER=notkainoa`
- `GITHUB_REPO=bay-clock-3`
- `GITHUB_DEFAULT_BRANCH=main`
- `GITHUB_INBOX_BRANCH=menu-upload-inbox`
- `UPLOAD_MAX_BYTES=15728640`

The Worker auto-creates the `menu-upload-inbox` branch from `main` on first confirmed upload if it does not already exist.
