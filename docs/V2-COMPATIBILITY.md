# OpenCode V2 compatibility preview

Version `0.2.0-v2.1`, based on OMDS `0.1.1` at `0724a2e` and isolated preview `0.2.0-v2.0` at `f48d0be`. Pinned to the released OpenCode CLI `2.0.29`. This is an isolated preview, not authorization to migrate an existing installation.

## Supported contract

- V1 retains its adapter and formatVersion 1. V2 uses formatVersion 2, `session_v2`, messages, durable events, sequence watermarks, instruction entries/state and referenced immutable blobs.
- V2 schema columns and foreign keys are pinned to 2.0.29. Equivalent column ordering after official V1 migration is accepted. Unknown schema or later migration lineage is refused. This is not a blanket compatibility claim for every v2 release.
- Local projects must already exist in the destination OpenCode database. Import maps canonical Windows directories to the local initialized project and preserves its existing settings. Only protocol location fields are translated; historical tool inputs, outputs and content-addressed blobs stay unchanged.
- A selected child includes its parent/fork dependencies. Session history cannot shrink or change under an existing message/event ID. Divergent edits are refused instead of selecting the newest timestamp.
- Whole-batch import is transactional, with validated ownership, types, references, sequence numbers, immutable blob hashes, foreign keys and SQLite integrity. A verified backup is enabled by default. Dry run validates a disposable database copy.
- Successful push acknowledges the exact exported hashes captured before Git operations. Activity during transmission does not invalidate the acknowledgement or include excluded sessions.
- Separate V2 baseline files stay beside the local database and never enter Git. Restore invalidates both baseline generations. Runtime databases, tokens, service registrations and UI state are local.

## Operational limits

V2 import is **offline only**: completely stop the applicable OpenCode server and all clients, then use `omds pull --offline`. The flag is an explicit operator assertion, not an automatic process detector. Nonempty WAL, rollback journals or unreleased SQLite journals block import. Empty reader journals are released only through SQLite checkpoint/close, never by deleting them. The native plugin refuses live pull and disables startup pull. It can report status, explicitly push with a native shell permission check, or export/push on idle when configured by the operator.

Do not edit the same conversation on both computers. Use one active computer at a time. Do not reuse a V1 shard repository for V2: cross-generation shards are intentionally rejected. Config files and other plugins still require their own migration review; OMDS does not convert arbitrary V1 configuration, MCP tools or third-party plugin APIs.

Active/suspended/compacting sessions, queued inputs, workspace-bound sessions and running shell/compaction messages remain refused. Default/live export also refuses unfinished assistants. Explicit `omds push --offline` now validates the original database before any preview or Git operation and permits archiving an interrupted assistant unchanged only when embedded tools are terminal (completed/error) and no execution owner exists. No timestamps or history are repaired automatically. The older 0.2.0-v2.0 acceptance excluded four histories; see [the new interrupted-history policy](INTERRUPTED-HISTORY.md) and dedicated acceptance driver for the expanded offline boundary. Same-ID native continuation can finalize an old tail timestamp; use a native fork before that partial record when preserving the exact original is required. Complete production migration remains unproven.

V2 snapshots have a hard input limit of 64 MiB compressed and 128 MiB expanded. The configurable selection/size defaults still apply; acceptance deliberately selected all eligible histories with a larger per-session cap. Excluded or oversized sessions are not deleted remotely. Offline import cannot prove another application will not open the same database immediately afterward, so keep the isolated workflow until a separately approved rollout.

## Plugin loading

The package exposes the released native V2 `{ id, setup }` contract together with the legacy V1 `server` entrypoint. For a local V2 plugin use the installed **package directory** containing `server.js`, not the old `dist/plugin/index.js` file URL. Native host resolution of the packaged directory is covered by acceptance.

An existing custom loader pinned to 0.1.1 and calling the default export as a function will need a deliberate future migration. Installing this tarball alone does not update that loader. No working loader or OpenCode config was changed during this task.

The V1 1.18.30 schema and old tests remain covered. Native V1 host execution was not repeated in this task. V2 Desktop Windows was not opened: native service API history, project listing and continuation were tested, not the visual Desktop session list. V1 Tauri state is ignored for V2 diagnostics rather than presented as valid Desktop state.

## Reproducing the isolated acceptance

After `npm ci` and `npm run check`, use a separately installed, pinned `@opencode/cli-windows-x64@2.0.29`. The acceptance root must not exist:

```powershell
node scripts/accept-v2.mjs --root=C:/disposable/omds-accept --cli=C:/isolated/runtime/opencode.exe --plugin-dir=C:/isolated/install/node_modules/opencode-multidevice-sync
```

Optional `--source-db=<file>` uses SQLite online backup with a read-only source handle. The harness changes only that backup. It isolates HOME, XDG, app data, temporary directories, database and plugin config; uses a local HTTP model stub and local bare Git remote; and never calls GitHub. It rebinds copied V1 project locations to disposable initialized V2 projects before testing, so fixture project bindings are not evidence that arbitrary production project identity migrations work automatically.

Checks include A -> B -> A native history reads, complete ID/type/sequence/content equality, parent links, root session visibility by project, continuation on each machine, idle auto-push, repeated pulls and database integrity. The generated report has counts and opaque IDs, without conversation text. Local debug databases/logs remain private scratch data and must not be included in distributable archives.

## Official contracts consulted

- [V2 docs](https://opencode.ai/v2/docs)
- [V1 plugin migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)
- [OpenCode 2.0.29 release](https://github.com/anomalyco/opencode/releases/tag/v2.0.29)
- [Pinned database schema](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/database/schema.gen.ts)

This preview is supplied as a local tarball and source patch. It has not been globally installed, published, pushed or merged into the original checkout or private data repository.
