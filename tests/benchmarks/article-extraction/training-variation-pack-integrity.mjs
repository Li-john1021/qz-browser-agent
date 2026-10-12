import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const OUTPUT_FORMATS = new Set([
  "markdown", "plain_text", "csv", "json_array", "json_object", "nested_json",
]);
const SPLITS = new Set(["train", "dev", "test"]);

class PackIntegrityError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "PackIntegrityError";
    this.errors = [...errors];
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  const active = new WeakSet();
  const visit = next => {
    if (next === null || typeof next === "string" || typeof next === "boolean") return JSON.stringify(next);
    if (typeof next === "number") {
      if (!Number.isFinite(next)) throw new TypeError("canonical JSON does not support non-finite numbers");
      return JSON.stringify(next);
    }
    if (typeof next !== "object") throw new TypeError(`canonical JSON does not support ${typeof next}`);
    if (active.has(next)) throw new TypeError("canonical JSON does not support cycles");
    active.add(next);
    let result;
    if (Array.isArray(next)) {
      result = `[${next.map(item => visit(item)).join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(next);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON requires plain objects");
      result = `{${Object.keys(next).sort().map(key => `${JSON.stringify(key)}:${visit(next[key])}`).join(",")}}`;
    }
    active.delete(next);
    return result;
  };
  return visit(value);
}

function canonicalSha256(value) {
  return sha256(canonicalJson(value));
}

function digestValue(value) {
  if (Buffer.isBuffer(value)) return sha256(value);
  if (value instanceof Uint8Array) return sha256(Buffer.from(value));
  if (typeof value === "string") return sha256(Buffer.from(value, "utf8"));
  return canonicalSha256(value);
}

function createSourceDigests(sources, { unorderedKeys = ["allowedUrls"] } = {}) {
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) throw new TypeError("sources must be an object");
  const unordered = new Set(unorderedKeys);
  return Object.fromEntries(Object.keys(sources).sort().map(key => {
    let value = sources[key];
    if (unordered.has(key) && Array.isArray(value)) value = [...new Set(value.map(String))].sort();
    return [key, digestValue(value)];
  }));
}

/** Returns fields that may be spread directly onto a persisted variation record. */
function createRecordIntegrity({ identityFields, result, sources, unorderedSourceKeys }) {
  const sourceDigests = createSourceDigests(sources, { unorderedKeys: unorderedSourceKeys });
  const sourceBundleSha256 = canonicalSha256(sourceDigests);
  return Object.freeze({
    integrityAlgorithm: "sha256-canonical-json-v1",
    identity: canonicalSha256({ ...identityFields, sourceDigests }),
    resultSha256: canonicalSha256(result),
    sourceDigests: Object.freeze(sourceDigests),
    sourceBundleSha256,
  });
}

function validateRecordRevalidationPreconditions(record, {
  identityFields,
  sources,
  unorderedSourceKeys,
  expectedFields = {},
  expectedSchema,
  variationCount = 2,
  revalidateResult,
} = {}) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) return ["record must be an object"];
  if (record.accepted !== true) errors.push("record is not accepted");
  if (expectedSchema && record.schema !== expectedSchema) errors.push("record schema mismatch");
  if (Array.isArray(record.validationErrors) && record.validationErrors.length) errors.push("record contains validation errors");
  for (const [key, expected] of Object.entries(expectedFields)) {
    try {
      if (canonicalJson(record[key]) !== canonicalJson(expected)) errors.push(`record field mismatch: ${key}`);
    } catch (_error) {
      errors.push(`record field is not canonicalizable: ${key}`);
    }
  }
  if (!Array.isArray(record.result?.variations) || record.result.variations.length !== variationCount) {
    errors.push(`record result must contain exactly ${variationCount} variations`);
  }
  let expectedIntegrity;
  try {
    expectedIntegrity = createRecordIntegrity({ identityFields, result: record.result, sources, unorderedSourceKeys });
  } catch (error) {
    errors.push(`could not compute expected integrity: ${error.message}`);
  }
  if (expectedIntegrity) {
    if (record.identity !== expectedIntegrity.identity) errors.push("record identity mismatch");
    if (record.resultSha256 !== expectedIntegrity.resultSha256) errors.push("record resultSha256 mismatch");
    if (record.sourceBundleSha256 !== expectedIntegrity.sourceBundleSha256) errors.push("record sourceBundleSha256 mismatch");
    try {
      if (canonicalJson(record.sourceDigests) !== canonicalJson(expectedIntegrity.sourceDigests)) errors.push("record source digests mismatch");
    } catch (_error) {
      errors.push("record source digests are invalid");
    }
  }
  if (typeof revalidateResult === "function") {
    try {
      const validationErrors = revalidateResult(record.result);
      if (!Array.isArray(validationErrors)) errors.push("result revalidator must return an array");
      else errors.push(...validationErrors.map(error => `result revalidation failed: ${error}`));
    } catch (error) {
      errors.push(`result revalidation threw: ${error.message}`);
    }
  }
  return [...new Set(errors)];
}

function assertRecordRevalidationPreconditions(record, expected) {
  const errors = validateRecordRevalidationPreconditions(record, expected);
  if (errors.length) throw new PackIntegrityError("variation record failed packing preconditions", errors);
  return record;
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!bytesWritten) throw new Error("short write while creating JSONL");
    offset += bytesWritten;
  }
}

async function writeJsonlAtomic(path, rows) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  let count = 0;
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    handle = await open(temporary, "wx", 0o600);
    for await (const row of rows) {
      const serialized = JSON.stringify(row)
        ?.replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
      if (serialized === undefined) throw new TypeError("JSONL row is not JSON serializable");
      const buffer = Buffer.from(`${serialized}\n`, "utf8");
      await writeAll(handle, buffer);
      hash.update(buffer);
      bytes += buffer.length;
      count += 1;
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
    return { path: target, rows: count, bytes, sha256: hash.digest("hex") };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function safeRelative(root, path) {
  const value = String(path).replaceAll("\\", "/");
  if (!value || isAbsolute(value) || value.split("/").includes("..")) throw new PackIntegrityError(`unsafe artifact path: ${path}`);
  const target = resolve(root, value);
  const rel = relative(resolve(root), target);
  if (rel.startsWith(`..${sep}`) || rel === "..") throw new PackIntegrityError(`artifact escapes root: ${path}`);
  return { target, relative: rel.split(sep).join("/") };
}

async function hashFile(path) {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes += chunk.length;
    }
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function enumerateArtifactManifest(root, { include, exclude = ["manifest.json"] } = {}) {
  const base = resolve(root);
  const excluded = new Set(exclude.map(value => String(value).replaceAll("\\", "/")));
  const paths = [];
  const walk = async relativeDirectory => {
    const directory = resolve(base, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = [relativeDirectory, entry.name].filter(Boolean).join("/");
      if (excluded.has(rel)) continue;
      if (entry.isSymbolicLink()) throw new PackIntegrityError(`artifact symlink is not allowed: ${rel}`);
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile()) paths.push(rel);
    }
  };
  if (include) {
    for (const path of include) {
      const safe = safeRelative(base, path);
      const stats = await lstat(safe.target);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new PackIntegrityError(`artifact is not a regular file: ${safe.relative}`);
      if (!excluded.has(safe.relative)) paths.push(safe.relative);
    }
  } else {
    await walk("");
  }
  const result = {};
  for (const rel of [...new Set(paths)].sort()) result[rel] = await hashFile(resolve(base, rel));
  return result;
}

async function auditExactArtifactSet(root, expectedPaths) {
  const expected = new Set(expectedPaths.map(path => safeRelative(root, path).relative));
  const files = await enumerateArtifactManifest(root, { exclude: [] });
  const actual = new Set(Object.keys(files));
  const errors = [];
  for (const path of [...expected].sort()) if (!actual.has(path)) errors.push(`missing artifact: ${path}`);
  for (const path of [...actual].sort()) if (!expected.has(path)) errors.push(`unexpected artifact: ${path}`);
  return { ok: errors.length === 0, errors, expected: expected.size, actual: actual.size, files };
}

async function readJsonlRows(path, onRow) {
  const stream = createReadStream(path, { encoding: "utf8" });
  let count = 0;
  let pending = "";
  const parseLine = async rawLine => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim()) throw new PackIntegrityError(`${path}: blank JSONL line ${count + 1}`);
    let row;
    try { row = JSON.parse(line); } catch (error) {
      throw new PackIntegrityError(`${path}: invalid JSON on line ${count + 1}: ${error.message}`);
    }
    await onRow(row, count);
    count += 1;
  };
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        await parseLine(line);
      }
    }
    if (pending.length) await parseLine(pending);
  } finally {
    stream.destroy();
  }
  return count;
}

function expectedRowMap(rows) {
  const result = new Map();
  for (const row of rows || []) result.set(row.sample_id, row);
  return result;
}

/** Read back the actual index, SFT shards, and output files after packing. */
async function auditPersistedTrainingArtifacts({
  root,
  pages,
  expectedTasksByPage,
  expectedRows,
  expectedSystem,
  goldPathForPage,
}) {
  const errors = [];
  const expectedById = expectedRowMap(expectedRows);
  const pageById = new Map(pages.map(page => [page.id, page]));
  const physicalRows = [];
  const sftExpected = { train: [], dev: [], test: [] };
  let outputArtifacts = 0;
  let t0Checked = 0;
  try {
    await readJsonlRows(resolve(root, "samples_index.jsonl"), row => {
      const id = String(row?.sample_id || "");
      const expected = expectedById.get(id);
      if (!expected) errors.push(`${id || "<missing>"}: index row was not generated by this pack run`);
      else {
        for (const key of ["page_id", "task_idx", "task_type", "output_format", "split"]) {
          if (row[key] !== expected[key]) errors.push(`${id}: persisted ${key} mismatch`);
        }
        if (sha256(String(row.prompt ?? "")) !== expected.prompt_sha256) errors.push(`${id}: persisted prompt mismatch`);
        if (sha256(String(row.output ?? "")) !== expected.output_sha256) errors.push(`${id}: persisted output mismatch`);
      }
      const output = Buffer.from(String(row?.output ?? ""), "utf8");
      if (row?.answer_sha256 !== sha256(output)) errors.push(`${id}: answer_sha256 does not match index output`);
      const outputPath = resolve(root, "outputs", `${id}.txt`);
      if (!existsSync(outputPath)) errors.push(`${id}: output artifact is missing`);
      else {
        const artifact = readFileSync(outputPath);
        outputArtifacts += 1;
        if (!artifact.equals(output)) errors.push(`${id}: output artifact differs from index output`);
      }
      if (row?.task_idx === 0) {
        const page = pageById.get(row.page_id);
        if (!page) errors.push(`${id}: t0 references an unknown page`);
        else {
          const gold = readFileSync(goldPathForPage(page));
          t0Checked += 1;
          if (!gold.equals(output)) errors.push(`${id}: t0 is not byte-exact gold Markdown`);
        }
      }
      physicalRows.push({
        sample_id: id,
        page_id: row?.page_id,
        task_idx: row?.task_idx,
        task_type: row?.task_type,
        output_format: row?.output_format,
        split: row?.split,
      });
      if (SPLITS.has(row?.split)) sftExpected[row.split].push({
        id,
        promptSha256: sha256(String(row.prompt ?? "")),
        outputSha256: sha256(String(row.output ?? "")),
      });
    });
  } catch (error) {
    errors.push(error.message);
  }
  const inventory = auditTaskInventory({ pages, indexRows: physicalRows, expectedTasksByPage });
  errors.push(...inventory.errors);
  const assignment = Object.fromEntries(physicalRows.map(row => [row.page_id, row.split]));
  const splitAudit = auditPageGroupSplits({ pages, indexRows: physicalRows, assignment });
  errors.push(...splitAudit.errors);
  const sftCounts = { train: 0, dev: 0, test: 0 };
  for (const split of SPLITS) {
    try {
      sftCounts[split] = await readJsonlRows(resolve(root, `sft_${split}.jsonl`), (row, index) => {
        const expected = sftExpected[split][index];
        if (!expected) {
          errors.push(`sft_${split}.jsonl: unexpected row ${index + 1}`);
          return;
        }
        const messages = row?.messages;
        if (!Array.isArray(messages) || messages.length !== 3
          || messages[0]?.role !== "system" || messages[1]?.role !== "user" || messages[2]?.role !== "assistant") {
          errors.push(`${expected.id}: invalid SFT message envelope`);
          return;
        }
        if (messages[0].content !== expectedSystem) errors.push(`${expected.id}: SFT system prompt mismatch`);
        if (sha256(String(messages[1].content ?? "")) !== expected.promptSha256) errors.push(`${expected.id}: SFT user prompt differs from index`);
        if (sha256(String(messages[2].content ?? "")) !== expected.outputSha256) errors.push(`${expected.id}: SFT assistant differs from index`);
      });
      if (sftCounts[split] !== sftExpected[split].length) {
        errors.push(`sft_${split}.jsonl row count mismatch: expected ${sftExpected[split].length}, found ${sftCounts[split]}`);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }
  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    indexTasks: physicalRows.length,
    sftTasks: Object.values(sftCounts).reduce((sum, count) => sum + count, 0),
    sft: sftCounts,
    outputArtifacts,
    t0Checked,
    inventory: { ok: inventory.ok, pages: inventory.pages, tasks: inventory.tasks },
    splitIsolation: { ok: splitAudit.ok, counts: splitAudit.counts, groups: splitAudit.groups },
  };
}

async function replaceDirectoryFromStaging(stagingPath, targetPath) {
  const staging = resolve(stagingPath);
  const target = resolve(targetPath);
  if (dirname(staging) !== dirname(target) || staging === target) {
    throw new PackIntegrityError("staging and target must be distinct sibling directories");
  }
  const backup = `${target}.replaced-${process.pid}-${randomUUID()}`;
  let originalMoved = false;
  try {
    if (existsSync(target)) {
      await rename(target, backup);
      originalMoved = true;
    }
    await rename(staging, target);
  } catch (error) {
    if (originalMoved && !existsSync(target) && existsSync(backup)) await rename(backup, target).catch(() => {});
    throw error;
  }
  if (originalMoved) await rm(backup, { recursive: true, force: true });
  return target;
}

function expectedTasksMap(expectedTasksByPage, pageId) {
  if (!expectedTasksByPage) return null;
  return expectedTasksByPage instanceof Map ? expectedTasksByPage.get(pageId) : expectedTasksByPage[pageId];
}

function auditTaskInventory({ pages, indexRows, expectedTasksByPage, tasksPerPage = 3 }) {
  const errors = [];
  const pageIds = new Set(pages.map(page => page.id));
  if (pageIds.size !== pages.length) errors.push("page IDs are not unique");
  const expectedCount = page => {
    const tasks = expectedTasksMap(expectedTasksByPage, page.id);
    return Array.isArray(tasks) ? tasks.length : tasksPerPage;
  };
  if (expectedTasksByPage) {
    for (const page of pages) {
      const count = expectedCount(page);
      if (count !== 1 && count !== 3) errors.push(`${page.id}: expected task plan must contain exactly 1 or 3 tasks`);
    }
  }
  const expectedIds = new Set(pages.flatMap(page => (
    Array.from({ length: expectedCount(page) }, (_, index) => `${page.id}__t${index}`)
  )));
  const seenIds = new Set();
  const rowsByPage = new Map();
  for (const row of indexRows) {
    if (!pageIds.has(row.page_id)) errors.push(`unknown page_id: ${row.page_id}`);
    if (seenIds.has(row.sample_id)) errors.push(`duplicate sample_id: ${row.sample_id}`);
    seenIds.add(row.sample_id);
    if (!rowsByPage.has(row.page_id)) rowsByPage.set(row.page_id, []);
    rowsByPage.get(row.page_id).push(row);
    const pageTaskCount = expectedTasksMap(expectedTasksByPage, row.page_id)?.length ?? tasksPerPage;
    if (!Number.isInteger(row.task_idx) || row.task_idx < 0 || row.task_idx >= pageTaskCount) errors.push(`${row.sample_id}: invalid task_idx`);
    else if (row.sample_id !== `${row.page_id}__t${row.task_idx}`) errors.push(`${row.sample_id}: sample_id/task_idx mismatch`);
    if (!OUTPUT_FORMATS.has(row.output_format)) errors.push(`${row.sample_id}: unsupported output_format`);
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(String(row.task_type || ""))) errors.push(`${row.sample_id}: invalid semantic task_type`);
    const expected = expectedTasksMap(expectedTasksByPage, row.page_id)?.[row.task_idx];
    if (expected) {
      if (row.task_type !== expected.taskType) errors.push(`${row.sample_id}: task_type does not preserve teacher taskType`);
      if (row.output_format !== expected.outputFormat) errors.push(`${row.sample_id}: output_format does not preserve teacher outputFormat`);
    }
  }
  for (const expected of expectedIds) if (!seenIds.has(expected)) errors.push(`missing task: ${expected}`);
  for (const actual of seenIds) if (!expectedIds.has(actual)) errors.push(`unexpected task: ${actual}`);
  for (const page of pages) {
    const rows = rowsByPage.get(page.id) || [];
    const pageTaskCount = expectedCount(page);
    if (rows.length !== pageTaskCount) errors.push(`${page.id}: expected ${pageTaskCount} tasks, found ${rows.length}`);
    const indices = new Set(rows.map(row => row.task_idx));
    if (indices.size !== pageTaskCount) errors.push(`${page.id}: task indices are incomplete or duplicated`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], pages: pages.length, tasks: indexRows.length };
}

function auditT0ExactBytes({ pages, indexRows, goldPathForPage, outputPathForTask }) {
  const errors = [];
  const t0ByPage = new Map(indexRows.filter(row => row.task_idx === 0).map(row => [row.page_id, row]));
  for (const page of pages) {
    const row = t0ByPage.get(page.id);
    if (!row) {
      errors.push(`${page.id}: missing t0`);
      continue;
    }
    const gold = readFileSync(goldPathForPage(page));
    const indexed = Buffer.from(String(row.output ?? ""), "utf8");
    if (!indexed.equals(gold)) errors.push(`${page.id}: t0 index output is not byte-exact gold Markdown`);
    if (row.answer_sha256 && row.answer_sha256 !== sha256(gold)) errors.push(`${page.id}: t0 answer_sha256 mismatch`);
    if (outputPathForTask) {
      const artifact = readFileSync(outputPathForTask(row, page));
      if (!artifact.equals(gold)) errors.push(`${page.id}: t0 output artifact is not byte-exact gold Markdown`);
    }
  }
  return { ok: errors.length === 0, errors, checked: pages.length };
}

function pageGroup(page) {
  let host = "";
  try { host = new URL(page.finalUrl || page.url).hostname; } catch (_error) { /* use fallback */ }
  return String(page.siteId || host || page.id);
}

function auditPageGroupSplits({ pages, indexRows = [], assignment = {} }) {
  const errors = [];
  const groupSplits = new Map();
  const counts = { train: 0, dev: 0, test: 0 };
  const pageIds = new Set(pages.map(page => page.id));
  for (const page of pages) {
    const split = assignment[page.id];
    if (!SPLITS.has(split)) {
      errors.push(`${page.id}: missing or invalid page split`);
      continue;
    }
    counts[split] += 1;
    const group = pageGroup(page);
    if (groupSplits.has(group) && groupSplits.get(group) !== split) errors.push(`page group leaks across splits: ${group}`);
    groupSplits.set(group, split);
  }
  for (const row of indexRows) {
    if (!pageIds.has(row.page_id)) continue;
    if (row.split !== assignment[row.page_id]) errors.push(`${row.sample_id}: task split differs from page split`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], counts, groups: groupSplits.size };
}

function assertAudit(audit, message = "training variation pack integrity audit failed") {
  if (!audit?.ok) throw new PackIntegrityError(message, audit?.errors || ["invalid audit result"]);
  return audit;
}

export {
  OUTPUT_FORMATS,
  PackIntegrityError,
  assertAudit,
  assertRecordRevalidationPreconditions,
  auditExactArtifactSet,
  auditPageGroupSplits,
  auditPersistedTrainingArtifacts,
  auditT0ExactBytes,
  auditTaskInventory,
  canonicalJson,
  canonicalSha256,
  createRecordIntegrity,
  createSourceDigests,
  enumerateArtifactManifest,
  hashFile,
  readJsonlRows,
  replaceDirectoryFromStaging,
  sha256,
  validateRecordRevalidationPreconditions,
  writeJsonlAtomic,
};
