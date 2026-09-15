# Safety model and limits

## Database boundaries

Live databases and journals stay local. Export reads a SQLite snapshot transaction and writes one canonical compressed JSON shard per selected session. Import validates supported tables, row ownership and columns. Existing projects are not replaced. Messages are inserted before parts, and a single transaction covers the import batch. Integrity is checked before COMMIT; a failure rolls back the transaction, not the database file underneath another process.

Before a non-empty import, `VACUUM INTO` creates a separate consistent snapshot by default. The snapshot is checked before it is accepted as a backup. Retention defaults to ten verified snapshots; failed backup creation blocks import. Backups can contain the entire private conversation history and must be protected like the original database.

Manual restore requires explicit offline confirmation, checks for OpenCode processes in the CLI, and refuses existing WAL/SHM/journal files. OS process checks are best-effort, so users must still ensure every database client is closed. No routine import replaces the live database file.

## Conflicts

Local content baselines live beside the database in `.omds-bases.json`, outside Git. Hashes include session metadata and child rows. A two-sided change or an unknown divergent baseline blocks the batch. This is conflict detection, not a CRDT or an automatic conversation merge. Incoming snapshots that would silently drop existing child rows are refused.

## Git and privacy

Only use trusted private repositories. Verification of sensitive GitHub sync uses `gh`. Local filesystem remotes are allowed for tests/development, not treated as cloud privacy guarantees. Local configuration backups are created before pull changes. Ordinary Git conflicts preserve a stash for manual recovery.

Credential-file sync is off by default. Known credential/runtime filenames and some inline JSON secrets are blocked on push. This is a heuristic, not comprehensive DLP: secrets in prose, tool output, arbitrary scripts, Git history or binary data may remain. No end-to-end encryption is implemented.

Synced plugins and skills can execute code. Anyone with write access to your sync repository is therefore trusted with your OpenCode environment. Do not add unknown collaborators or consume unreviewed sync repositories.

## Preview and concurrency

Dry-run uses a disposable copy and does not update the original Git worktree or session DB. It can require significant temporary disk space. `extraPaths` previews are deliberately refused.

The lock coordinates processes on one computer only. Use one active device. Git rejects conflicting branch updates, but there is no distributed ownership lease or safe simultaneous editing guarantee. Auto-push waits for startup pull and reports errors; it is not a background system service and cannot finish after the application is terminated.

## Desktop state

OpenCode Desktop UI state is machine-local and is not synchronized. OMDS 0.1.1 may read `lastProject` on a best-effort basis to explain hidden imported chats, but it does not mutate Desktop state. Session rows remain authoritative; visibility is a UI/project-context concern.

## Compatibility

The current SDK target is OpenCode 1.18.31; the 1.18.30 session schema remains covered by regression tests. Windows is the primary acceptance platform, with Node 22/24 covered by CI. Node and OS combinations covered by CI are listed in the workflow. Real Desktop behavior and new OpenCode schemas require separate acceptance testing. Passing tests is not a guarantee against every form of data loss.
