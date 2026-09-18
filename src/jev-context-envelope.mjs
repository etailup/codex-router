import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decodeCompaction } from "./compaction-checkpoint.mjs";
import { privateFileIsProtected, protectPrivateFile } from "./file-security.mjs";
import { STATE_DIR } from "./paths.mjs";

const PREFIX = "jvc1:";
const MAX_BYTES = 512 * 1024;
const MAX_CONTEXT_BYTES = 256 * 1024;
const DEFAULT_KEY_PATH = path.join(STATE_DIR, "jev-context-key");
const fail = () => { throw new Error("Invalid or unavailable Jev context envelope."); };

// Validate the size before serialization, including metadata, without invoking
// getters/toJSON or allocating an unbounded serialized copy.
function boundedJson(value, limit) {
  let budget = limit;
  const seen = new Set();
  function visit(node, depth = 0) {
    if (depth > 64 || budget < 0) fail();
    if (typeof node === "string") { budget -= Buffer.byteLength(node) + 2; return; }
    if (node === null || typeof node === "boolean" || (typeof node === "number" && Number.isFinite(node))) { budget -= 8; return; }
    if (!node || typeof node !== "object" || seen.has(node)) fail();
    if (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) fail();
    seen.add(node);
    budget -= 2;
    for (const key of Object.keys(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
      budget -= Buffer.byteLength(key) + 4;
      visit(descriptor.value, depth + 1);
    }
    seen.delete(node);
  }
  visit(value);
  if (budget < 0) fail();
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limit) fail();
  return json;
}

function isContext(item) {
  if (item?.type === "additional_tools") return true;
  return item?.type === "message" && ["system", "developer"].includes(item.role) &&
    Array.isArray(item.content) && item.content.every((part) =>
      part && ["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string");
}

function validate(checkpointValue, contexts) {
  if (typeof checkpointValue !== "string" || checkpointValue.length > MAX_BYTES ||
      decodeCompaction(checkpointValue)?.kind !== "checkpoint") fail();
  if (!Array.isArray(contexts)) fail();
  boundedJson(contexts, MAX_CONTEXT_BYTES);
  if (!contexts.every(isContext)) fail();
}

function readKey(keyPath) {
  let fd;
  try {
    const before = lstatSync(keyPath);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== 32) fail();
    fd = openSync(keyPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || stat.dev !== before.dev || stat.ino !== before.ino) fail();
    if (process.platform !== "win32") {
      if ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) fail();
    } else if (!privateFileIsProtected(keyPath)) fail();
    const key = Buffer.alloc(32);
    if (readSync(fd, key, 0, 32, 0) !== 32) fail();
    return key;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function sealingKey(keyPath) {
  try { return readKey(keyPath); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const directory = path.dirname(keyPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink()) fail();
  const temporary = `${keyPath}.tmp.${process.pid}.${randomBytes(12).toString("hex")}`;
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    if (process.platform === "win32") protectPrivateFile(temporary);
    writeFileSync(fd, randomBytes(32));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // link is an exclusive atomic publication, unlike rename (replacement).
    // Concurrent sealers reread the winner only after its bytes are complete.
    try { linkSync(temporary, keyPath); } catch (error) { if (error.code !== "EEXIST") throw error; }
    return readKey(keyPath);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch { /* No published key is removed. */ }
  }
}

export function isJevContextValue(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function sealJevContext(checkpointValue, contexts, { keyPath = DEFAULT_KEY_PATH } = {}) {
  try {
    validate(checkpointValue, contexts);
    const plain = Buffer.from(boundedJson({ checkpointValue, contexts }, MAX_BYTES));
    // Account for nonce, tag and base64 before encryption or key creation.
    if (PREFIX.length + 4 * Math.ceil((plain.length + 28) / 3) > MAX_BYTES) fail();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", sealingKey(keyPath), nonce);
    cipher.setAAD(Buffer.from(PREFIX));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
  } catch { fail(); }
}

export function openJevContext(value, { keyPath = DEFAULT_KEY_PATH } = {}) {
  try {
    if (!isJevContextValue(value) || value.length > MAX_BYTES) fail();
    const encoded = value.slice(PREFIX.length);
    if (encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) fail();
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length < 29 || bytes.length > MAX_BYTES || bytes.toString("base64") !== encoded) fail();
    const decipher = createDecipheriv("aes-256-gcm", readKey(keyPath), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(PREFIX));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    if (plain.length > MAX_BYTES) fail();
    const decoded = JSON.parse(plain.toString("utf8"));
    validate(decoded.checkpointValue, decoded.contexts);
    return { checkpointValue: decoded.checkpointValue, contexts: decoded.contexts };
  } catch { fail(); }
}

export function expandJevContextItems(input, options = {}) {
  try {
    if (!Array.isArray(input)) fail();
    if (!input.some(item => item?.type === "compaction" && isJevContextValue(item.encrypted_content))) return input;
    // Existing privilege messages anywhere in the input take precedence over
    // saved copies; ordinary user text is never inspected for envelopes.
    const signature = (item) => boundedJson(item.type === "additional_tools" ? item : [item.role, item.content], MAX_CONTEXT_BYTES);
    const seen = new Set(input.filter(isContext).map(signature));
    const output = [];
    for (const item of input) {
      if (item?.type !== "compaction" || !isJevContextValue(item.encrypted_content)) {
        output.push(item);
        continue;
      }
      const { checkpointValue, contexts } = openJevContext(item.encrypted_content, options);
      for (const context of contexts) {
        const key = signature(context);
        if (!seen.has(key)) { seen.add(key); output.push(context); }
      }
      output.push({ ...item, encrypted_content: checkpointValue });
    }
    return output;
  } catch { fail(); }
}
