# Optional Jev compaction

This installation can use the global Jev skill for source selection on Codex
compaction requests. It is off by default and adds no package dependency.
Native/routed generation, model selection and account authentication retain
their existing paths. Other client protocols are not intercepted.

Create a private `jev-compaction.json` inside `STATE_DIR` (normally
`~/.codex/codex-router`) containing:

```json
{"version":1,"enabled":true,"skillRoot":"/absolute/path/to/jev"}
```

The skill must provide `scripts/lib/router-compaction.mjs` exporting
`selectCompactionSources(prepared, {signal})`. The installed skill repository is
[etailup/jev-skill](https://github.com/etailup/jev-skill). It uses the existing
OpenRouter credential reference, not a TypeSafe key. Never put keys in settings.
Absent/malformed/disabled settings load no selector or provider credential.
The discovery kill-switch also disables selection. Settings are hot-read;
installing new router code still requires a normal router service restart.

Configure Codex itself for the trigger:

```toml
model_auto_compact_token_limit = 200000
model_auto_compact_token_limit_scope = "total"
```

Those are user-owned Codex root settings, not new router-managed config fields.
Running tasks may need configuration reload. Model limits can trigger earlier.
Manual compact requests use the same path. Exact-route probes bypass Jev.

## Protocol and retention

Native v2 receives exactly one compaction item, streamed or as JSON. Legacy v1
receives the existing retained user context plus that item. Jev scores bounded,
redacted U/C/R sources; deterministic code selects evidence into the existing
`kcr2` checkpoint. Selected references are capped at 32, with room for new
evidence after repeated compaction. The recent tail and source provenance use
the existing checkpoint renderer. Excerpts and candidate counts are bounded:
this is lossy context retention, not a transcript archive.

Plain developer/system messages and `additional_tools` registries are retained
with original roles/fields in an AES-256-GCM `jvc1:` envelope around the checkpoint.
The private 32-byte `STATE_DIR/jev-context-key` is atomically created once.
Replay expands the envelope before the existing native/routed normalizers;
identical live context is deduplicated. Ordinary traffic does not touch this key.
Jev receives user/tool evidence, not these protected instruction messages.

Keep the key and decoder for as long as saved tasks need replay. Missing keys,
tampering or corrupt envelopes fail explicitly; the provider cannot decode
them. Turning `enabled` off stops selection but deliberately keeps replay.
Do not downgrade to code without the decoder or migrate tasks alone to another
machine after creating these checkpoints. Preserve the existing private state
when backing up or migrating this installation.

## Fallback and observability

Existing native encrypted history, images, unsupported records, excessive input,
provider failures and selection limits use the previous compactor unchanged.
Old tasks already containing native encrypted checkpoints therefore remain on
native compaction. Failed Jev selection has no automatic retry. The selector
has at most eight requests, two in parallel, with one 20-second deadline; a
fallback may add that delay before standard compaction. Request cancellation
propagates and stops inference.

Logs contain `compaction=jev checkpoint=kcr2 status=200` or a bounded fallback
reason. `kcr2` names the evidence payload even when carried inside `jvc1`.
Successful request usage records include resolved Jev model, tokens and duration;
neither settings nor log messages contain conversation text or API keys.

Tests cover v1/v2, repeated compaction, native continuation, opaque fallback,
context preservation, key failures, authenticated envelopes and concurrent key
creation. A real ephemeral native Codex 0.155.0-alpha.9 task also passed two
Jev-compaction/Astra-continuation rounds on 2026-09-18. This validates protocol
compatibility on that client and fixture, not quality across all workloads.
