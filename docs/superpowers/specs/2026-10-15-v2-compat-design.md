# OpenCode V2 compatibility in isolation

Adapt OMDS 0.1.1 without changing the source checkout, installed packages, live databases or the private configuration repository. Produce a reviewable prerelease and prove a Windows A -> B -> A round trip on isolated copies using OpenCode 2.0.29.

Preserve the V1 adapter and format. Add an explicitly versioned V2 shard and reject cross-generation imports/overwrites. V2 snapshots carry session_v2, session_message, durable session events and sequence watermark, instructions and required project rows. Reject active execution, pending input, workspace-bound sessions and unknown schemas instead of guessing. A transaction, verified pre-import backup, baseline conflict detection and no removal of local history remain mandatory. V2 imports require explicit offline confirmation and absence of database journals; the V2 plugin exports on idle but cannot import into its running server.

Use a dual V1/V2 plugin entrypoint. V2 registers the sync tool through the released plugin API, subscribes to events and cleans up its subscription/timer. Keep machine-local service configuration, runtime tokens and UI state outside Git. Native V2 config is accepted for plugin cache handling without converting user config.

Acceptance uses a locally installed, pinned Windows CLI under a fresh HOME/XDG tree, a local model stub, two local config worktrees and a local bare Git remote. Start with a consistent read-only snapshot of the user's V1 database, migrate only copies, and test synthetic conversations as well. Compare full canonical session payloads, parent/child links, message IDs and content, sequence advancement, local project visibility and successful continuation after each move. Exercise malformed/cross-engine shards, conflicts, unknown schema, pending/active sessions, rollback and idempotence. No real model credentials, external inference, GitHub writes, global installs or live-service commands.

User autonomy instructions override the optional skill approval handoffs; implementation and local verification are explicitly requested. Only this isolated development clone and its disposable fixtures may be mutated.
