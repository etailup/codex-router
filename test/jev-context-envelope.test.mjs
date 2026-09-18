import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeCheckpoint } from "../src/compaction-checkpoint.mjs";
import { expandJevContextItems, isJevContextValue, openJevContext, sealJevContext } from "../src/jev-context-envelope.mjs";

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jev-envelope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { keyPath: path.join(directory, "key") };
}
const checkpoint = encodeCheckpoint({});
const context = (role = "developer", text = "Keep original instructions.") => ({ type: "message", role, content: [{ type: "input_text", text }], id: "original-id", metadata: { exact: true } });
const compact = (value) => ({ type: "compaction", id: "compact-id", encrypted_content: value });

test("encrypted roundtrip preserves complete message fields and original roles", (t) => {
  const options = fixture(t);
  const contexts = [context(), context("system")];
  const value = sealJevContext(checkpoint, contexts, options);
  assert.ok(isJevContextValue(value));
  assert.ok(!value.includes("Keep original"));
  assert.deepEqual(openJevContext(value, options), { checkpointValue: checkpoint, contexts });
  const key = readFileSync(options.keyPath);
  sealJevContext(checkpoint, contexts, options);
  assert.deepEqual(readFileSync(options.keyPath), key);
  if (process.platform !== "win32") assert.equal(statSync(options.keyPath).mode & 0o777, 0o600);
});

test("tampered, malformed and wrong-key envelopes fail with bounded generic errors", (t) => {
  const options = fixture(t);
  const value = sealJevContext(checkpoint, [context()], options);
  const bytes = Buffer.from(value.slice(5), "base64");
  bytes[30] ^= 1;
  for (const invalid of ["jvc1:!", "jvc1:", "jvc1:" + bytes.toString("base64"), value + "="]) {
    assert.throws(() => openJevContext(invalid, options), /^Error: Invalid or unavailable Jev context envelope\.$/);
  }
  writeFileSync(options.keyPath, Buffer.alloc(32), { mode: 0o600 });
  assert.throws(() => openJevContext(value, options));
});

test("reading a missing key never creates it; invalid and symlink keys are never replaced", (t) => {
  const options = fixture(t);
  const missing = { keyPath: options.keyPath + "-missing" };
  const value = sealJevContext(checkpoint, [context()], options);
  assert.throws(() => openJevContext(value, missing));
  assert.equal(existsSync(missing.keyPath), false);
  writeFileSync(missing.keyPath, "bad", { mode: 0o600 });
  assert.throws(() => sealJevContext(checkpoint, [], missing));
  assert.equal(readFileSync(missing.keyPath, "utf8"), "bad");
  const link = { keyPath: options.keyPath + "-link" };
  symlinkSync(options.keyPath, link.keyPath);
  assert.throws(() => openJevContext(value, link));
  assert.throws(() => sealJevContext(checkpoint, [], link));
});

test("unprivileged or nontext messages cannot be sealed as protected context", (t) => {
  const options = fixture(t);
  for (const item of [context("user"), context("assistant"), { ...context(), type: "agent_message" }, { ...context(), content: "plain" }, { ...context(), content: [{ type: "input_image", text: "fake" }] }]) {
    assert.throws(() => sealJevContext(checkpoint, [item], options));
  }
  assert.throws(() => sealJevContext("kcr2:invalid", [], options));
  assert.equal(existsSync(options.keyPath), false);
});

test("additional tool registries survive compaction and deduplicate exactly", (t) => {
  const options = fixture(t);
  const tools = { type: "additional_tools", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] };
  const value = sealJevContext(checkpoint, [tools, context()], options);
  assert.deepEqual(openJevContext(value, options).contexts, [tools, context()]);
  assert.deepEqual(expandJevContextItems([compact(value), tools], options), [context(), compact(checkpoint), tools]);
});

test("ordinary traffic is returned unchanged without key reads or envelope limits", (t) => {
  const options = fixture(t);
  const input = [context("developer", "x".repeat(512 * 1024)), compact("native-opaque"), context("user", "jvc1:bad")];
  assert.equal(expandJevContextItems(input, options), input);
  assert.equal(existsSync(options.keyPath), false);
});

test("whole-input exact dedupe preserves ordinary items and does not grow on repeat", (t) => {
  const options = fixture(t);
  const developer = context();
  const system = context("system");
  const value = sealJevContext(checkpoint, [developer, system, developer], options);
  const user = { ...context("user", value) };
  const assistant = { ...context("assistant", value) };
  const liveDeveloper = { ...developer, id: "live-id" };
  const output = expandJevContextItems([user, compact(value), assistant, liveDeveloper, compact(value)], options);
  assert.deepEqual(output, [user, system, compact(checkpoint), assistant, liveDeveloper, compact(checkpoint)]);
  const saved = output.filter((item) => ["developer", "system"].includes(item.role));
  const again = sealJevContext(checkpoint, saved, options);
  const repeated = expandJevContextItems([compact(again), ...saved], options);
  assert.deepEqual(repeated, [compact(checkpoint), ...saved]);
  assert.throws(() => expandJevContextItems([compact("jvc1:bad")], options));
});

test("bounds are applied to encoded input, context metadata and nested values", (t) => {
  const options = fixture(t);
  assert.throws(() => openJevContext("jvc1:" + "A".repeat(512 * 1024), options));
  assert.throws(() => sealJevContext(checkpoint, [context("developer", "x".repeat(256 * 1024))], options));
  assert.throws(() => sealJevContext(checkpoint, [{ ...context(), metadata: "x".repeat(256 * 1024) }], options));
  let nested = {};
  for (let i = 0; i < 70; i++) nested = { nested };
  assert.throws(() => sealJevContext(checkpoint, [{ ...context(), nested }], options));
  const cyclic = context();
  cyclic.metadata = cyclic;
  assert.throws(() => sealJevContext(checkpoint, [cyclic], options));
  assert.equal(existsSync(options.keyPath), false);
});


test("concurrent creators publish one complete stable key", async (t) => {
  const options = fixture(t);
  const moduleUrl = new URL("../src/jev-context-envelope.mjs", import.meta.url).href;
  const script = `import {sealJevContext} from ${JSON.stringify(moduleUrl)}; process.stdout.write(sealJevContext(${JSON.stringify(checkpoint)}, [], {keyPath: process.argv[1]}));`;
  const results = await Promise.all(Array.from({ length: 6 }, () => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, options.keyPath])));
  for (const result of results) assert.deepEqual(openJevContext(result.stdout, options), { checkpointValue: checkpoint, contexts: [] });
});
