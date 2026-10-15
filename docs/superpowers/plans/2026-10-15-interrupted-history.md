# Interrupted legacy histories in isolated copies

Scope: the four refused histories from the previous closed, migrated fixture. Do not reopen the working database or mutate installations, original checkout or private GitHub repository. Keep previous deliverables intact.

Evidence: five incomplete assistant records in four sessions already existed in V1. Three sessions have later completed assistants; one has an incomplete final assistant before the migration's system record. Embedded tools are terminal (completed/error). No pending/inbox entries, suspended/compacting/workspace state or event owner exists. Treat an incomplete timestamp as historical data, not proof of a currently running process.

Policy: retain strict live export. Add explicit offline export using the same journal/confirmation boundary as offline import. Preserve incomplete assistant content unchanged only in a closed snapshot, reject execution owners, nonterminal embedded tools, shell/compaction execution and pending state. Import compares the existing partial history under its already-required offline boundary. No repair timestamps, deletions or invented success events. No shard format change.

Verification sequence:

- [x] Red/green tests: unfinished history offline A -> B -> A; live/unknown/runtime refusal, journal refusal, push flag plumbing and dry-run preflight.
- [x] Actual pinned Windows 2.0.29: transfer all four through a local bare Git remote, read native exports/listings at both ends, continue each at B and A against a local model stub, and compare every original raw message plus all added history/events/instruction state.
- [x] Check all 114 original histories can be selected without exclusions; retain runtime guards during live operation.
- [x] Fresh full checks and independent review. Pack a new prerelease, verify the installed archive in isolated runtime, archive source/patch and sanitized report without conversations or databases.

Use a source-fixture SHA-256 before/after and protected working-file fingerprints. Report native API visibility separately from untested Desktop UI. Explicit offline flags are operator assertions, not permission to inspect or stop working processes.

Native observation: transfer to B preserved every raw message. Same-ID continuation of the tail-incomplete session caused OpenCode itself to update only the original assistant's time_updated and data.time.completed. No content was lost, but immutable history validation correctly refused this change. Do not relax that rule. Continue this session through an official native fork immediately before its incomplete assistant; retain its full original archive as the fork dependency. Test direct continuation for the other three and fork continuation for the tail at both B and A. Keep all five original incomplete records unchanged.

Final evidence, 2026-10-15: full check passes 167 tests in 11 files plus lint/typecheck/build. Exact installed 0.2.0-v2.1 package passes native acceptance at 12:17:53Z: 7669 original messages unchanged, five original incomplete records unchanged, three same-ID continuations and one native continuation fork, 7766 final raw messages across five sessions, full A/B snapshot equality and SQLite integrity. All 117 source-fixture sessions export (114 originals, two prior synthetic sessions, one new fork). Source fixture SHA-256 is unchanged. Independent post-verification proves eight new completed local-stub replies exist on both replicas; historical replies alone cannot satisfy it. Fresh independent review covered runtime changes and strengthened reply validation. Six protected file fingerprints and original checkout HEAD/status remain unchanged. Working database was not opened during this follow-up.
