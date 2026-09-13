# Contributing

This is an independent early-preview fork. Preserve the upstream MIT license and attribution.

Use Node.js 22.13+ (24 recommended), install with `npm ci`, then run `npm run check`. The check builds before CLI tests. SQLite tests must fail when the driver is unavailable, never pass by silently skipping.

Use disposable local Git repositories, synthetic conversations and isolated `SYNC_*_ROOT` directories in tests. Never commit real databases, session exports, credentials, personal paths or backups.

Add regression tests for data-related changes. Test shared parents with ON DELETE CASCADE, repeat export byte identity, divergent histories, malformed shards, WAL-backed snapshots, rollback, path mapping and offline restore refusal.

Run `npm pack --dry-run` and inspect the payload before releasing. Keep the code repository PUBLIC and test/user sync repositories PRIVATE. Do not publish a registry package merely because a Git tag exists.

Keep CLI and plugin behavior consistent. Never bypass conflicts with force in automation. Document limitations instead of advertising unverified guarantees.
