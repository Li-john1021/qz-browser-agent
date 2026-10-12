import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverRealExamples } from "../benchmarks/conversation-render/tools/real-examples.mjs";
import { benchmarkCommand } from "../benchmarks/run.mjs";

test("private corpus discovers exports deterministically without stub, directories or symlinks", t => {
  const directory = mkdtempSync(join(tmpdir(), "qz-real-examples-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ["stub.json", "README.md", ".hidden.json", "z.HTML", "a session.json", "b.htm"]) {
    writeFileSync(join(directory, name), "{}");
  }
  mkdirSync(join(directory, "nested.html"));
  symlinkSync(join(directory, "z.HTML"), join(directory, "linked.html"));
  assert.deepEqual(discoverRealExamples(directory), ["a session.json", "b.htm", "z.HTML"].map(name => join(directory, name)));
});

test("stub alone cannot produce a false passing real-corpus run", t => {
  const directory = mkdtempSync(join(tmpdir(), "qz-empty-examples-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "stub.json"), "{}");
  assert.throws(() => discoverRealExamples(directory), /No real examples found/);
});

test("real corpus is explicit and preserves benchmark modes and health gates", () => {
  const plan = benchmarkCommand(["conversation", "--real-examples", "--mode", "snapshot-render"]);
  assert.deepEqual(plan.args, ["tests/benchmarks/conversation-render/run.mjs", "--mode", "all", "--json", "--fail-on-health", "--real-examples", "--mode", "snapshot-render"]);
  assert.ok(!benchmarkCommand([]).args.includes("--real-examples"));
});

test("Git ignores every private sample path but keeps the synthetic stub and instructions", t => {
  const repository = mkdtempSync(join(tmpdir(), "qz-ignore-policy-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", repository]);
  writeFileSync(join(repository, ".gitignore"), readFileSync(".gitignore"));
  const directory = "tests/benchmarks/conversation-render/real_examples/";
  const names = ["private conversation.html", "sample.json", "nested/export.html", "notes.txt", "README.md", "stub.json"];
  // --no-index also checks tracked documentation; fabricated paths need not exist.
  const result = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: repository, input: names.map(name => directory + name).join("\n") + "\n", encoding: "utf8",
  }).trim().split("\n");
  assert.deepEqual(result, names.slice(0, 4).map(name => directory + name));
  const stub = JSON.parse(readFileSync(directory + "stub.json", "utf8"));
  assert.equal(stub.transcript.length, 2);
  assert.match(stub.name, /Synthetic/);
});

test("viewport corpus is explicit, validates content, and parses HTML as data", async t => {
  const { loadFuzzCorpus } = await import("../support/fuzz-corpus.mjs");
  const directory = mkdtempSync(join(tmpdir(), "qz-fuzz-corpus-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const transcript = [{ type: "tool", name: "read_page", result: {} }];
  writeFileSync(join(directory, "fixture.json"), JSON.stringify({ transcript }));
  writeFileSync(join(directory, "fixture.html"), `<script>throw new Error("must not execute")</script><script id="qingzhou-session-exchange" type="application/json">${JSON.stringify({ format: "qingzhou.session", version: 1, session: { transcript } })}</script>`);
  writeFileSync(join(directory, "corpus.json"), JSON.stringify(["fixture.html", "fixture.json"]));
  assert.equal(loadFuzzCorpus(directory, undefined, ["fixture.json"]).length, 1);
  const [html, json] = loadFuzzCorpus(directory, "corpus.json");
  assert.deepEqual(json.transcript, transcript);
  assert.equal(html.transcript[0].name, "read_page");
  assert.equal(html.transcript[0].type, "tool");
  assert.deepEqual(html.transcript[0].result, {});
  assert.equal(html.transcript[0].argsState, "final_empty");
  for (const invalid of [[], {}, [""]]) {
    writeFileSync(join(directory, "bad.json"), JSON.stringify(invalid));
    assert.throws(() => loadFuzzCorpus(directory, "bad.json"), /non-empty JSON array/);
  }
  writeFileSync(join(directory, "empty.json"), JSON.stringify({ transcript: [] }));
  assert.throws(() => loadFuzzCorpus(directory, undefined, ["empty.json"]), /no tool entries/);
  assert.throws(() => loadFuzzCorpus(directory, undefined, ["missing.json"]), /ENOENT/);
});
