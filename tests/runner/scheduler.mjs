import { spawn } from "node:child_process";

// A run owns its child processes and dependency signals. Exclusive measurements
// start only after every ordinary resource lane has settled successfully.
export async function runTasks(tasks, { root: ROOT, jobs: testJobs, selected }) {
  const timings = [];
  const startedAt = performance.now();
  const activeChildren = new Set();
  const completionSignals = createCompletionSignals(tasks);
  let stopping = false;
  let firstFailure = null;
  let receivedSignal = "";

  const handleSignal = signal => {
    if (receivedSignal) return;
    receivedSignal = signal;
    stopping = true;
    releasePendingDependencies();
    stopActiveChildren(signal);
  };
  const handleSigint = () => handleSignal("SIGINT");
  const handleSigterm = () => handleSignal("SIGTERM");
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  const orderedTasks = orderTasksByDependencies(tasks);
  const { ordinaryTasks, exclusiveTasks } = partitionTaskPhases(orderedTasks);
  const taskWorkers = createTaskWorkers(ordinaryTasks, testJobs);
  console.log(`\nRunning ${tasks.length} test commands with ${Math.max(1, taskWorkers.length)} jobs`);
  await Promise.all(taskWorkers.map(queue => runTaskWorker(queue)));
  if (!stopping && exclusiveTasks.length) {
    console.log(`\nRunning ${exclusiveTasks.length} timing-sensitive commands exclusively`);
    await runTaskWorker({ tasks: exclusiveTasks, index: 0 });
  }

  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);

  if (receivedSignal) {
    console.error(`\nInterrupted by ${receivedSignal}`);
    process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
  } else if (firstFailure) {
    console.error(`\nFAILED ${firstFailure.suite} after ${formatDuration(firstFailure.elapsedMs)}: ${firstFailure.label}`);
    process.exitCode = firstFailure.exitCode;
  }

  const totalMs = performance.now() - startedAt;
  if (!receivedSignal && !firstFailure) {
    console.log(`\n${selected.join(", ")} tests passed · ${formatDuration(totalMs)}`);
    const slowest = [...timings].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 5);
    if (slowest.length > 1) {
      console.log("Slowest commands:");
      slowest.forEach(item => console.log(`  ${formatDuration(item.elapsedMs).padStart(7)}  ${item.suite}: ${item.label}`));
    }
  }

  async function runTaskWorker(queue) {
    while (!stopping) {
      const task = queue.tasks[queue.index];
      queue.index += 1;
      if (!task) return;

      await waitForDependencies(task);
      if (stopping) return;

      const itemStartedAt = performance.now();
      console.log(`\n== ${task.suite} ==`);
      console.log(`$ ${task.label}`);
      const result = await runCommand(task.item);
      const elapsedMs = performance.now() - itemStartedAt;
      timings.push({ suite: task.suite, label: task.label, elapsedMs });
      completionSignals.get(task.item.id)?.resolve();

      if (result.exitCode === 0) {
        console.log(`✓ ${task.suite} · ${formatDuration(elapsedMs)}`);
        continue;
      }
      if (stopping) return;

      firstFailure = { ...task, ...result, elapsedMs };
      stopping = true;
      releasePendingDependencies();
      stopActiveChildren("SIGTERM");
    }
  }

  function createTaskWorkers(allTasks, jobs) {
    if (jobs === 1) return [{ tasks: allTasks, index: 0 }];

    const primaryBrowserTasks = allTasks.filter(task => task.resource === "browser");
    const secondaryBrowserTasks = allTasks.filter(task => task.resource === "browser-secondary");
    const generalTasks = allTasks.filter(task => task.resource === "general");
    const workers = [];

    const canSplitBrowserLanes = primaryBrowserTasks.length
      && secondaryBrowserTasks.length
      && (jobs >= 3 || !generalTasks.length);
    if (canSplitBrowserLanes) {
      workers.push({ tasks: primaryBrowserTasks, index: 0 });
      workers.push({ tasks: secondaryBrowserTasks, index: 0 });
    } else {
      const browserTasks = allTasks.filter(task => task.resource !== "general");
      if (browserTasks.length) workers.push({ tasks: browserTasks, index: 0 });
    }

    if (generalTasks.length) {
      const queue = { tasks: generalTasks, index: 0 };
      const generalJobs = Math.min(generalTasks.length, jobs - workers.length);
      for (let index = 0; index < generalJobs; index += 1) workers.push(queue);
    }
    return workers;
  }

  function partitionTaskPhases(orderedTasks) {
    const ordinaryTasks = orderedTasks.filter(task => !task.item.exclusive);
    const exclusiveTasks = orderedTasks.filter(task => task.item.exclusive);
    const exclusiveIds = new Set(exclusiveTasks.map(task => task.item.id).filter(Boolean));
    for (const task of ordinaryTasks) {
      if ((task.item.after || []).some(id => exclusiveIds.has(id))) {
        throw new Error(`Ordinary test command depends on the later exclusive phase: ${task.item.id || task.label}`);
      }
    }
    return { ordinaryTasks, exclusiveTasks };
  }

  function orderTasksByDependencies(allTasks) {
    const selectedIds = new Set(allTasks.map(task => task.item.id).filter(Boolean));
    const completedIds = new Set();
    const pending = [...allTasks];
    const ordered = [];
    while (pending.length) {
      const index = pending.findIndex(task => (task.item.after || []).every(
        id => !selectedIds.has(id) || completedIds.has(id),
      ));
      if (index < 0) {
        const blocked = pending.map(task => task.item.id || task.label).join(", ");
        throw new Error(`Cyclic test command dependencies: ${blocked}`);
      }
      const [task] = pending.splice(index, 1);
      ordered.push(task);
      if (task.item.id) completedIds.add(task.item.id);
    }
    return ordered;
  }

  function createCompletionSignals(allTasks) {
    const signals = new Map();
    for (const task of allTasks) {
      const id = task.item.id;
      if (!id) continue;
      if (signals.has(id)) throw new Error(`Duplicate test command id: ${id}`);
      let resolve;
      const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
      signals.set(id, { promise, resolve });
    }
    return signals;
  }

  async function waitForDependencies(task) {
    const dependencies = (task.item.after || [])
      .map(id => completionSignals.get(id)?.promise)
      .filter(Boolean);
    if (dependencies.length) await Promise.all(dependencies);
  }

  function releasePendingDependencies() {
    for (const signal of completionSignals.values()) signal.resolve();
  }

  function runCommand(item) {
    const env = { ...process.env };
    Object.assign(env, item.env || {});
    if (item.bin === "uv") {
      delete env.VIRTUAL_ENV;
      delete env.UV_INDEX_URL;
      delete env.UV_EXTRA_INDEX_URL;
    }

    return new Promise(resolve => {
      const child = spawn(item.bin, item.args, {
        cwd: ROOT,
        env,
        stdio: "inherit",
        detached: process.platform !== "win32",
      });
      activeChildren.add(child);
      let settled = false;
      const settle = exitCode => {
        if (settled) return;
        settled = true;
        activeChildren.delete(child);
        resolve({ exitCode });
      };
      child.once("error", error => {
        console.error(error.message);
        settle(1);
      });
      child.once("exit", (code, signal) => settle(code ?? signalExitCode(signal)));
    });
  }

  function stopActiveChildren(signal) {
    for (const child of activeChildren) {
      signalChildProcess(child, signal);
      const timer = setTimeout(() => {
        if (activeChildren.has(child)) signalChildProcess(child, "SIGKILL");
      }, 2_000);
      timer.unref();
    }
  }

  function signalChildProcess(child, signal) {
    try {
      if (process.platform === "win32") child.kill(signal);
      else if (child.pid) process.kill(-child.pid, signal);
    } catch {
      // The process may have exited between the active-set check and the signal.
    }
  }

  function signalExitCode(signal) {
    if (signal === "SIGINT") return 130;
    if (signal === "SIGTERM") return 143;
    return 1;
  }
}

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)}s`;
}
