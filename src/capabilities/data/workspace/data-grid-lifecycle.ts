type GridState = "empty" | "building" | "ready" | "updating" | "disposed";
const GRID_STATES = new Set<string>(["empty", "building", "ready", "updating", "disposed"]);

export function createDataGridLifecycle() {
  let state: GridState = "empty";
  let generation = 0;

  function begin(nextState: GridState = "building") {
    generation += 1;
    setState(nextState);
    return generation;
  }

  function transition(nextState: GridState, expectedGeneration = generation) {
    if (!isCurrent(expectedGeneration)) return false;
    setState(nextState);
    return true;
  }

  function invalidate(nextState: GridState = "empty") {
    generation += 1;
    setState(nextState);
    return generation;
  }

  function isCurrent(expectedGeneration: unknown) {
    return state !== "disposed" && Number(expectedGeneration) === generation;
  }

  function guard<A extends unknown[], R>(callback: (...args: A) => R, expectedGeneration = generation) {
    if (typeof callback !== "function") return () => undefined;
    return (...args: A) => isCurrent(expectedGeneration) ? callback(...args) : undefined;
  }

  function setState(nextState: GridState) {
    if (!GRID_STATES.has(nextState)) throw new Error(`Unknown data grid state: ${nextState}`);
    state = nextState;
  }

  function snapshot() {
    return { state, generation, ready: state === "ready" };
  }

  return {
    begin,
    transition,
    invalidate,
    isCurrent,
    guard,
    snapshot,
    get generation() { return generation; },
  };
}
