import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { attemptJevCompaction, jevCompactionFallbackReason } from "../src/jev-compaction.mjs";
import { decodeCompaction, renderCompactionValue } from "../src/compaction-checkpoint.mjs";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-router-caller-capability-with-sufficient-length";
const message = (role, text) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const history = [message("user", "Keep checkpoint marker JEV_REPLAY_472 and continue after tests."),
  { type: "function_call", name: "exec_command", call_id: "call_1", arguments: '{"cmd":"node --test"}' },
  { type: "function_call_output", call_id: "call_1", output: '{"exit_code":0,"output":"12 tests passed"}' },
  { type: "compaction_trigger" }];
const selection = { summary: { objective: "Continue after tests.", requirement_refs: ["U001"], attempt_refs: ["C001"], observation_refs: ["R001"], unverified: [], unknowns: [], blockers: [], next_step: "Continue the user task." }, requests: [] };

test("Jev checkpoint retains user evidence and tool outcome through serialization", async () => {
  const result = await attemptJevCompaction(history, { settings: { enabled: true }, selector: async () => selection });
  assert.equal(result.status, "compacted");
  assert.match(JSON.stringify(result.checkpoint), /JEV_REPLAY_472/);
  assert.equal(result.checkpoint.sources.R001.exit_code, 0);
});

test("unsupported opaque and visual histories fall back before invoking Jev", async () => {
  for (const extra of [
    { type: "compaction", encrypted_content: "native-encrypted" },
    { type: "message", role: "user", content: [{ type: "input_image", image_url: "https://example.test/image" }] },
    { type: "agent_message", content: [{ type: "encrypted_content", encrypted_content: "opaque" }] },
  ]) {
    assert.ok(jevCompactionFallbackReason([...history, extra]));
    const result = await attemptJevCompaction([...history, extra], { settings: { enabled: true }, selector: () => assert.fail("unexpected inference") });
    assert.equal(result.status, "fallback");
  }
});

test("provider failure falls back without leaking exception content; cancellation propagates", async () => {
  const result = await attemptJevCompaction(history, { settings: { enabled: true }, selector: () => { throw Error("PRIVATE_STATE"); } });
  assert.deepEqual(result, { status: "fallback", reason: "selection_failed" });
  await assert.rejects(attemptJevCompaction(history, { settings: { enabled: true }, signal: AbortSignal.abort(), selector: () => assert.fail() }), /abort/i);
});

test("disabled selection and the discovery kill-switch never invoke the selector", async () => {
  const selector = () => assert.fail("unexpected credential discovery or inference");
  assert.deepEqual(await attemptJevCompaction(history, { settings: { enabled: false }, selector }), { status: "disabled" });
  const previous = process.env.CODEX_ROUTER_NO_DISCOVERY;
  try {
    process.env.CODEX_ROUTER_NO_DISCOVERY = "1";
    assert.deepEqual(await attemptJevCompaction(history, { settings: { enabled: true }, selector }), { status: "disabled" });
  } finally {
    if (previous === undefined) delete process.env.CODEX_ROUTER_NO_DISCOVERY;
    else process.env.CODEX_ROUTER_NO_DISCOVERY = previous;
  }
});

test("real router emits one Jev compaction and renders it for native continuation", { timeout: 20000 }, async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), "jev-router-test-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const skill = path.join(state, "skill");
  await mkdir(path.join(skill, "scripts", "lib"), { recursive: true });
  await writeFile(path.join(skill, "scripts", "lib", "router-compaction.mjs"), `export async function selectCompactionSources() { return ${JSON.stringify(selection)}; }`);
  await writeFile(path.join(state, "jev-compaction.json"), JSON.stringify({ version: 1, enabled: true, skillRoot: skill }));
  const received = [];
  const native = http.createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    let raw = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "zstd") raw = zstdDecompressSync(raw);
    received.push(JSON.parse(raw));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "resp_native", object: "response", status: "completed", output: [message("assistant", "JEV_REPLAY_472")], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } }));
  });
  await new Promise(resolve => native.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => native.close(resolve)));
  const port = await openPort();
  const child = spawn(process.execPath, [path.join(ROOT, "src", "router.mjs")], { cwd: ROOT, env: {
    ...process.env, MODEL_ROUTER_STATE_DIR: state, CODEX_HOME: state,
    CODEX_ROUTER_PORT: String(port), CODEX_ROUTER_CALLER_KEY: KEY,
    CODEX_ROUTER_INTERNAL_KEY: "test-internal-service-key-with-sufficient-length",
    CODEX_NATIVE_BASE_URL: `http://127.0.0.1:${native.address().port}`, CODEX_ROUTER_QUIET: "1",
    CODEX_ROUTER_OAUTH_HEALTH_URL: `http://127.0.0.1:${native.address().port}/health`,
    CODEX_ROUTER_API_HEALTH_URL: `http://127.0.0.1:${native.address().port}/health`,
    CODEX_ROUTER_GROK_OAUTH_HEALTH_URL: `http://127.0.0.1:${native.address().port}/health`,
    CODEX_ROUTER_GATEWAY_HEALTH_URL: `http://127.0.0.1:${native.address().port}/health`,
  }, stdio: ["ignore", "ignore", "pipe"] });
  let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
  t.after(async () => { if (child.exitCode === null) { const done = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGTERM"); await done; } });
  const base = callerBaseUrl(port, KEY);
  for (let i = 0; ; i++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) break; } catch {}
    if (i > 100 || child.exitCode !== null) throw Error(`router startup failed: ${errors}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const send = body => fetch(`${base}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-native-session" }, body: JSON.stringify(body) });
  const compact = await send({ model: "gpt-6-astra", input: history, stream: true });
  assert.equal(compact.status, 200);
  const stream = await compact.text();
  const events = stream.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  const items = events.filter(e => e.type === "response.output_item.done").map(e => e.item);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "compaction");
  assert.match(items[0].encrypted_content, /^kcr2:/);
  assert.match(renderCompactionValue(items[0].encrypted_content), /JEV_REPLAY_472/);
  assert.ok(decodeCompaction(items[0].encrypted_content));
  assert.equal(received.length, 0, "native summary must not be called");
  const continuation = await send({ model: "gpt-6-astra", stream: false, input: [history[0], items[0], message("user", "Continue")], previous_response_id: "resp_previous" });
  assert.equal(continuation.status, 200); await continuation.text();
  assert.equal(received.length, 1);
  assert.equal(received[0].model, "gpt-6-astra");
  assert.equal(received[0].previous_response_id, undefined);
  assert.ok(received[0].input.every(item => item.type !== "compaction"));
  assert.match(JSON.stringify(received[0].input), /JEV_REPLAY_472/);
  assert.match(JSON.stringify(received[0].input), /12 tests passed/);
  // Existing opaque native checkpoints go to the original compactor intact.
  const opaque = { type: "compaction", encrypted_content: "native-opaque-unchanged" };
  const fallback = await send({ model: "gpt-6-astra", stream: false, input: [opaque, ...history] });
  assert.equal(fallback.status, 200); await fallback.text();
  assert.equal(received.length, 2);
  assert.ok(received[1].input.some(item => item.encrypted_content === opaque.encrypted_content));
  assert.match(errors, /compaction=jev checkpoint=kcr2/);
  assert.match(errors, /fallback=native_encrypted_history/);
  const context = message("developer", "Never discard MUST_RETAIN_CONTEXT_12.");
  const guarded = await send({ model: "gpt-6-astra", input: [context, ...history], stream: false });
  const guardedBody = await guarded.json();
  assert.match(guardedBody.output[0].encrypted_content, /^jvc1:/);
  const replay = await send({ model: "gpt-6-astra", stream: false, input: [context, ...guardedBody.output, message("user", "Continue")] });
  assert.equal(replay.status, 200); await replay.text();
  assert.equal(received[2].input.filter(item=>item.role==="developer").length,1);
  assert.ok(received[2].input.some(item=>item.role==="developer"&&JSON.stringify(item).includes("MUST_RETAIN_CONTEXT_12")));
  const again = await send({ model: "gpt-6-astra", stream: false, input: [context, ...guardedBody.output, ...history] });
  assert.match((await again.json()).output[0].encrypted_content, /^jvc1:/);
  const legacy = await fetch(`${base}/responses/compact`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-native-session" }, body: JSON.stringify({model:"gpt-6-astra",input:[context,...history.slice(0,-1)]}) });
  assert.equal(legacy.status,200);
  assert.match((await legacy.json()).output.at(-1).encrypted_content,/^jvc1:/);
});
