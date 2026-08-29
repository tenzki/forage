# Backing Up PostgreSQL and Assets

## Status

Postponed. This document records the backup and operational work required before the server backend should be treated as a reliable store for irreplaceable notes.

## Scope

The server's canonical state consists of:

- the PostgreSQL event stream, checkpoints, projections, ownership, and API-token metadata;
- generated images and other content-addressed assets stored in the configured asset store.

The event log provides application history, but it is not a backup. Database failure, disk loss, accidental administration, compromised credentials, and faulty migrations can still destroy or corrupt both events and projections.

## Minimum Backup Policy

Before production use, implement:

- automated daily PostgreSQL backups;
- retained weekly and monthly backups;
- backup of the immutable asset directory or object-storage bucket;
- a backup manifest containing the Forage server version, database schema version, checkpoint revisions, and asset counts;
- encryption for backups stored off the server;
- a documented restore procedure;
- regularly scheduled restore tests;
- an automatic backup before every server database migration.

For an initial single-owner deployment, scheduled `pg_dump` backups plus a synchronized archive of the asset store are sufficient. Point-in-time recovery, PostgreSQL replication, and high-availability infrastructure can wait until availability requirements justify them.

## PostgreSQL Backups

Backups must include all server-owned PostgreSQL schemas and migration metadata. A successful backup job should record:

- start and completion timestamps;
- PostgreSQL and Forage server versions;
- database schema version;
- backup size and checksum;
- the highest revision for each outline;
- the most recent checkpoint revision;
- success or failure without logging note contents or credentials.

Backup jobs must fail visibly. A server should expose the age and status of the most recent successful backup through administrative health information or metrics.

## Asset Backups

Assets are content-addressed and immutable. PostgreSQL stores their hashes, metadata, ownership, and storage keys, while the bytes live in a server-managed directory or object store.

Asset backups must preserve the storage keys referenced by PostgreSQL. Garbage collection must use a generous grace period so that assets needed by a recent database backup are not removed before the corresponding asset backup completes.

A restored database may reference assets copied before or after its backup as long as:

- asset identifiers are derived from verified content hashes;
- existing asset bytes are never modified in place;
- garbage collection does not remove assets still referenced by retained events, checkpoints, live notes, trash, or retained backups.

## Restore Procedure

A restore is not considered supported until it has been tested end to end. The procedure should:

1. Start with an empty PostgreSQL instance and empty asset destination.
2. Restore the selected database backup.
3. Apply only migrations compatible with the restored Forage server version.
4. Restore the asset archive.
5. Verify database and asset checksums.
6. Verify that every referenced asset is present.
7. Validate checkpoint integrity hashes.
8. Replay events after the latest checkpoint and compare the resulting projection with the stored projection.
9. Start the server in a restricted validation mode before allowing clients to write.
10. Record the restore result and any missing or inconsistent data.

Restore testing should happen regularly and after meaningful changes to migrations, event schemas, checkpoint encoding, or asset storage.

## Operational Safeguards

Before relying on the server for irreplaceable notes:

- database migrations must run before the server accepts traffic and fail atomically;
- liveness and readiness must be reported separately;
- readiness must fail when PostgreSQL, required migrations, or asset storage are unavailable;
- disk usage, event-log growth, checkpoint age, failed synchronizations, and backup age must be observable;
- logs must contain identifiers and error codes, not note bodies, authorization headers, or API tokens;
- request, connection, and payload limits must protect the service from broken or abusive clients;
- an event referencing an asset must be rejected unless the asset is fully uploaded and verified;
- the application database role must not update or delete accepted event records during normal operation;
- checkpoints should carry integrity hashes that are checked during restore.

## Deferred Decisions

The following require separate decisions before backup retention is finalized:

- how long accepted events and checkpoints are retained;
- whether and when old event epochs may be compacted;
- how trash differs from permanent deletion;
- how permanent deletion removes note content from the event log, assets, and retained backups;
- whether user-requested erasure is immediate or follows a documented backup-expiration window;
- when point-in-time recovery or replicated PostgreSQL becomes necessary.

These concerns are intentionally documented but not implemented yet.
