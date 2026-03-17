const INBOX_DIR = ".menu-upload-inbox";
const UPLOAD_PATH = `${INBOX_DIR}/upload`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(renderPage(), {
        headers: htmlHeaders(),
      });
    }

    if (request.method === "POST" && url.pathname === "/upload") {
      try {
        return await handleUpload(request, env);
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Upload failed" },
          {
            status: 500,
            headers: noStoreHeaders(),
          },
        );
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};

async function handleUpload(request, env) {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return Response.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const formData = await request.formData();
  const password = asTrimmedString(formData.get("password"));
  const file = formData.get("file");

  if (!(await secureEqual(password, env.MENU_UPLOAD_PASSWORD || ""))) {
    return Response.json({ error: "Invalid password" }, { status: 401 });
  }

  if (!(file instanceof File)) {
    return Response.json({ error: "A file upload is required" }, { status: 400 });
  }

  const uploadType = getSupportedExtension(file);
  if (!uploadType) {
    return Response.json({ error: "Only PDF and JPG uploads are supported" }, { status: 400 });
  }

  const maxBytes = Number(env.UPLOAD_MAX_BYTES || 15 * 1024 * 1024);
  if (Number.isFinite(maxBytes) && file.size > maxBytes) {
    return Response.json(
      { error: `Upload exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit` },
      { status: 413 },
    );
  }

  await ensureBranchExists(env, env.GITHUB_INBOX_BRANCH || "menu-upload-inbox");

  const bytes = new Uint8Array(await file.arrayBuffer());
  await upsertRepoFile(env, UPLOAD_PATH, bytesToBase64(bytes));

  return Response.json(
    {
      ok: true,
      message: `Queued ${file.name || "menu upload"} for processing.`,
      branch: env.GITHUB_INBOX_BRANCH || "menu-upload-inbox",
      path: UPLOAD_PATH,
      type: uploadType,
    },
    {
      headers: noStoreHeaders(),
    },
  );
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

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
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

async function upsertRepoFile(env, path, content) {
  const branch = env.GITHUB_INBOX_BRANCH || "menu-upload-inbox";
  const existing = await getRepoFile(env, path);
  const payload = {
    message: "chore: enqueue menu upload",
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

function githubRequest(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
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

function renderPage() {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Bay Clock Menu Admin</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background: linear-gradient(160deg, #f6efe5 0%, #f2f8fb 100%);
        color: #1c232b;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      main {
        width: min(100%, 520px);
        background: rgba(255, 255, 255, 0.88);
        border: 1px solid rgba(28, 35, 43, 0.08);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 20px 60px rgba(28, 35, 43, 0.12);
        backdrop-filter: blur(10px);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 1.9rem;
      }
      p {
        margin: 0 0 20px;
        line-height: 1.5;
      }
      form {
        display: grid;
        gap: 14px;
      }
      label {
        font-size: 0.95rem;
        font-weight: 600;
      }
      input {
        width: 100%;
        margin-top: 6px;
        border: 1px solid #c8d2db;
        border-radius: 14px;
        padding: 12px 14px;
        font: inherit;
        background: #fff;
        box-sizing: border-box;
      }
      button {
        border: 0;
        border-radius: 999px;
        padding: 13px 18px;
        font: inherit;
        font-weight: 700;
        background: #0c7a6a;
        color: white;
        cursor: pointer;
      }
      button:disabled {
        opacity: 0.65;
        cursor: wait;
      }
      #result {
        min-height: 1.5em;
        font-size: 0.95rem;
      }
      .note {
        color: #53606c;
        font-size: 0.9rem;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Menu Upload</h1>
      <p>Upload a PDF or JPG. The first PDF page becomes the live menu image after GitHub Actions finishes processing it.</p>
      <form id="upload-form" enctype="multipart/form-data">
        <label>
          Shared password
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <label>
          Menu file
          <input type="file" name="file" accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" required />
        </label>
        <button type="submit">Upload Menu</button>
        <div id="result" aria-live="polite"></div>
      </form>
      <p class="note">Accepted formats: PDF, JPG, JPEG.</p>
    </main>
    <script>
      const form = document.getElementById("upload-form");
      const result = document.getElementById("result");
      const button = form.querySelector("button");

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        button.disabled = true;
        result.textContent = "Uploading...";

        try {
          const response = await fetch("/upload", {
            method: "POST",
            body: new FormData(form),
          });
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "Upload failed");
          }
          result.textContent = payload.message + " GitHub Actions will publish it to main.";
          form.reset();
        } catch (error) {
          result.textContent = error.message || "Upload failed";
        } finally {
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>`;
}
