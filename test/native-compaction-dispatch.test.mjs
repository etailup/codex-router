import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callerBaseUrl } from "../src/caller-auth.mjs";
import { openPort } from "./port-pool.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "test-router-caller-capability-with-sufficient-length";
const message = (role, text) => ({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
const history = [message("user", "Keep checkpoint marker JEV_REPLAY_472 and continue after tests."),
  { type: "function_call", name: "exec_command", call_id: "call_1", arguments: '{"cmd":"node --test"}' },
  { type: "function_call_output", call_id: "call_1", output: '{"exit_code":0,"output":"12 tests passed"}' },
  { type: "compaction_trigger" }];
test("native v1 and v2 compaction bypass removed Jev integration even with stale enabled settings", { timeout: 20000 }, async t => {
  const state = await mkdtemp(path.join(os.tmpdir(), "jev-router-test-"));
  t.after(() => rm(state, { recursive: true, force: true }));
  const skill = path.join(state, "skill");
  await mkdir(path.join(skill, "scripts", "lib"), { recursive: true });
  await writeFile(path.join(skill, "scripts", "lib", "router-compaction.mjs"), `export async function selectCompactionSources() { throw Error("Removed selector must never run"); }`);
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
  // Stale opt-in configuration must not restore the removed selector.
  for (const stream of [false, true]) {
    const response = await send({ model: "gpt-6-astra", input: history, stream });
    assert.equal(response.status, 200); await response.text();
    assert.equal(received.at(-1).model, "gpt-6-astra");
    assert.deepEqual(received.at(-1).input, history);
  }
  const legacy = await fetch(`${base}/responses/compact`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-native-session" }, body: JSON.stringify({model:"gpt-6-astra",input:history.slice(0,-1)}) });
  assert.equal(legacy.status, 200); await legacy.text();
  assert.equal(received.length, 3, "all compactions must reach the original native provider");
  assert.deepEqual(received.at(-1).input, history.slice(0,-1));
  assert.doesNotMatch(errors, /compaction=jev|Removed selector/);
});
