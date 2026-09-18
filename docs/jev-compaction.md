# Legacy Jev checkpoint compatibility

Jev compaction has been removed. Automatic and manual compaction use the existing
native or selected-provider compactor. Codex retains its configured token threshold.

The `jvc1:` context decoder and local `jev-context-key` remain solely to replay
previously created checkpoints. Keep that key while those conversations need to
resume. This compatibility path performs no Jev inference.

On installations still running the previous router process, set the hot-read
`jev-compaction.json` state file to `{"version":1,"enabled":false}`; the next
normal service restart loads the dispatch removal. Do not restart an active host
solely for this change.
