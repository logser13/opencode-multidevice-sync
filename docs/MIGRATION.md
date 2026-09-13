# Migrating from opencode-github-sync 3.0.1

Do not migrate both devices blindly. This is an early preview. Test with isolated roots and disposable databases first.

1. Finish work on the source computer and verify its last successful upstream push. Close OpenCode on both computers.
2. Preserve a consistent SQLite backup, your configuration, and the sync repository history outside the synchronized directory. Never copy only a live DB while ignoring its WAL.
3. Keep the existing PRIVATE sync repository; do not create a public replacement for your personal data.
4. Install the same reviewed multidevice-sync tarball on both machines. The new CLI is `omds`; it does not take over `opencode-sync`.
5. Keep `opencode-sync.jsonc` and `opencode-sync.overrides.jsonc`. Set `includeCredentials:false`, `includeState:false`, and initially both automatic flags to false.
6. Remove the upstream package from the OpenCode plugin list. Move any `opencode-github-sync-safe.js` wrapper outside the plugins directory. Do not delete backups or credential files.
7. Add the new installed plugin's absolute file URL. Do not put machine-specific paths into shared configuration without a local override.
8. Run `omds doctor`, then `omds pull --dry-run`. Review all failures and conflicts. The first fork sync establishes content baselines only when local and remote history agree.
9. Run `omds pull` and `omds push --dry-run`. Compare session/message/part counts and inspect at least one full conversation. A reserialization diff is expected once; repeated unchanged exports should not change shard bytes.
10. If a legacy shard differs and no common baseline exists, the fork refuses to choose automatically. Preserve both copies and reconcile on disposable databases. Do not use force as an improvised data-repair tool.
11. Repeat the checks on the other computer before enabling automatic operation. Keep one active device and wait for successful push before switching.

## Isolation

The library supports explicit `roots`. CLI isolation variables are `SYNC_CONFIG_ROOT`, `SYNC_DATA_ROOT`, `SYNC_STATE_ROOT`, `SYNC_AGENTS_ROOT`, and `SYNC_CACHE_ROOT`. Use a LOCAL disposable Git remote for automated tests and keep secrets out of fixtures.

## Paths

In `sessions.pathMappings`, `from` is the canonical shared path and `to` is this machine's local path. Import converts from-to; export converts back. Keep mappings one-to-one. The synthetic `global` project must already exist locally and is never overwritten from a shard.

## Rolling back the application

Close OpenCode, remove only the new plugin entry, and restore the prior configuration from backup. Keep the known-good patched upstream package until both devices pass acceptance tests. Database restoration is separate: `omds restore BACKUP --offline` refuses journals and preserves a safety backup. Never delete WAL/SHM files to bypass that refusal.

The source repo is public; personal configuration, sessions and backups are not part of this migration guide or release artifacts.
