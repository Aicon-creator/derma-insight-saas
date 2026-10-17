# Pilot database integrity and recovery

This procedure covers the actual database behind the pilot. Repository models do
not prove that indexes exist, and a configured backup does not prove recovery.
The tools in this change only read data; they never create indexes, normalize
records, remove duplicates, run a restore or change production configuration.

## 1. Run the integrity audit first

Use a clean checkout containing this change, with the existing dependencies
installed. Confirm the database name locally from the MongoDB configuration.
The example name below is the name reported during earlier local testing;
replace it if the actual production target differs.

```bash
npm run --silent db:audit -- --database dermaInsightDB
```

The script reads `MONGO_URI` from `.env`. With `--env-file PATH`, it reads only
that file, ignoring a competing process environment value. If no file is
available and no explicit file was requested, it uses the process `MONGO_URI`.
It refuses a database name that differs from a name already present in the URI.
Prefer a database user with read-only access to the application database. Keep
connection strings local; do not put them in commands, commits, screenshots or chat.

The JSON contains aggregate counts and findings, without customer emails,
product names, document IDs, account passwords, tokens, connection strings or
hosts. Only that audit JSON is needed for the next engineering decision.

The audit checks:

- Customer email identities after trim/lowercase and Product handles after the
  same slug normalization used by CSV import. Duplicate detection is per merchant.
- Missing, malformed or non-canonical identities and invalid merchant IDs.
- Actual index definitions for partial unique `(merchantId, email)`,
  `(merchantId, handle)` and `(merchantId, dedupeKey)` keys, restricted to strings.
- Missing parent merchants and Event references to missing Customers/Products or
  records belonging to another merchant.
- Missing collections, an unexpected row-count change during the scan, and a
  100,000-document limit per collection. Large databases need a planned batch audit.

Exit codes are `0` for a completed audit without blocking findings, `2` for
`ACTION_REQUIRED`, and `1` when a check cannot complete. Missing Customer/Product
unique indexes are expected to produce findings until a reviewed migration runs.
An audit can pass while `backupRestoreVerified` remains false. It is not a pilot
readiness certificate or proof that concurrent imports are safe.

Null Customer emails and null Event dedupe keys are reported separately: these
records are outside the partial unique index. Missing Product handles require
review. Event dedupe keys are case-sensitive; email/handle identities are not.
Product comparison uses stored handles, not a guess from product titles.

The current Customer/Product import paths use pre-checks and upserts, without a
database uniqueness guarantee in their model declarations. Their existing-record
queries lowercase values without trimming. The next migration must align stored
identities and every writer before enabling constraints, and test duplicate-key
races and partial failures. Do not add raw-field indexes to dirty records and
assume normalized identity is protected.

## 2. Record backup configuration

Before any migration, the operator records privately:

- The exact source deployment/database and backup owner.
- Backup method, schedule, retention, encryption/storage access, last successful
  backup time and how failures are noticed.
- A proposed pilot recovery target: no more than 24 hours of lost data and a
  restore within four hours. These are targets until approved and rehearsed.
- The isolated restore deployment/database and credentials restricted to it.
- Where deployment configuration and secrets are recovered from separately.

If using Atlas, check the actual tier and backup options. For other hosting,
check the provider's recovery facilities. Do not assume scheduled snapshots
are available. If the chosen method is manual, it still needs an agreed schedule,
secure off-host storage and failure checks before the pilot.

Use an encrypted, access-controlled backup location. `private-ops/` and common
MongoDB dump formats are ignored by Git as a precaution; Git ignore rules are not
backup encryption. Database archives contain real customer and account data.

## 3. Rehearse into an isolated target

Use either an Atlas snapshot restored to a separate target, or a MongoDB Database
Tools logical backup. Do not restore over the live database. Use compatible source
and target MongoDB versions and record the tool versions.

For a logical rehearsal, pause all application writes for the full source-manifest
and dump window. This includes imports, demo scripts, syncs and direct database
writers. The manifest flag records the operator's assertion; the script cannot
pause writers or guarantee a transactionally consistent snapshot by itself.

Create a private working directory and restrict its permissions:

```bash
mkdir -p private-ops
chmod 700 private-ops
npm run --silent db:manifest -- --database dermaInsightDB --writes-paused > private-ops/source-manifest.json
```

Check the command succeeded and the file contains a recovery manifest, not an
error report. An error must not be treated as a successful backup.

Create private MongoDB Tools YAML connection files locally. `source-tools.yml`
contains a `uri` for the source. `restore-tools.yml` contains a `uri` for a dedicated
restore target with access only to that target. Keep these files inside
`private-ops/`, set permissions to `600`, and keep actual credentials out of the
terminal command line. The restore URI can omit a database path; the namespace
mapping below explicitly names the destination database.

Example operator commands (replace database and target names deliberately):

```bash
mongodump --config private-ops/source-tools.yml --db dermaInsightDB --archive=private-ops/pilot.archive.gz --gzip
mongorestore --config private-ops/restore-tools.yml --archive=private-ops/pilot.archive.gz --gzip --nsInclude='dermaInsightDB.*' --nsFrom='dermaInsightDB.*' --nsTo='derma_insight_restore_20261017.*' --stopOnError
```

Keep application traffic and background jobs away from the restore target. Use a
new empty target for each attempt; this procedure does not use `--drop` or delete
anything automatically. Keep source writes paused until the dump is complete.

For Atlas snapshots, record the snapshot time and use source evidence from the
same quiescent state, then restore to a separate target. Manifests from different
source states can legitimately differ and cannot prove recovery of that snapshot.

## 4. Verify restored content and indexes

Create `private-ops/restored.env` locally with only `MONGO_URI` for the isolated
database, and set file permissions to `600`. Its database path, when present,
must match `--database`.

```bash
npm run --silent db:audit -- --env-file private-ops/restored.env --database derma_insight_restore_20261017 > private-ops/restored-audit.json
npm run --silent db:manifest -- --env-file private-ops/restored.env --database derma_insight_restore_20261017 --writes-paused > private-ops/restored-manifest.json
npm run --silent db:compare-manifests -- private-ops/source-manifest.json private-ops/restored-manifest.json
```

The manifests hash documents in `_id` order using canonical Extended JSON, plus
index definitions and collection options. They contain counts and hashes, not
document values. Compound index-key order is preserved. Namespace/version/build
metadata is excluded from index comparison so renaming the restored database
does not itself cause a mismatch. Different document values, quantities, dates,
account credentials, collections, index constraints or options cause a mismatch.

The comparison rejects identical connection fingerprints. Confirm the separate
database/deployment independently: connection aliases can address the same
deployment. A `MATCH` means the supplied content matches and the connection
fingerprints differ; it does not authenticate their origin or verify isolation
and backup scheduling by itself.
The tools stop on unsupported views/time-series collections and scan limits.
They detect changed document counts, but same-count updates still require the
operator's write pause. Never upload the backup archive, connection files or
private document extracts into a PR or chat.

Record the backup timestamp, successful restore log, manifest comparison, restored
audit, elapsed recovery time and operator. Confirm critical app login and analytics
against the isolated database in a controlled test environment. Block outbound
Shopify calls and keep production guards active before starting any app against
restored merchant credentials. Keep live traffic on the original database.

## 5. Close the gate before adding unique indexes

1. Review the real source audit and the recovery evidence.
2. Resolve duplicate identities deliberately, preserving original IDs and Event
   history. No automated deletion or account merging is authorized by this procedure.
3. Prepare an explicit normalization/index migration with a rollback plan. Add
   constraints only after data preflight and writer/race handling are ready.
4. Re-run the audit and concurrent/replayed Customer, Product and Event imports
   on the isolated target, then schedule the production migration.
5. Mark production indexes and recovery verified only after actual execution.

## Official references

- [MongoDB unique and partial unique indexes](https://www.mongodb.com/docs/manual/core/index-unique/)
- [Inspect installed index definitions](https://www.mongodb.com/docs/manual/reference/method/db.collection.getIndexes/)
- [mongodump options, archives and protected connection configuration](https://www.mongodb.com/docs/database-tools/mongodump/)
- [mongorestore namespace mapping and stop-on-error](https://www.mongodb.com/docs/database-tools/mongorestore/)
- [Atlas snapshot restore](https://www.mongodb.com/docs/atlas/backup/cloud-backup/restore-from-snapshot/)
