#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = parseArgs(process.argv.slice(2));
const fixture = resolve(args.fixture || args._[0] || join(ROOT, "tests/benchmarks/conversation-render/fixtures/smoke.json"));
const profiles = selectProfiles(args.profiles);
const outputDir = resolve(args.outputDir || join("/tmp/qingzhou-conversation-visual-audit-matrix", timestampSlug()));
mkdirSync(outputDir, { recursive: true });

const results = [];
for (const profile of profiles) {
  const artifactDir = join(outputDir, profile.id);
  const commandArgs = [
    join(ROOT, "tests/benchmarks/conversation-render/run.mjs"),
    "--mode", "visual-audit",
    "--json",
    "--fail-on-health",
    "--color-scheme", profile.colorScheme,
    "--artifact-dir", artifactDir,
    "--visual-audit-max-actions", String(args.maxActions || 64),
    "--visual-audit-max-depth", String(args.maxDepth || 2),
    fixture,
  ];
  const child = spawnSync(process.execPath, commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      CONVERSATION_BENCH_WIDTH: String(profile.width),
      CONVERSATION_BENCH_HEIGHT: String(profile.height),
      CONVERSATION_BENCH_COLOR_SCHEME: profile.colorScheme,
    },
    maxBuffer: 128 * 1024 * 1024,
  });
  const report = parseChildReport(child.stdout);
  const passed = child.status === 0
    && report?.stage === "conversation-render"
    && report?.health?.status === "pass";
  results.push({
    ...profile,
    status: passed ? "pass" : report?.stage === "skipped" ? "skipped" : "fail",
    exitCode: child.status,
    signal: child.signal || "",
    error: child.error?.message || (!report ? String(child.stderr || child.stdout || "").slice(0, 4000) : ""),
    review: report?.artifacts?.visualAuditReview || "",
    audit: summarizeAudit(report?.result?.visualAudit),
    healthFailures: report?.health?.checks?.filter(item => item.status === "fail") || [],
  });
}

const summary = {
  stage: "conversation-visual-audit-matrix",
  fixture,
  outputDir,
  status: results.every(item => item.status === "pass") ? "pass" : "fail",
  profiles: results,
};
writeJson(join(outputDir, "matrix-report.json"), summary);
writeFileSync(join(outputDir, "index.html"), renderMatrixHtml(summary), "utf8");
console.log(JSON.stringify(summary, null, args.json ? 0 : 2));
if (summary.status !== "pass") process.exitCode = 1;

function selectProfiles(value) {
  const catalog = [
    { id: "narrow-light", width: 360, height: 780, colorScheme: "light" },
    { id: "sidepanel-light", width: 430, height: 900, colorScheme: "light" },
    { id: "wide-light", width: 900, height: 900, colorScheme: "light" },
    { id: "sidepanel-dark", width: 430, height: 900, colorScheme: "dark" },
  ];
  if (!value || value === true || value === "all") return catalog;
  const wanted = new Set(String(value).split(",").map(item => item.trim()).filter(Boolean));
  const selected = catalog.filter(profile => wanted.has(profile.id));
  if (!selected.length) throw new Error(`Unknown visual audit profiles: ${Array.from(wanted).join(", ")}`);
  return selected;
}

function summarizeAudit(audit = null) {
  if (!audit) return null;
  return {
    actionCount: audit.actionCount,
    actionableKinds: audit.actionableKinds,
    exercisedKinds: audit.exercisedKinds,
    unexercisedKinds: audit.unexercisedKinds,
    clickFailures: audit.clickFailures,
    errorCount: audit.errorCount,
    warningCount: audit.warningCount,
    maxStableMovementPx: audit.maxStableMovementPx,
    maxUnexpectedLayoutShift: audit.maxUnexpectedLayoutShift,
  };
}

function parseChildReport(stdout = "") {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch (_err) {}
    }
    return null;
  }
}

function renderMatrixHtml(summary) {
  const cards = summary.profiles.map(profile => {
    const audit = profile.audit || {};
    const review = profile.review ? relativeReviewPath(summary.outputDir, profile.review) : "";
    return `
      <article class="profile ${profile.status}">
        <header><span class="dot"></span><strong>${escapeHtml(profile.id)}</strong><span>${escapeHtml(profile.status)}</span></header>
        <p>${profile.width} × ${profile.height} · ${escapeHtml(profile.colorScheme)}</p>
        <dl>
          <div><dt>已点击</dt><dd>${escapeHtml(audit.exercisedKinds ?? "-")} / ${escapeHtml(audit.actionableKinds ?? "-")}</dd></div>
          <div><dt>错误</dt><dd>${escapeHtml(audit.errorCount ?? "-")}</dd></div>
          <div><dt>警告</dt><dd>${escapeHtml(audit.warningCount ?? "-")}</dd></div>
          <div><dt>稳定漂移</dt><dd>${escapeHtml(audit.maxStableMovementPx ?? "-")} px</dd></div>
        </dl>
        ${review ? `<a href="${escapeHtml(review)}">查看交互帧与覆盖矩阵</a>` : `<span class="error">${escapeHtml(profile.error || "没有生成审计报告")}</span>`}
      </article>
    `;
  }).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>轻舟 Chat 视觉审计矩阵</title><style>
    :root{color-scheme:light dark;--bg:#f7f8f8;--panel:#fff;--line:#e3e7e5;--text:#202423;--muted:#7b8380;--ok:#2f8f70;--bad:#b94b4b}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(1120px,100%);margin:auto;padding:32px}h1{font-size:24px;margin:0}main>p{color:var(--muted);margin:5px 0 22px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.profile{background:var(--panel);border:1px solid var(--line);padding:16px}.profile header{display:flex;align-items:center;gap:8px}.profile header span:last-child{margin-left:auto;color:var(--muted)}.dot{width:7px;height:7px;border-radius:50%;background:var(--ok)}.fail .dot,.skipped .dot{background:var(--bad)}.profile p{color:var(--muted)}dl{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);margin:14px 0}dl div{padding:9px;border-right:1px solid var(--line)}dl div:last-child{border:0}dt{font-size:11px;color:var(--muted)}dd{margin:2px 0 0;font-weight:600}.profile a{color:inherit;text-underline-offset:3px}.error{color:var(--bad)}@media(max-width:700px){main{padding:18px}.grid{grid-template-columns:1fr}dl{grid-template-columns:repeat(2,1fr)}dl div:nth-child(2){border-right:0}}@media(prefers-color-scheme:dark){:root{--bg:#141716;--panel:#1b1f1e;--line:#303533;--text:#edf0ef;--muted:#9ba3a0;--ok:#65b99a;--bad:#e57a7a}}
  </style></head><body><main><h1>Chat 视觉审计矩阵</h1><p>同一套真实交互在不同视口和配色下逐项执行。任一控件未覆盖、点击失败或视觉健康检查失败，矩阵即失败。</p><section class="grid">${cards}</section></main></body></html>`;
}

function relativeReviewPath(root, file) {
  const normalizedRoot = `${resolve(root)}/`;
  const normalizedFile = resolve(file);
  return normalizedFile.startsWith(normalizedRoot) ? normalizedFile.slice(normalizedRoot.length) : normalizedFile;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    if (inlineValue != null) out[key] = inlineValue;
    else if (key === "json") out[key] = true;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) out[key] = argv[++index];
    else out[key] = true;
  }
  return out;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
