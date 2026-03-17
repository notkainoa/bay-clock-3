# Bay Clock Menu Admin Worker

This Worker hosts the private upload page and writes raw menu uploads into the `menu-upload-inbox` branch of `notkainoa/bay-clock-3`.

## What it does

- `GET /` serves the private admin upload form
- `POST /upload` validates the shared password
- accepted file types: PDF, JPG, JPEG
- uploads are written to `.menu-upload-inbox/upload`

The repo-side workflow at [`update-menu-image.yml`](/Users/knewton26/.t3/worktrees/bay-clock-3/t3code-c52a3698/.github/workflows/update-menu-image.yml) processes the inbox branch, publishes `public/menu/menu.jpg`, rotates `public/menu/menu_old.jpg`, and pushes the result to `main`.

## Setup

1. `cd cloudflare/menu-admin`
2. `npm install`
3. `npx wrangler whoami`
4. `npx wrangler secret put MENU_UPLOAD_PASSWORD`
5. `npx wrangler secret put GITHUB_TOKEN`
6. `npm run deploy`

## Required secrets

- `MENU_UPLOAD_PASSWORD`
- `GITHUB_TOKEN`

The GitHub token should be a fine-grained token with `contents:write` on `notkainoa/bay-clock-3` only.

## Worker vars

Configured in [`wrangler.jsonc`](/Users/knewton26/.t3/worktrees/bay-clock-3/t3code-c52a3698/cloudflare/menu-admin/wrangler.jsonc):

- `GITHUB_OWNER=notkainoa`
- `GITHUB_REPO=bay-clock-3`
- `GITHUB_DEFAULT_BRANCH=main`
- `GITHUB_INBOX_BRANCH=menu-upload-inbox`
- `UPLOAD_MAX_BYTES=15728640`

The Worker auto-creates the `menu-upload-inbox` branch from `main` on first upload if it does not already exist.
