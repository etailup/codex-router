import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { STATE_DIR } from "./paths.mjs";
import { discoveryDisabled } from "./discovery-mode.mjs";
import { encodeCheckpoint, finalizeCheckpoint, isRouterCompactionValue, prepareCompaction } from "./compaction-checkpoint.mjs";
import { expandJevContextItems, isJevContextValue, sealJevContext } from "./jev-context-envelope.mjs";

// Local, explicit installation choice. Other router installations keep their
// existing compactor. This is hot-read; no credentials belong in this file.
export const JEV_COMPACTION_PATH = path.join(STATE_DIR, "jev-compaction.json");
export function readJevCompactionSettings() {
  try {
    const value = JSON.parse(readFileSync(JEV_COMPACTION_PATH, "utf8"));
    if (value.version !== 1 || value.enabled !== true) return { enabled: false };
    const skillRoot = value.skillRoot || path.join(os.homedir(), ".agents", "skills", "jev");
    if (!path.isAbsolute(skillRoot)) return { enabled: false };
    return { enabled: true, skillRoot };
  } catch { return { enabled: false }; }
}

const TEXT = new Set(["text", "input_text", "output_text"]);
function textOnly(value) {
  return typeof value === "string" || (Array.isArray(value) && value.every(
    part => TEXT.has(part?.type) && typeof part.text === "string",
  ));
}

// Jev cannot interpret an existing native encrypted summary or images. Let the
// current provider handle those intact instead of pretending nothing was lost.
export function jevCompactionFallbackReason(input) {
  if (!Array.isArray(input) || !input.length) return "missing_history";
  if (Buffer.byteLength(JSON.stringify(input)) > 16 * 1024 * 1024) return "history_budget";
  for (const item of input) {
    if (item?.type === "compaction") {
      if (!isRouterCompactionValue(item.encrypted_content) && !isJevContextValue(item.encrypted_content)) return "native_encrypted_history";
    } else if (item?.type === "message") {
      if (!["user", "assistant", "developer", "system"].includes(item.role) || !textOnly(item.content)) return "nontext_history";
    } else if (["function_call_output", "custom_tool_call_output"].includes(item?.type)) {
      if (!textOnly(item.output)) return "nontext_tool_result";
    } else if (!["function_call", "custom_tool_call", "reasoning", "compaction_trigger", "additional_tools"].includes(item?.type)) {
      return "unsupported_history_item";
    }
  }
  return undefined;
}

export async function attemptJevCompaction(input, {
  signal, settings = readJevCompactionSettings(), selector,
} = {}) {
  if (!settings.enabled || discoveryDisabled()) return { status: "disabled" };
  signal?.throwIfAborted();
  try {
    const expanded = expandJevContextItems(input);
    const reason = jevCompactionFallbackReason(expanded);
    if (reason) return { status: "fallback", reason };
    const select = selector || (await import(pathToFileURL(path.join(
      settings.skillRoot, "scripts", "lib", "router-compaction.mjs",
    )).href)).selectCompactionSources;
    const contexts = expanded.filter(item => item?.type === "additional_tools" || (item?.type === "message" && ["developer", "system"].includes(item.role)));
    const prepared = prepareCompaction(expanded);
    const result = await select(prepared, { signal });
    signal?.throwIfAborted();
    const checkpoint = finalizeCheckpoint(JSON.stringify(result.summary), prepared);
    if (!checkpoint || !Object.keys(checkpoint.sources).length) return { status: "fallback", reason: "empty_checkpoint" };
    const checkpointValue = encodeCheckpoint(checkpoint);
    const encryptedContent = contexts.length ? sealJevContext(checkpointValue, contexts) : checkpointValue;
    return { status: "compacted", checkpoint, encryptedContent, requests: result.requests };
  } catch (error) {
    signal?.throwIfAborted();
    // Do not expose exception text: imported clients/providers may echo state.
    return { status: "fallback", reason: "selection_failed" };
  }
}
