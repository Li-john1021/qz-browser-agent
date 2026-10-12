import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class BuildOutputLockedError extends Error {
  constructor(outputDir, owner, alreadyWatching) {
    super(`Build output is locked by PID ${owner.pid}: ${outputDir}. Stop that process or use --output-dir for a separate build.`);
    this.owner = owner;
    this.outputDir = outputDir;
    this.alreadyWatching = alreadyWatching;
  }
}

/** Publish a complete owner atomically; recovery and release can only remove that owner's file. */
export async function acquireBuildOutput(options, { watch = false } = {}) {
  const { outputDir, sourceDir, mode = "development", product, bundle = mode === "production", debugMaps = false } = options;
  const lock = resolve(dirname(outputDir), `.${basename(outputDir)}.qingzhou-build-lock`);
  const owner = {
    pid: process.pid, token: randomUUID(), watch,
    launcherPid: watch ? options.launcherPid : undefined,
    config: { sourceDir, mode, product: product ?? null, bundle, debugMaps },
  };
  const filename = `owner-${owner.pid}-${owner.token}.json`;
  await mkdir(dirname(lock), { recursive: true });
  const candidate = await mkdtemp(`${lock}-`);
  let shutdownDeadline;
  try {
    await writeFile(resolve(candidate, filename), JSON.stringify(owner));
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        // Replacing a populated directory fails. An empty directory is a completed release.
        await rename(candidate, lock);
        return () => removeOwner(lock, filename);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      }
      let entries;
      try { entries = await readdir(lock); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!entries.length) { await removeOwner(lock); continue; }
      const existing = entries[0];
      if (entries.length !== 1 || !/^(?:owner|owner-\d+-[a-f0-9-]+)\.json$/.test(existing)) {
        throw new Error(`Unrecognized build lock contents: ${lock}`);
      }
      let current;
      try { current = JSON.parse(await readFile(resolve(lock, existing), "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw new Error(`Cannot read build lock owner: ${lock}`, { cause: error }); }
      if (!Number.isSafeInteger(current?.pid) || current.pid <= 0) throw new Error(`Invalid build lock owner: ${lock}`);
      if (isRunning(current.pid)) {
        // npm may exit before its watcher finishes cancelling a build. Wait for the writer
        // to release ownership; treating it as an active dev command would lose the restart.
        if (current.watch && Number.isSafeInteger(current.launcherPid)
          && (current.launcherPid <= 1 || !isRunning(current.launcherPid))) {
          shutdownDeadline ??= Date.now() + 10_000;
          if (Date.now() < shutdownDeadline) {
            await delay(50, undefined, { signal: options.signal });
            continue;
          }
          throw new BuildOutputLockedError(outputDir, current, false);
        }
        const alreadyWatching = watch && current.watch === true
          && Object.entries(owner.config).every(([key, value]) => current.config?.[key] === value);
        throw new BuildOutputLockedError(outputDir, current, alreadyWatching);
      }
      // owner.json is the previous lock format; newly acquired locks always use unique names.
      await removeOwner(lock, existing);
    }
  } finally {
    // This is our private staging directory, never the shared lock path.
    await rm(candidate, { recursive: true, force: true });
  }
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function removeOwner(lock, filename) {
  if (filename) {
    try { await unlink(resolve(lock, filename)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // Another contender may have claimed the empty directory already. Never remove it recursively.
  try { await rmdir(lock); }
  catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
}
