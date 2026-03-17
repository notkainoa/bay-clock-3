const INBOX_DIR = ".menu-upload-inbox";
const UPLOAD_PATH = `${INBOX_DIR}/upload`;
const COOKIE_NAME = "menu_admin_session";
const TRUSTED_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const SESSION_SESSION_MAX_AGE = 60 * 60 * 12;
const ROUTE_PATHS = new Set(["/", "/upload", "/review", "/status"]);
const TRACKED_STEP_STAGES = [
  {
    name: "Process upload into live menu assets",
    stage: "Processing",
  },
  {
    name: "Publish processed assets to main",
    stage: "Publishing",
  },
  {
    name: "Clear processed inbox item",
    stage: "Finalizing",
  },
];

export default {
  async fetch(request, env) {
    try {
      return await routeRequest(request, env);
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : "Unexpected error",
        },
        {
          status: 500,
          headers: noStoreHeaders(),
        },
      );
    }
  },
};

async function routeRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "GET" && ROUTE_PATHS.has(url.pathname)) {
    return new Response(renderPage(env), {
      headers: htmlHeaders(),
    });
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    return handleSession(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/auth") {
    return handleAuth(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    return handleLogout();
  }

  if (request.method === "POST" && url.pathname === "/api/confirm-upload") {
    return handleConfirmUpload(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/run-status") {
    return handleRunStatus(request, env);
  }

  return Response.json({ error: "Not found" }, { status: 404, headers: noStoreHeaders() });
}

async function handleSession(request, env) {
  const session = await getSessionFromRequest(request, env);
  return jsonResponse({
    authenticated: Boolean(session),
    trusted: Boolean(session?.trusted),
    expiresAt: session?.exp || null,
  });
}

async function handleAuth(request, env) {
  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ error: "Expected JSON body" }, { status: 400 });
  }

  const code = asTrimmedString(body.code);
  const trustBrowser = body.trustBrowser === true;

  if (!(await secureEqual(code, getRequiredSecret(env, "MENU_UPLOAD_PASSWORD")))) {
    return jsonResponse({ error: "Invalid access code" }, { status: 401 });
  }

  const cookie = await createSessionCookie(env, trustBrowser);
  return jsonResponse(
    {
      ok: true,
      trusted: trustBrowser,
      expiresAt: cookie.payload.exp,
    },
    {
      headers: {
        "set-cookie": cookie.header,
      },
    },
  );
}

function handleLogout() {
  return jsonResponse(
    { ok: true },
    {
      headers: {
        "set-cookie": clearSessionCookie(),
      },
    },
  );
}

async function handleConfirmUpload(request, env) {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return jsonResponse({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return jsonResponse({ error: "A file upload is required" }, { status: 400 });
  }

  const uploadType = getSupportedExtension(file);
  if (!uploadType) {
    return jsonResponse({ error: "Only PDF and JPG uploads are supported" }, { status: 400 });
  }

  const maxBytes = getUploadMaxBytes(env);
  if (Number.isFinite(maxBytes) && file.size > maxBytes) {
    return jsonResponse(
      {
        error: `Upload exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`,
      },
      { status: 413 },
    );
  }

  const branch = env.GITHUB_INBOX_BRANCH || "menu-upload-inbox";
  await ensureBranchExists(env, branch);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const now = new Date().toISOString();
  const result = await upsertRepoFile(
    env,
    UPLOAD_PATH,
    bytesToBase64(bytes),
    `chore: enqueue menu upload (${now})`,
  );

  return jsonResponse({
    ok: true,
    uploadCommitSha: result.commitSha,
    uploadCommitUrl: result.commitUrl,
    branch,
    path: UPLOAD_PATH,
    type: uploadType,
    workflowRunsUrl: githubActionsUrl(env),
  });
}

async function handleRunStatus(request, env) {
  const session = await getSessionFromRequest(request, env);
  if (!session) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const commit = asTrimmedString(url.searchParams.get("commit"));
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    return jsonResponse({ error: "A valid commit SHA is required" }, { status: 400 });
  }

  const run = await getWorkflowRunForCommit(env, commit);
  if (!run) {
    return jsonResponse({
      ok: true,
      commit,
      stage: "Queued",
      terminal: false,
      run: null,
      detail: "Waiting for GitHub Actions to pick up the upload commit.",
    });
  }

  const jobs = await getWorkflowRunJobs(env, run.id);
  const normalized = normalizeWorkflowStatus(run, jobs);

  return jsonResponse({
    ok: true,
    commit,
    ...normalized,
  });
}

function getSupportedExtension(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();

  if (type === "application/pdf" || name.endsWith(".pdf")) {
    return "pdf";
  }

  if (type === "image/jpeg" || type === "image/jpg" || name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    return "jpg";
  }

  return null;
}

function getUploadMaxBytes(env) {
  return Number(env.UPLOAD_MAX_BYTES || 15 * 1024 * 1024);
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function secureEqual(left, right) {
  if (!left || !right) {
    return false;
  }

  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);

  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  if (a.length !== b.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index];
  }
  return diff === 0;
}

function getRequiredSecret(env, key) {
  const value = env[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  throw new Error(`Missing required Worker secret: ${key}`);
}

async function createSessionCookie(env, trusted) {
  const maxAge = trusted ? TRUSTED_SESSION_MAX_AGE : SESSION_SESSION_MAX_AGE;
  const payload = {
    exp: Date.now() + maxAge * 1000,
    trusted: Boolean(trusted),
  };
  const encodedPayload = encodeJsonPayload(payload);
  const signature = await signValue(getRequiredSecret(env, "SESSION_SIGNING_SECRET"), encodedPayload);
  const parts = [
    `${COOKIE_NAME}=${encodedPayload}.${signature}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
  ];

  if (trusted) {
    parts.push(`Max-Age=${TRUSTED_SESSION_MAX_AGE}`);
    parts.push(`Expires=${new Date(payload.exp).toUTCString()}`);
  }

  return {
    payload,
    header: parts.join("; "),
  };
}

function clearSessionCookie() {
  return [
    `${COOKIE_NAME}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ].join("; ");
}

async function getSessionFromRequest(request, env) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const raw = cookies[COOKIE_NAME];
  if (!raw) {
    return null;
  }

  const [encodedPayload, signature] = raw.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expected = await signValue(getRequiredSecret(env, "SESSION_SIGNING_SECRET"), encodedPayload);
  if (!(await secureEqual(signature, expected))) {
    return null;
  }

  const payload = decodeJsonPayload(encodedPayload);
  if (!payload || typeof payload.exp !== "number" || payload.exp <= Date.now()) {
    return null;
  }

  return {
    exp: payload.exp,
    trusted: payload.trusted === true,
  };
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    cookies[key] = value;
  }
  return cookies;
}

function encodeJsonPayload(value) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJsonPayload(value) {
  try {
    const bytes = base64UrlToBytes(value);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

async function signValue(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

async function ensureBranchExists(env, branch) {
  const existing = await githubRequest(env, `/git/ref/heads/${encodeURIComponent(branch)}`);
  if (existing.status === 200) {
    return;
  }
  if (existing.status !== 404) {
    throw await githubError(existing, `Failed to look up branch ${branch}`);
  }

  const baseBranch = env.GITHUB_DEFAULT_BRANCH || "main";
  const baseRef = await githubRequest(env, `/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  if (!baseRef.ok) {
    throw await githubError(baseRef, `Failed to look up base branch ${baseBranch}`);
  }

  const baseData = await baseRef.json();
  const createRef = await githubRequest(env, "/git/refs", {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${branch}`,
      sha: baseData.object.sha,
    }),
  });

  if (!createRef.ok && createRef.status !== 422) {
    throw await githubError(createRef, `Failed to create branch ${branch}`);
  }
}

async function upsertRepoFile(env, path, content, message) {
  const branch = env.GITHUB_INBOX_BRANCH || "menu-upload-inbox";
  const existing = await getRepoFile(env, path);
  const payload = {
    message,
    content,
    branch,
  };

  if (existing) {
    payload.sha = existing.sha;
  }

  const response = await githubRequest(env, `/contents/${encodePath(path)}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw await githubError(response, `Failed to write ${path}`);
  }

  const data = await response.json();
  if (!data.commit?.sha) {
    throw new Error(`GitHub did not return a commit SHA for ${path}`);
  }
  return {
    commitSha: data.commit.sha,
    commitUrl: data.commit.html_url || `${githubRepoUrl(env)}/commit/${data.commit.sha}`,
  };
}

async function getRepoFile(env, path) {
  const branch = env.GITHUB_INBOX_BRANCH || "menu-upload-inbox";
  const response = await githubRequest(env, `/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw await githubError(response, `Failed to fetch ${path}`);
  }
  return response.json();
}

async function getWorkflowRunForCommit(env, commit) {
  const query = new URLSearchParams({
    branch: env.GITHUB_INBOX_BRANCH || "menu-upload-inbox",
    event: "push",
    exclude_pull_requests: "true",
    per_page: "20",
    head_sha: commit,
  });

  const response = await githubRequest(env, `/actions/runs?${query.toString()}`);
  if (!response.ok) {
    throw await githubError(response, `Failed to fetch workflow runs for ${commit}`);
  }

  const data = await response.json();
  return (data.workflow_runs || []).find((run) => run.head_sha === commit) || null;
}

async function getWorkflowRunJobs(env, runId) {
  const response = await githubRequest(env, `/actions/runs/${runId}/jobs?per_page=100`);
  if (!response.ok) {
    throw await githubError(response, `Failed to fetch jobs for workflow run ${runId}`);
  }

  return response.json();
}

function normalizeWorkflowStatus(run, jobsPayload) {
  const jobs = jobsPayload.jobs || [];
  const failureDetail = getFailureDetail(jobs);

  if (run.status === "completed") {
    if (run.conclusion === "success") {
      return {
        stage: "Done",
        terminal: true,
        detail: "Menu assets were published successfully.",
        run: simplifyRun(run),
      };
    }

    return {
      stage: "Failed",
      terminal: true,
      detail: failureDetail || `GitHub Actions finished with '${run.conclusion || "failure"}'.`,
      run: simplifyRun(run),
    };
  }

  if (failureDetail) {
    return {
      stage: "Failed",
      terminal: true,
      detail: failureDetail,
      run: simplifyRun(run),
    };
  }

  if (["queued", "waiting", "requested", "pending"].includes(run.status)) {
    return {
      stage: "Queued",
      terminal: false,
      detail: "GitHub Actions has the upload and has not started processing it yet.",
      run: simplifyRun(run),
    };
  }

  return {
    stage: resolveProgressStage(jobs),
    terminal: false,
    detail: "GitHub Actions is processing the upload.",
    run: simplifyRun(run),
  };
}

function simplifyRun(run) {
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion || null,
    url: run.html_url || null,
  };
}

function resolveProgressStage(jobs) {
  for (let index = TRACKED_STEP_STAGES.length - 1; index >= 0; index -= 1) {
    const tracked = TRACKED_STEP_STAGES[index];
    const step = findWorkflowStep(jobs, tracked.name);
    if (step && (step.status === "in_progress" || step.status === "completed")) {
      return tracked.stage;
    }
  }

  return "Queued";
}

function findWorkflowStep(jobs, stepName) {
  for (const job of jobs) {
    for (const step of job.steps || []) {
      if (step.name === stepName) {
        return step;
      }
    }
  }
  return null;
}

function getFailureDetail(jobs) {
  for (const job of jobs) {
    for (const step of job.steps || []) {
      if (["failure", "cancelled", "timed_out", "action_required"].includes(step.conclusion)) {
        return `GitHub Actions failed during '${step.name}'.`;
      }
    }

    if (["failure", "cancelled", "timed_out", "action_required"].includes(job.conclusion)) {
      return `GitHub Actions failed in job '${job.name}'.`;
    }
  }

  return "";
}

function githubRequest(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${getRequiredSecret(env, "GITHUB_TOKEN")}`,
      "Content-Type": "application/json",
      "User-Agent": "bay-clock-menu-admin",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.headers || {}),
    },
  });
}

async function githubError(response, context) {
  const detail = await response.text();
  return new Error(`${context}: GitHub API ${response.status} ${detail}`);
}

function githubRepoUrl(env) {
  return `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
}

function githubActionsUrl(env) {
  return `${githubRepoUrl(env)}/actions`;
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4 || 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function htmlHeaders() {
  return {
    ...noStoreHeaders(),
    "content-type": "text/html; charset=utf-8",
  };
}

function noStoreHeaders() {
  return {
    "cache-control": "no-store",
  };
}

function jsonResponse(body, init = {}) {
  const headers = new Headers(noStoreHeaders());
  const extraHeaders = new Headers(init.headers || {});
  for (const [key, value] of extraHeaders.entries()) {
    headers.set(key, value);
  }
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

function serializeForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function renderPage(env) {
  const config = {
    maxBytes: getUploadMaxBytes(env),
    pdfJsUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.394/build/pdf.min.mjs",
    pdfWorkerUrl: "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.394/build/pdf.worker.min.mjs",
    liveMenuUrl: `https://raw.githubusercontent.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_DEFAULT_BRANCH || "main"}/public/menu/menu.jpg`,
  };

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Menu Admin</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f0e8;
        --bg-tint: #f1f3ef;
        --panel: rgba(255, 253, 249, 0.86);
        --panel-strong: rgba(255, 253, 249, 0.97);
        --line: rgba(27, 32, 38, 0.12);
        --line-strong: rgba(27, 32, 38, 0.18);
        --text: #1b2026;
        --muted: #69727b;
        --accent: #1d7a63;
        --accent-soft: rgba(29, 122, 99, 0.1);
        --error: #9f3b2f;
        --error-soft: rgba(159, 59, 47, 0.08);
        font-family: "Avenir Next", "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top left, rgba(216, 192, 165, 0.34), transparent 35%),
          radial-gradient(circle at top right, rgba(207, 224, 225, 0.28), transparent 32%),
          linear-gradient(180deg, var(--bg) 0%, var(--bg-tint) 100%);
        color: var(--text);
      }

      a {
        color: inherit;
      }

      button,
      input {
        font: inherit;
      }

      button {
        cursor: pointer;
      }

      img {
        max-width: 100%;
        display: block;
      }

      #app {
        width: 100%;
      }

      .shell {
        width: min(1120px, 100%);
        margin: 0 auto;
        padding: 28px 20px 40px;
      }

      .shell--centered {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }

      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: 0 18px 60px rgba(27, 32, 38, 0.08);
        backdrop-filter: blur(10px);
      }

      .auth-card {
        width: min(420px, 100%);
        padding: 32px;
      }

      .flow-card {
        padding: 24px;
      }

      .status-card {
        width: min(640px, 100%);
        padding: 28px;
      }

      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 16px;
        margin-bottom: 20px;
      }

      .brand {
        font-size: 0.88rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      h1,
      h2,
      p {
        margin: 0;
      }

      h1 {
        font-size: clamp(2rem, 3.2vw, 2.45rem);
        line-height: 1.05;
      }

      h2 {
        font-size: 1rem;
      }

      .lede {
        margin-top: 10px;
        color: var(--muted);
        line-height: 1.5;
      }

      .stack {
        display: grid;
        gap: 18px;
      }

      .field {
        display: grid;
        gap: 8px;
        font-size: 0.95rem;
        font-weight: 600;
      }

      .input {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.72);
        padding: 14px 16px;
        color: var(--text);
      }

      .input:focus-visible {
        outline: 2px solid rgba(29, 122, 99, 0.18);
        outline-offset: 2px;
        border-color: rgba(29, 122, 99, 0.44);
      }

      .check-row {
        display: flex;
        gap: 12px;
        align-items: flex-start;
      }

      .check-row input {
        margin-top: 3px;
      }

      .helper {
        color: var(--muted);
        font-size: 0.92rem;
        line-height: 1.4;
      }

      .button-row {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }

      .button {
        border: 1px solid transparent;
        border-radius: 999px;
        padding: 12px 18px;
        font-weight: 700;
        transition: background 150ms ease, border-color 150ms ease, transform 150ms ease;
      }

      .button:hover:not(:disabled) {
        transform: translateY(-1px);
      }

      .button:disabled {
        opacity: 0.6;
        cursor: wait;
      }

      .button--primary {
        background: var(--accent);
        color: white;
        box-shadow: 0 10px 24px rgba(29, 122, 99, 0.2);
      }

      .button--secondary,
      .button--ghost {
        background: rgba(255, 255, 255, 0.52);
        border-color: var(--line);
        color: var(--text);
      }

      .message {
        min-height: 1.4em;
        color: var(--muted);
        font-size: 0.95rem;
      }

      .message--error {
        color: var(--error);
      }

      .inline-error {
        border: 1px solid rgba(159, 59, 47, 0.2);
        background: var(--error-soft);
        border-radius: 16px;
        padding: 12px 14px;
        color: var(--error);
        font-size: 0.95rem;
      }

      .dropzone {
        position: relative;
        border: 1px dashed var(--line-strong);
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.5);
        cursor: pointer;
        transition: border-color 160ms ease, background 160ms ease, transform 160ms ease;
      }

      .dropzone:hover {
        border-color: rgba(29, 122, 99, 0.36);
      }

      .dropzone.is-dragging {
        border-color: rgba(29, 122, 99, 0.76);
        background: var(--accent-soft);
        transform: translateY(-1px);
      }

      .dropzone--large {
        min-height: 360px;
        display: grid;
        place-items: center;
        padding: 32px;
        text-align: center;
      }

      .dropzone--compact {
        padding: 18px;
      }

      .dropzone__title {
        font-size: clamp(1.4rem, 2.4vw, 1.9rem);
        font-weight: 700;
      }

      .dropzone__subtitle,
      .subtle {
        color: var(--muted);
        font-size: 0.95rem;
        line-height: 1.5;
      }

      .file-input {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
        border: 0;
      }

      .review-stack {
        display: grid;
        gap: 18px;
      }

      .comparison {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }

      .panel {
        border: 1px solid var(--line);
        border-radius: 22px;
        background: var(--panel-strong);
        overflow: hidden;
        min-height: 420px;
      }

      .panel__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--line);
      }

      .panel__meta {
        color: var(--muted);
        font-size: 0.9rem;
        text-align: right;
      }

      .panel__body {
        padding: 18px;
        display: grid;
        place-items: center;
        min-height: 360px;
        background: linear-gradient(180deg, rgba(244, 241, 236, 0.9), rgba(255, 255, 255, 0.82));
      }

      .panel__body img {
        width: 100%;
        height: auto;
        border-radius: 12px;
        border: 1px solid rgba(27, 32, 38, 0.08);
        background: white;
      }

      .status-stages {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 10px;
        margin-top: 22px;
      }

      .stage {
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 12px 10px;
        text-align: center;
        font-size: 0.9rem;
        color: var(--muted);
        background: rgba(255, 255, 255, 0.44);
      }

      .stage.is-current {
        border-color: rgba(29, 122, 99, 0.36);
        background: var(--accent-soft);
        color: var(--text);
        font-weight: 700;
      }

      .stage.is-complete {
        border-color: rgba(29, 122, 99, 0.22);
        color: var(--text);
      }

      .stage.is-failed {
        border-color: rgba(159, 59, 47, 0.28);
        color: var(--error);
        background: var(--error-soft);
      }

      .status-body {
        margin-top: 18px;
        display: grid;
        gap: 14px;
      }

      .status-body code {
        overflow-wrap: anywhere;
      }

      .loading {
        color: var(--muted);
        font-size: 0.95rem;
      }

      .link-row {
        display: flex;
        gap: 14px;
        flex-wrap: wrap;
        align-items: center;
      }

      @media (max-width: 840px) {
        .comparison {
          grid-template-columns: 1fr;
        }

        .status-stages {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }

      @media (max-width: 560px) {
        .shell {
          padding: 20px 14px 32px;
        }

        .flow-card,
        .status-card,
        .auth-card {
          padding: 22px 18px;
        }

        .topbar {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script id="app-config" type="application/json">${serializeForHtml(config)}</script>
    <script>const __name = (target) => target; (${clientApp.toString()})();</script>
  </body>
</html>`;
}

function clientApp() {
  const config = JSON.parse(document.getElementById("app-config").textContent);
  const app = document.getElementById("app");
  const stageOrder = ["Queued", "Processing", "Publishing", "Finalizing", "Done"];
  const state = {
    sessionChecked: false,
    authenticated: false,
    trusted: false,
    authBusy: false,
    authError: "",
    authCode: "",
    authTrustBrowser: false,
    uploadError: "",
    reviewError: "",
    previewBusy: false,
    confirmBusy: false,
    selectedFile: null,
    preview: null,
    previewToken: 0,
    reviewNonce: Date.now(),
    pollingCommit: "",
    pollTimer: null,
    statusData: null,
    statusError: "",
  };

  window.addEventListener("popstate", () => {
    render();
  });

  boot();

  async function boot() {
    await refreshSession();
    render();
  }

  async function refreshSession() {
    try {
      const response = await fetch("/api/session", {
        headers: { Accept: "application/json" },
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || "Unable to verify session");
      }
      state.authenticated = payload.authenticated === true;
      state.trusted = payload.trusted === true;
      state.authError = "";
    } catch (error) {
      state.authenticated = false;
      state.authError = error.message || "Unable to verify session";
    } finally {
      state.sessionChecked = true;
    }
  }

  function render() {
    const path = normalizeRoute();
    if (!state.sessionChecked) {
      stopPolling();
      app.innerHTML = renderLoadingShell("Checking session...");
      return;
    }

    if (!state.authenticated) {
      stopPolling();
      app.innerHTML = renderAuth();
      bindAuth();
      return;
    }

    if (path !== "/status") {
      stopPolling();
    }

    if (path === "/upload") {
      app.innerHTML = renderUpload();
      bindLogout();
      bindUploadDropzone();
      return;
    }

    if (path === "/review") {
      app.innerHTML = renderReview();
      bindLogout();
      bindReviewDropzone();
      bindReviewActions();
      return;
    }

    if (path === "/status") {
      app.innerHTML = renderStatus();
      bindLogout();
      bindStatusActions();
      startStatusPolling();
      return;
    }

    stopPolling();
    app.innerHTML = renderUpload();
    bindLogout();
    bindUploadDropzone();
  }

  function normalizeRoute() {
    let path = window.location.pathname;
    if (!["/", "/upload", "/review", "/status"].includes(path)) {
      history.replaceState({}, "", "/");
      path = "/";
    }

    if (!state.authenticated) {
      if (path !== "/") {
        history.replaceState({}, "", "/");
      }
      return "/";
    }

    if (path === "/") {
      history.replaceState({}, "", "/upload");
      return "/upload";
    }

    if (path === "/review" && !state.selectedFile) {
      history.replaceState({}, "", "/upload?error=lost-upload");
      return "/upload";
    }

    return path;
  }

  function renderLoadingShell(message) {
    return `
      <main class="shell shell--centered">
        <section class="card auth-card">
          <p class="loading">${escapeHtml(message)}</p>
        </section>
      </main>
    `;
  }

  function renderAuth() {
    return `
      <main class="shell shell--centered">
        <section class="card auth-card">
          <div class="stack">
            <div class="stack">
              <p class="brand">Private Access</p>
              <h1>Menu Admin</h1>
              <p class="lede">Enter the shared access code to upload a new menu.</p>
            </div>
            ${renderError(state.authError)}
            <form id="auth-form" class="stack">
              <label class="field">
                <span>Access code</span>
                <input class="input" type="password" name="code" value="${escapeAttribute(state.authCode)}" autocomplete="current-password" required />
              </label>
              <label class="check-row">
                <input type="checkbox" name="trustBrowser" ${state.authTrustBrowser ? "checked" : ""} />
                <span>
                  <strong>Trust this browser</strong>
                  <div class="helper">Only use this on a personal device</div>
                </span>
              </label>
              <div class="button-row">
                <button class="button button--primary" type="submit" ${state.authBusy ? "disabled" : ""}>${state.authBusy ? "Checking..." : "Continue"}</button>
              </div>
            </form>
          </div>
        </section>
      </main>
    `;
  }

  function renderUpload() {
    const params = new URLSearchParams(window.location.search);
    const pageError = params.get("error") === "lost-upload"
      ? "The selected file is gone after refresh. Choose it again."
      : "";
    const helperMessage = state.previewBusy ? "Preparing a preview..." : "";
    const message = state.uploadError || pageError || helperMessage;
    return `
      <main class="shell">
        <div class="topbar">
          <div>
            <div class="brand">Menu Admin</div>
          </div>
          <button class="button button--ghost" type="button" data-action="logout">Log out</button>
        </div>
        <section class="card flow-card stack">
          <div class="stack">
            <h1>Upload</h1>
            <p class="lede">Select the next menu file. Nothing is written to GitHub until you confirm it on the review screen.</p>
          </div>
          <label class="dropzone dropzone--large" id="upload-dropzone" for="upload-input" role="button" tabindex="0" aria-label="Upload a PDF or JPG">
            <input class="file-input" id="upload-input" type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" />
            <div class="stack">
              <div class="dropzone__title">Drop a PDF or JPG here</div>
              <div class="dropzone__subtitle">or click to browse</div>
            </div>
          </label>
          <p class="subtle">Accepted types: PDF, JPG, JPEG. Max ${escapeHtml(formatFileLimit(config.maxBytes))}.</p>
          <div class="message ${message && (state.uploadError || pageError) ? "message--error" : ""}">${escapeHtml(message)}</div>
        </section>
      </main>
    `;
  }

  function renderReview() {
    const preview = state.preview;
    const liveMenuUrl = withCacheBust(config.liveMenuUrl, state.reviewNonce);
    const fileType = detectFileKind(state.selectedFile);
    const fileMeta = [state.selectedFile.name, fileType === "pdf" ? "PDF preview" : "JPG preview"].filter(Boolean).join(" · ");
    return `
      <main class="shell">
        <div class="topbar">
          <div class="brand">Menu Admin</div>
          <button class="button button--ghost" type="button" data-action="logout">Log out</button>
        </div>
        <section class="card flow-card review-stack">
          <label class="dropzone dropzone--compact" id="replace-dropzone" for="replace-input" role="button" tabindex="0" aria-label="Replace selected file">
            <input class="file-input" id="replace-input" type="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" />
            <div class="stack">
              <div><strong>Replace selected file</strong></div>
              <div class="subtle">Drop another PDF or JPG here, or click to browse.</div>
            </div>
          </label>
          <div class="comparison">
            <section class="panel">
              <div class="panel__header">
                <div>
                  <h2>Current live menu</h2>
                </div>
                <div class="panel__meta"><a href="${escapeAttribute(liveMenuUrl)}" target="_blank" rel="noreferrer">Open current file</a></div>
              </div>
              <div class="panel__body">
                <img src="${escapeAttribute(liveMenuUrl)}" alt="Current live menu" />
              </div>
            </section>
            <section class="panel">
              <div class="panel__header">
                <div>
                  <h2>New upload</h2>
                </div>
                <div class="panel__meta">${escapeHtml(fileMeta)}</div>
              </div>
              <div class="panel__body">
                <img src="${escapeAttribute(preview ? preview.src : "")}" alt="Selected upload preview" />
              </div>
            </section>
          </div>
          <div class="button-row">
            <button class="button button--secondary" type="button" data-action="choose-another">Choose another file</button>
            <button class="button button--primary" type="button" data-action="confirm-upload" ${state.confirmBusy ? "disabled" : ""}>${state.confirmBusy ? "Confirming..." : "Confirm upload"}</button>
          </div>
          <div class="message ${state.reviewError ? "message--error" : ""}">${escapeHtml(state.reviewError || (state.previewBusy ? "Preparing a replacement preview..." : ""))}</div>
        </section>
      </main>
    `;
  }

  function renderStatus() {
    const params = new URLSearchParams(window.location.search);
    const commit = params.get("commit") || "";
    if (!commit) {
      return `
        <main class="shell shell--centered">
          <section class="card status-card stack">
            <div class="stack">
              <h1>Upload status</h1>
              <p class="lede">A commit SHA is required to resume tracking this upload.</p>
            </div>
            <div class="button-row">
              <button class="button button--primary" type="button" data-action="upload-another">Upload another menu</button>
            </div>
          </section>
        </main>
      `;
    }

    const status = state.statusData;
    const stage = status ? status.stage : "Queued";
    const detail = state.statusError || (status ? status.detail : "Waiting for GitHub Actions to pick up the upload.");
    const isFailed = stage === "Failed";
    const isDone = stage === "Done";
    return `
      <main class="shell shell--centered">
        <section class="card status-card">
          <div class="stack">
            <div class="stack">
              <div class="brand">Menu Admin</div>
              <h1>Upload status</h1>
              <p class="lede">${escapeHtml(detail)}</p>
            </div>
            <div class="status-stages">
              ${renderStages(stage)}
            </div>
            <div class="status-body">
              <div class="subtle">Tracking upload commit</div>
              <code>${escapeHtml(commit)}</code>
              ${status && status.run && status.run.url
                ? `<div class="link-row"><a href="${escapeAttribute(status.run.url)}" target="_blank" rel="noreferrer">View on GitHub</a></div>`
                : ""}
              ${isFailed && !state.statusError ? renderError(detail) : ""}
            </div>
            <div class="button-row">
              ${isDone ? `<button class="button button--secondary" type="button" data-action="upload-another">Upload another menu</button>` : ""}
              ${isDone ? `<a class="button button--primary" href="${escapeAttribute(withCacheBust(config.liveMenuUrl, Date.now()))}" target="_blank" rel="noreferrer">Open current live menu</a>` : ""}
              ${isFailed ? `<button class="button button--secondary" type="button" data-action="upload-another">Upload another menu</button>` : ""}
            </div>
          </div>
        </section>
      </main>
    `;
  }

  function renderStages(activeStage) {
    if (activeStage === "Failed") {
      return stageOrder
        .map((stage) => `<div class="stage">${escapeHtml(stage)}</div>`)
        .concat('<div class="stage is-failed">Failed</div>')
        .join("");
    }

    const activeIndex = stageOrder.indexOf(activeStage);
    return stageOrder
      .map((stage, index) => {
        const classes = ["stage"];
        if (index < activeIndex) {
          classes.push("is-complete");
        } else if (index === activeIndex) {
          classes.push("is-current");
        }
        return `<div class="${classes.join(" ")}">${escapeHtml(stage)}</div>`;
      })
      .join("");
  }

  function renderError(message) {
    if (!message) {
      return "";
    }
    return `<div class="inline-error">${escapeHtml(message)}</div>`;
  }

  function bindAuth() {
    const form = document.getElementById("auth-form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(form);
      const payload = {
        code: String(formData.get("code") || ""),
        trustBrowser: formData.get("trustBrowser") === "on",
      };

      state.authCode = payload.code;
      state.authTrustBrowser = payload.trustBrowser;
      state.authBusy = true;
      state.authError = "";
      render();

      try {
        const response = await fetch("/api/auth", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || "Unable to sign in");
        }
        state.authenticated = true;
        state.trusted = result.trusted === true;
        state.authBusy = false;
        state.authCode = "";
        state.authTrustBrowser = false;
        history.replaceState({}, "", "/upload");
        render();
      } catch (error) {
        state.authBusy = false;
        state.authError = error.message || "Unable to sign in";
        render();
      }
    });
  }

  function bindLogout() {
    document.querySelectorAll('[data-action="logout"]').forEach((button) => {
      button.addEventListener("click", async () => {
        await logout();
      });
    });
  }

  function bindUploadDropzone() {
    bindDropzone({
      dropzoneId: "upload-dropzone",
      inputId: "upload-input",
      onFile: (file) => selectFile(file, { replaceHistory: false }),
      disabled: state.previewBusy,
    });
  }

  function bindReviewDropzone() {
    bindDropzone({
      dropzoneId: "replace-dropzone",
      inputId: "replace-input",
      onFile: (file) => selectFile(file, { replaceHistory: true }),
      disabled: state.previewBusy || state.confirmBusy,
    });
  }

  function bindReviewActions() {
    const confirmButton = document.querySelector('[data-action="confirm-upload"]');
    const chooseButton = document.querySelector('[data-action="choose-another"]');
    const replaceInput = document.getElementById("replace-input");

    chooseButton.addEventListener("click", () => {
      replaceInput.click();
    });

    confirmButton.addEventListener("click", async () => {
      if (state.confirmBusy || !state.selectedFile) {
        return;
      }

      state.confirmBusy = true;
      state.reviewError = "";
      render();

      try {
        const formData = new FormData();
        formData.set("file", state.selectedFile, state.selectedFile.name);
        const response = await fetch("/api/confirm-upload", {
          method: "POST",
          body: formData,
        });

        const result = await response.json();
        if (response.status === 401) {
          return await handleSessionExpired("Session expired. Enter the access code again.");
        }
        if (!response.ok) {
          throw new Error(result.error || "Upload failed");
        }

        clearSelectedFile();
        state.confirmBusy = false;
        state.statusData = null;
        state.statusError = "";
        history.pushState({}, "", "/status?commit=" + encodeURIComponent(result.uploadCommitSha));
        render();
      } catch (error) {
        state.reviewError = error.message || "Upload failed";
        state.confirmBusy = false;
        render();
      }
    });
  }

  function bindStatusActions() {
    document.querySelectorAll('[data-action="upload-another"]').forEach((button) => {
      button.addEventListener("click", () => {
        stopPolling();
        state.statusData = null;
        state.statusError = "";
        history.pushState({}, "", "/upload");
        render();
      });
    });
  }

  function bindDropzone(options) {
    const dropzone = document.getElementById(options.dropzoneId);
    const input = document.getElementById(options.inputId);
    if (!dropzone || !input) {
      return;
    }

    const openPicker = () => {
      if (!options.disabled) {
        input.click();
      }
    };

    dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openPicker();
      }
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        if (!options.disabled) {
          dropzone.classList.add("is-dragging");
        }
      });
    });

    ["dragleave", "dragend"].forEach((eventName) => {
      dropzone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropzone.classList.remove("is-dragging");
      });
    });

    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
      if (options.disabled) {
        return;
      }
      const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
      if (file) {
        options.onFile(file);
      }
    });

    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.value = "";
      if (file) {
        options.onFile(file);
      }
    });
  }

  async function selectFile(file, options) {
    state.uploadError = "";
    state.reviewError = "";

    const validationError = validateFile(file);
    if (validationError) {
      if (window.location.pathname === "/review") {
        state.reviewError = validationError;
      } else {
        state.uploadError = validationError;
      }
      render();
      return;
    }

    state.previewBusy = true;
    state.previewToken += 1;
    const token = state.previewToken;
    render();

    try {
      const preview = await buildPreview(file);
      if (token !== state.previewToken) {
        if (preview.revoke) {
          preview.revoke();
        }
        return;
      }

      clearSelectedFile();
      state.selectedFile = file;
      state.preview = preview;
      state.reviewNonce = Date.now();
      state.previewBusy = false;
      state.confirmBusy = false;
      if (options.replaceHistory) {
        history.replaceState({}, "", "/review");
      } else {
        history.pushState({}, "", "/review");
      }
      render();
    } catch (error) {
      state.previewBusy = false;
      const message = error.message || "Unable to preview that file";
      if (window.location.pathname === "/review") {
        state.reviewError = message;
      } else {
        state.uploadError = message;
      }
      render();
    }
  }

  async function buildPreview(file) {
    const kind = detectFileKind(file);
    if (kind === "jpg") {
      const url = URL.createObjectURL(file);
      return {
        kind,
        src: url,
        revoke() {
          URL.revokeObjectURL(url);
        },
      };
    }

    if (kind !== "pdf") {
      throw new Error("Only PDF and JPG uploads are supported");
    }

    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1.8, 1200 / viewport.width);
    const renderViewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to prepare a PDF preview");
    }
    canvas.width = Math.ceil(renderViewport.width);
    canvas.height = Math.ceil(renderViewport.height);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: context,
      viewport: renderViewport,
    }).promise;
    const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
    if (typeof page.cleanup === "function") {
      page.cleanup();
    }
    if (typeof pdf.cleanup === "function") {
      pdf.cleanup();
    }
    if (typeof pdf.destroy === "function") {
      await pdf.destroy();
    }
    return {
      kind,
      src: dataUrl,
      revoke() {},
    };
  }

  async function loadPdfJs() {
    if (!window.__menuAdminPdfJsPromise) {
      window.__menuAdminPdfJsPromise = import(config.pdfJsUrl).then((module) => {
        module.GlobalWorkerOptions.workerSrc = config.pdfWorkerUrl;
        return module;
      });
    }

    return window.__menuAdminPdfJsPromise;
  }

  function validateFile(file) {
    const kind = detectFileKind(file);
    if (!kind) {
      return "Only PDF and JPG uploads are supported";
    }
    if (file.size > config.maxBytes) {
      return "Upload exceeds the " + formatFileLimit(config.maxBytes) + " limit";
    }
    return "";
  }

  function detectFileKind(file) {
    const type = (file.type || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    if (type === "application/pdf" || name.endsWith(".pdf")) {
      return "pdf";
    }
    if (type === "image/jpeg" || type === "image/jpg" || name.endsWith(".jpg") || name.endsWith(".jpeg")) {
      return "jpg";
    }
    return "";
  }

  function startStatusPolling() {
    const params = new URLSearchParams(window.location.search);
    const commit = params.get("commit") || "";
    if (!commit) {
      stopPolling();
      return;
    }

    if (state.pollingCommit === commit && state.pollTimer) {
      return;
    }

    stopPolling();
    state.statusData = null;
    state.statusError = "";
    state.pollingCommit = commit;
    pollStatus(commit);
    state.pollTimer = window.setInterval(() => {
      pollStatus(commit);
    }, 2000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    state.pollingCommit = "";
  }

  async function pollStatus(commit) {
    try {
      const response = await fetch("/api/run-status?commit=" + encodeURIComponent(commit), {
        headers: { Accept: "application/json" },
      });
      const payload = await response.json();
      if (response.status === 401) {
        return await handleSessionExpired("Session expired. Enter the access code again.");
      }
      if (!response.ok) {
        throw new Error(payload.error || "Unable to read workflow status");
      }
      state.statusData = payload;
      state.statusError = "";
      if (payload.terminal) {
        stopPolling();
      }
      render();
    } catch (error) {
      state.statusError = error.message || "Unable to read workflow status";
      render();
    }
  }

  async function logout() {
    try {
      await fetch("/api/logout", {
        method: "POST",
      });
    } finally {
      clearSelectedFile();
      stopPolling();
      state.authenticated = false;
      state.trusted = false;
      state.authBusy = false;
      state.previewBusy = false;
      state.confirmBusy = false;
      state.authError = "";
      state.authCode = "";
      state.authTrustBrowser = false;
      state.uploadError = "";
      state.reviewError = "";
      state.statusData = null;
      state.statusError = "";
      history.replaceState({}, "", "/");
      render();
    }
  }

  async function handleSessionExpired(message) {
    await fetch("/api/logout", {
      method: "POST",
    }).catch(() => {});
    clearSelectedFile();
    stopPolling();
    state.authenticated = false;
    state.trusted = false;
    state.authBusy = false;
    state.previewBusy = false;
    state.confirmBusy = false;
    state.authError = message;
    state.authCode = "";
    state.authTrustBrowser = false;
    state.uploadError = "";
    state.reviewError = "";
    state.statusData = null;
    state.statusError = "";
    history.replaceState({}, "", "/");
    render();
  }

  function clearSelectedFile() {
    if (state.preview && typeof state.preview.revoke === "function") {
      state.preview.revoke();
    }
    state.selectedFile = null;
    state.preview = null;
  }

  function formatFileLimit(bytes) {
    return Math.round(bytes / (1024 * 1024)) + " MB";
  }

  function withCacheBust(url, value) {
    const separator = url.includes("?") ? "&" : "?";
    return url + separator + "t=" + encodeURIComponent(String(value));
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }
}
