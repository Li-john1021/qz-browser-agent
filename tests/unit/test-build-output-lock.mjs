import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireBuildOutput, BuildOutputLockedError } from "../../scripts/build-output-lock.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "qingzhou-build-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { lock: join(root, ".output.qingzhou-build-lock"), options: { sourceDir: join(root, "source"), outputDir: join(root, "output"), mode: "development" } };
}

test("only an identical live watcher counts as an already-running dev command", async t => {
  const { options, lock } = await fixture(t);
  const release = await acquireBuildOutput(options, { watch: true });
  try {
    await assert.rejects(acquireBuildOutput(options, { watch: true }), error => {
      assert.ok(error instanceof BuildOutputLockedError);
      assert.equal(error.alreadyWatching, true);
      assert.equal(error.owner.pid, process.pid);
      return true;
    });
    for (const different of [{ mode: "production" }, { sourceDir: join(options.sourceDir, "other") }, { product: "public" }, { bundle: true }, { debugMaps: true }]) {
      await assert.rejects(acquireBuildOutput({ ...options, ...different }, { watch: true }), error => {
        assert.equal(error.alreadyWatching, false);
        return true;
      });
    }
    await assert.rejects(acquireBuildOutput(options), error => !error.alreadyWatching);
    assert.equal((await readdir(lock)).length, 1);
  } finally { await release(); }
});

test("an old release cannot delete its successor's ownership", async t => {
  const { options, lock } = await fixture(t);
  const oldRelease = await acquireBuildOutput(options);
  await oldRelease();
  const release = await acquireBuildOutput(options);
  const before = await readdir(lock);
  await oldRelease();
  assert.deepEqual(await readdir(lock), before);
  await assert.rejects(acquireBuildOutput(options), BuildOutputLockedError);
  await release();
  await release();
  await assert.rejects(access(lock), { code: "ENOENT" });
});

test("a restart waits for a launcher-less watcher to release its output", async t => {
  const { options, lock } = await fixture(t);
  const release = await acquireBuildOutput({ ...options, launcherPid: 2147483647 }, { watch: true });
  let acquired = false;
  const restarting = acquireBuildOutput(options, { watch: true }).then(release => { acquired = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(acquired, false, "the old writer still owns its output while shutting down");
  assert.equal((await readdir(lock)).length, 1);
  await release();
  const stop = await restarting;
  assert.equal(acquired, true);
  await stop();
});

test("cancelling a restart leaves the shutting-down writer's lock intact", async t => {
  const { options, lock } = await fixture(t);
  const release = await acquireBuildOutput({ ...options, launcherPid: 2147483647 }, { watch: true });
  const before = await readdir(lock);
  const controller = new AbortController();
  const pending = acquireBuildOutput({ ...options, signal: controller.signal }, { watch: true });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    controller.abort();
    await rejected;
    assert.deepEqual(await readdir(lock), before);
  } finally { await release(); }
});

test("a killed owner is recovered by exactly one of several contenders", { timeout: 10_000 }, async t => {
  const { options, lock } = await fixture(t);
  const moduleUrl = new URL("../../scripts/build-output-lock.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireBuildOutput } from ${JSON.stringify(moduleUrl)};
    await acquireBuildOutput(${JSON.stringify(options)}, { watch: true });
    process.send("ready");
    setInterval(() => {}, 1000);
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  assert.deepEqual(await once(child, "message"), ["ready", undefined]);
  await assert.rejects(acquireBuildOutput(options), BuildOutputLockedError);
  child.kill("SIGKILL");
  await exited;
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => acquireBuildOutput(options)));
  const owners = results.filter(result => result.status === "fulfilled");
  try {
    assert.equal(owners.length, 1, "recovery must not steal a newly acquired lock");
    for (const result of results.filter(result => result.status === "rejected")) assert.ok(result.reason instanceof BuildOutputLockedError);
    const files = await readdir(lock);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(await readFile(join(lock, files[0]), "utf8")).pid, process.pid);
  } finally { await Promise.all(owners.map(result => result.value())); }
});

test("legacy dead-owner and empty locks recover without removing output", async t => {
  const { options, lock } = await fixture(t);
  const deadPid = 2147483647;
  assert.throws(() => process.kill(deadPid, 0), { code: "ESRCH" });
  await mkdir(options.outputDir);
  await writeFile(join(options.outputDir, "previous.txt"), "last successful build");
  for (const legacy of [true, false]) {
    await mkdir(lock);
    if (legacy) await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: deadPid, token: "old-format" }));
    const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => acquireBuildOutput(options)));
    const owners = attempts.filter(result => result.status === "fulfilled");
    try {
      assert.equal(owners.length, 1);
      assert.equal(await readFile(join(options.outputDir, "previous.txt"), "utf8"), "last successful build");
    } finally { await Promise.all(owners.map(result => result.value())); }
  }
});

test("live legacy and unrecognized locks are preserved", async t => {
  const { options, lock } = await fixture(t);
  await mkdir(lock);
  for (const contents of [JSON.stringify({ pid: process.pid, token: "old-live-owner" }), "{", JSON.stringify({ pid: 0 })]) {
    await writeFile(join(lock, "owner.json"), contents);
    await assert.rejects(acquireBuildOutput(options));
    assert.equal(await readFile(join(lock, "owner.json"), "utf8"), contents);
  }
});

test("cancellation cleans the candidate without acquiring or releasing another owner's lock", async t => {
  const { options, lock } = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error("cancelled fixture"));
  await assert.rejects(acquireBuildOutput({ ...options, signal: controller.signal }), /cancelled fixture/);
  await assert.rejects(access(lock), { code: "ENOENT" });
  const release = await acquireBuildOutput(options);
  try {
    const before = await readdir(lock);
    await assert.rejects(acquireBuildOutput({ ...options, signal: controller.signal }), /cancelled fixture/);
    assert.deepEqual(await readdir(lock), before);
  } finally { await release(); }
});
