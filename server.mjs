import { createServer } from "node:http";
import { readFile, writeFile, mkdir, readdir, stat, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { extname, join, normalize, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.env.PORT || 8765);
const projectsDir = join(root, "projects");
const imagegenSkill = join(homedir(), ".codex", "skills", ".system", "imagegen", "SKILL.md");
const codexCommand = process.platform === "win32" ? "codex.cmd" : "codex";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".js": "text/javascript; charset=utf-8"
};

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body || "{}");
}

function slugify(value, fallback = "stack-lp") {
  const slug = String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\u3040-\u30ff\u3400-\u9fff-]/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
}

function projectIdFor(data) {
  return slugify(data.projectId || data.projectName, "untitled-project");
}

function projectPaths(projectId) {
  const id = slugify(projectId, "untitled-project");
  const directory = join(projectsDir, id);
  return {
    id,
    directory,
    projectFile: join(directory, "project.json"),
    generatedDir: join(directory, "images", "generated"),
    exportsDir: join(directory, "exports")
  };
}

async function ensureProjectFolders(projectId) {
  const paths = projectPaths(projectId);
  await Promise.all([
    mkdir(paths.generatedDir, { recursive: true }),
    mkdir(paths.exportsDir, { recursive: true })
  ]);
  return paths;
}

function runCodexTurn(prompt) {
  return new Promise((resolveTurn, rejectTurn) => {
    const child = spawn(codexCommand, ["app-server"], {
      cwd: root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const lines = createInterface({ input: child.stdout });
    const pending = new Map();
    let nextId = 1;
    let stderr = "";
    let settled = false;

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });

    function send(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    }

    function notify(method) {
      child.stdin.write(`${JSON.stringify({ method })}\n`);
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      lines.close();
      child.kill();
      if (error) rejectTurn(error);
      else resolveTurn(result);
    }

    lines.on("line", line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.id != null && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else entry.resolve(message.result);
        return;
      }

      if (message.method === "turn/completed") {
        const status = message.params?.turn?.status;
        if (status === "completed") finish(null, message.params.turn);
        else finish(new Error(`Codex turn failed: ${JSON.stringify(status)}`));
      }
    });

    child.on("error", error => finish(error));
    child.on("exit", code => {
      if (!settled) finish(new Error(`Codex App Server exited (${code}). ${stderr.slice(-1000)}`));
    });

    (async () => {
      try {
        await send("initialize", {
          clientInfo: { name: "stack-lp-studio", title: "STACK LP Studio", version: "1.0.0" },
          capabilities: { experimentalApi: true }
        });
        notify("initialized");
        const started = await send("thread/start", {
          cwd: root,
          approvalPolicy: "never",
          sandbox: "workspace-write",
          ephemeral: true,
          experimentalRawEvents: false,
          persistExtendedHistory: false
        });
        await send("turn/start", {
          threadId: started.thread.id,
          input: [
            { type: "text", text: prompt, text_elements: [] },
            { type: "skill", name: "imagegen", path: imagegenSkill }
          ]
        });
      } catch (error) {
        finish(error);
      }
    })();
  });
}

async function listGeneratedFiles(projectId) {
  const { generatedDir } = await ensureProjectFolders(projectId);
  const entries = await readdir(generatedDir, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter(entry => entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name))
    .map(async entry => {
      const path = join(generatedDir, entry.name);
      return { name: entry.name, path, modified: (await stat(path)).mtimeMs };
    }));
  return files.sort((a, b) => b.modified - a.modified);
}

function generatedImagePayload(file, projectId) {
  const role = file.name.match(/^(hero|problem|solution|benefits|howto|proof|cta)-/i)?.[1]?.toLowerCase() || "hero";
  return {
    name: file.name.replace(/\.[^.]+$/, ""),
    role,
    src: `projects/${slugify(projectId)}/images/generated/${file.name}`,
    modified: file.modified
  };
}

async function listGeneratedImages(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    const projectId = projectIdFor({
      projectId: url.searchParams.get("projectId"),
      projectName: url.searchParams.get("projectName")
    });
    sendJson(response, 200, {
      projectId,
      images: (await listGeneratedFiles(projectId)).map(file => generatedImagePayload(file, projectId))
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "生成画像を読み込めませんでした。" });
  }
}

function safeReferencePaths(paths) {
  return [...new Set((Array.isArray(paths) ? paths : []).map(value => String(value || "")))]
    .filter(value => /^images\/(?:stack-lp|generated)\/[^/]+\.(?:png|jpe?g|webp)$/i.test(value))
    .slice(0, 3);
}

async function generateImages(request, response) {
  try {
    const data = await readJson(request);
    const { role, roleLabel, count, prompt, styleGuide, referenceImages, personaName } = data;
    const projectId = projectIdFor(data);
    const paths = await ensureProjectFolders(projectId);
    const safeCount = Math.min(3, Math.max(1, Number(count) || 1));
    const references = safeReferencePaths(referenceImages);
    const batch = `${slugify(role, "section")}-${timestamp()}`;
    const before = new Set((await listGeneratedFiles(projectId)).map(file => file.name));
    const filenames = Array.from({ length: safeCount }, (_, index) => `${batch}-${index + 1}.png`);
    const outputList = filenames.map(name => `projects/${projectId}/images/generated/${name}`).join(", ");
    const codexPrompt = [
      "Use the imagegen skill and the built-in image generation tool.",
      `Generate ${safeCount} distinct image variant${safeCount > 1 ? "s" : ""} for the ${roleLabel || role} section of a landing page.`,
      personaName ? `Target persona: ${personaName}. Make the scene, people, concerns, and visual emphasis clearly relevant to this persona without stereotyping.` : "",
      prompt,
      styleGuide ? `Mandatory visual style rules from the user:\n${styleGuide}` : "",
      references.length
        ? `Before generating, inspect these local reference images with the view_image tool: ${references.join(", ")}. Treat them as strict visual-style references. Match their palette, illustration technique, line weight, character design, typography mood, spacing, shapes, and overall brand personality. Preserve that visual language while adapting the composition to a landscape canvas; do not copy their portrait aspect ratio.`
        : "",
      "Do not introduce a different rendering style, photorealism, 3D rendering, or unrelated color palette unless the user's style rules explicitly request it.",
      "Every output must be landscape 3:2 at 1536x1024 pixels. Never create portrait or square images.",
      "Use one built-in image generation call per variant.",
      `Save the final PNG files exactly as: ${outputList}.`,
      "Do not edit any other files. Finish only after every requested file exists."
    ].filter(Boolean).join("\n");

    await runCodexTurn(codexPrompt);
    const after = await listGeneratedFiles(projectId);
    const created = after.filter(file => filenames.includes(file.name) || !before.has(file.name));
    if (!created.length) throw new Error("生成画像を保存できませんでした。");

    sendJson(response, 200, {
      projectId,
      images: created.slice(0, safeCount).map(file => generatedImagePayload(file, projectId))
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "画像生成に失敗しました。" });
  }
}

function projectSnapshot(data) {
  return {
    ...data,
    version: 2,
    savedAt: new Date().toISOString()
  };
}

async function localizeProjectAssets(data, projectId) {
  const paths = await ensureProjectFolders(projectId);
  const replacements = new Map();
  const assets = [
    ...(Array.isArray(data.library) ? data.library : []),
    ...Object.values(data.variants || {}).flat()
  ];
  for (const asset of assets) {
    const src = String(asset?.src || "");
    if (!src.startsWith("images/generated/") || replacements.has(src)) continue;
    const filename = src.split("/").pop();
    const source = join(root, src);
    const destination = join(paths.generatedDir, filename);
    try {
      await copyFile(source, destination);
      replacements.set(src, `projects/${projectId}/images/generated/${filename}`);
    } catch {}
  }
  const replaceAssets = items => (Array.isArray(items) ? items : []).map(item => ({
    ...item,
    src: replacements.get(item.src) || item.src
  }));
  return {
    ...data,
    library: replaceAssets(data.library),
    variants: Object.fromEntries(
      Object.entries(data.variants || {}).map(([key, items]) => [key, replaceAssets(items)])
    )
  };
}

async function saveProject(request, response) {
  try {
    const data = await readJson(request);
    const projectId = projectIdFor(data);
    const paths = await ensureProjectFolders(projectId);
    const localized = await localizeProjectAssets(data, projectId);
    const snapshot = projectSnapshot({ ...localized, projectId });
    await writeFile(paths.projectFile, JSON.stringify(snapshot, null, 2));
    sendJson(response, 200, {
      projectId,
      path: paths.projectFile,
      relativePath: relative(root, paths.projectFile)
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "プロジェクトを保存できませんでした。" });
  }
}

async function listProjects(response) {
  try {
    await mkdir(projectsDir, { recursive: true });
    const entries = await readdir(projectsDir, { withFileTypes: true });
    const projects = await Promise.all(entries.map(async entry => {
      const path = entry.isDirectory()
        ? join(projectsDir, entry.name, "project.json")
        : join(projectsDir, entry.name);
      if (!entry.isDirectory() && !entry.name.endsWith(".json")) return null;
      try {
        const info = await stat(path);
        const data = JSON.parse(await readFile(path, "utf8"));
        return {
          projectId: data.projectId || (entry.isDirectory() ? entry.name : slugify(data.projectName)),
          projectName: data.projectName || entry.name.replace(/\.json$/, ""),
          personaName: data.personaName || "",
          legacyFilename: entry.isFile() ? entry.name : "",
          modified: info.mtimeMs
        };
      } catch {
        return null;
      }
    }));
    const byId = new Map();
    for (const project of projects.filter(Boolean)) {
      const current = byId.get(project.projectId);
      if (!current || (current.legacyFilename && !project.legacyFilename)) byId.set(project.projectId, project);
    }
    const validProjects = [...byId.values()];
    validProjects.sort((a, b) => b.modified - a.modified);
    sendJson(response, 200, { projects: validProjects });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "プロジェクト一覧を取得できませんでした。" });
  }
}

async function loadProject(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    const projectId = url.searchParams.get("projectId") || "";
    const legacyFilename = url.searchParams.get("legacyFilename") || "";
    let path;
    if (legacyFilename) {
      if (!/^[^/\\]+\.json$/i.test(legacyFilename)) throw new Error("不正なプロジェクト名です。");
      path = join(projectsDir, legacyFilename);
    } else {
      if (!/^[\w\u3040-\u30ff\u3400-\u9fff-]+$/i.test(projectId)) throw new Error("不正なプロジェクトIDです。");
      path = projectPaths(projectId).projectFile;
    }
    const data = JSON.parse(await readFile(path, "utf8"));
    sendJson(response, 200, { project: data, legacy: Boolean(legacyFilename) });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "プロジェクトを読み込めませんでした。" });
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

async function imageDataUrl(src) {
  if (src.startsWith("data:image/")) return src;
  const filePath = resolve(root, src.replace(/^\/+/, ""));
  if (!filePath.startsWith(root)) throw new Error(`不正な画像パスです: ${src}`);
  const bytes = await readFile(filePath);
  const extension = extname(filePath).toLowerCase();
  const mime = mimeTypes[extension]?.split(";")[0] || "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

async function buildStandaloneHtml(data) {
  const images = await Promise.all((data.items || []).map(async (item, index) => {
    const src = await imageDataUrl(item.src);
    return `<a href="${escapeHtml(data.ctaUrl || "#")}" class="lp-section" data-section="${index + 1}"><img src="${src}" alt="${escapeHtml(item.name)}" loading="${index ? "lazy" : "eager"}"></a>`;
  }));
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(data.pageTitle || "Landing Page")}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;background:#fff}body{font-family:system-ui,sans-serif}
.lp{width:min(100%,1536px);margin:auto;overflow:hidden}.lp-section,.lp-section img{display:block;width:100%}
</style>
</head>
<body>
<main class="lp">
${images.join("\n")}
</main>
<script>
document.querySelectorAll('.lp-section').forEach(function(link){
  link.addEventListener('click',function(){
    window.dataLayer=window.dataLayer||[];
    window.dataLayer.push({event:'${escapeHtml(data.eventName || "lp_cta_click")}',section:this.dataset.section,variant:'${escapeHtml(data.active || "A")}'});
  });
});
<\/script>
</body>
</html>`;
}

async function exportHtml(request, response) {
  try {
    const data = await readJson(request);
    const projectId = projectIdFor(data);
    const { exportsDir } = await ensureProjectFolders(projectId);
    const filename = `${slugify(data.projectName)}-${String(data.active || "A").toLowerCase()}.html`;
    const path = join(exportsDir, filename);
    await writeFile(path, await buildStandaloneHtml(data));
    sendJson(response, 200, {
      projectId,
      path,
      relativePath: relative(root, path),
      url: `/projects/${projectId}/exports/${filename}`
    });
  } catch (error) {
    sendJson(response, 500, { error: error.message || "HTMLを書き出せませんでした。" });
  }
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url.startsWith("/api/generated")) return listGeneratedImages(request, response);
  if (request.method === "GET" && request.url === "/api/projects") return listProjects(response);
  if (request.method === "GET" && request.url.startsWith("/api/project/load?")) return loadProject(request, response);
  if (request.method === "POST" && request.url === "/api/generate") return generateImages(request, response);
  if (request.method === "POST" && request.url === "/api/project/save") return saveProject(request, response);
  if (request.method === "POST" && request.url === "/api/export") return exportHtml(request, response);

  const rawPath = request.url === "/" ? "/stack-lp-studio-codex.html" : request.url;
  const safePath = normalize(decodeURIComponent(rawPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);
  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath).toLowerCase()] || "application/octet-stream"
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", async () => {
  await mkdir(projectsDir, { recursive: true });
  console.log(`STACK LP Studio: http://127.0.0.1:${port}/stack-lp-studio-codex.html`);
});
