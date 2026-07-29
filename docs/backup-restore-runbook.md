# Backup And Restore Runbook

## Recovery Objectives

Each deployment records its approved values in `backup.env`:

- `RPO_HOURS`: maximum acceptable data loss. Recommended initial value: 24.
- `RTO_HOURS`: maximum acceptable recovery time. Recommended initial value: 4.
- `KEEP_DAYS`: local encrypted snapshot retention. Default: 30.

The encryption key must be escrowed outside the application host. A backup whose only decryption key was lost with the source server is not recoverable.

## Backup Configuration

Store the following as root-readable files with mode `600`:

- `/root/.config/employee-agent/backup.env`
- `/root/.config/employee-agent/backup.cnf`
- `/root/.config/employee-agent/backup-encryption.key`
- the optional off-site SSH key

Example `backup.env`:

```bash
APP_DIR=/root/employee-agent
DB_NAME=employee_agent
BACKUP_DIR=/root/backups/employee-agent
KEEP_DAYS=30
JIUWENSWARM_HOME=/root/.jiuwenswarm
SKILL_STORE=/root/skill-store
INCLUDE_KNOWLEDGE_INDEXES=false
# Optional for the daily core profile. Keep the append-only audit ledger in scope.
MYSQL_CORE_EXCLUDE_TABLES="security_logs ip_access_logs"
# Enable only when database-side scheduled events exist and the backup account has EVENT access.
MYSQL_INCLUDE_EVENTS=false
REMOTE_HOST=
REMOTE_USER=ea-backup
REMOTE_DIR=/opt/backups/employee-agent
RPO_HOURS=24
RTO_HOURS=4
```

Run an inventory before enabling the schedule:

```bash
sudo EMPLOYEE_AGENT_BACKUP_CONFIG_DIR=/root/.config/employee-agent \
  /root/employee-agent/scripts/backup-production.sh --inventory
```

Run daily through a systemd timer or cron. Do not overlap runs. The scheduler uses a core database profile Monday through Saturday and a full database profile on Sunday:

```bash
0 3 * * * flock -n /run/lock/employee-agent-backup.lock /root/employee-agent/scripts/run-scheduled-backup.sh >> /root/backups/employee-agent/cron.log 2>&1
```

Only high-volume legacy operational tables may be excluded from the core profile. Identity, tenancy, conversations, tasks, knowledge metadata, credentials, and the `audit_*` ledger remain required. The weekly full profile ignores the exclusion list.

Snapshots are written to a hidden `.incomplete-*` directory and atomically renamed only after every archive, checksum, and manifest is complete. Validation never selects an incomplete snapshot.

Validate the latest snapshot after each backup:

```bash
sudo /root/employee-agent/scripts/validate-production-backup.sh latest
```

`BACKUP_REQUIRED_ARCHIVES` defaults to the complete production set. A deliberately minimal deployment may override it in `backup.env`, but MySQL must remain required.

## Snapshot Validation

1. Verify that the snapshot contains `MANIFEST`, `SHA256SUMS`, and the expected encrypted archives.
2. Run `validate-production-backup.sh latest`; it verifies checksums, decrypts every archive, and tests the compressed stream without extracting user data.
3. Confirm `.last-local-success` is newer than the configured RPO.
4. Confirm `.last-offsite-success` is no older than eight days when off-site backup is enabled.
5. Alert when any validation fails.

The Sunday off-site copy runs only after the full local snapshot passes checksum, decryption, and archive validation.

## Isolated Restore Exercise

Never test a restore over the production directories.

1. Provision an isolated host with matching MySQL, Node.js, Python, JiuwenSwarm, and EA versions.
2. Verify checksums before decrypting.
3. Restore MySQL into an empty database using a dedicated migration-capable account.
   The dump recreates the audit attestation view and function with portable definitions; reapply the runtime account's approved `SELECT`/`EXECUTE` grants after restoration.
4. Restore application data, the skill store, JiuwenSwarm state, and configuration to temporary paths.
5. Point a temporary EA deployment at those paths.
6. Start MySQL, the knowledge service, JiuwenSwarm, and EA in that order.
7. Validate login, chat history, one Agent workspace, one uploaded skill, one knowledge citation, one scheduled task, and one downloadable artifact.
8. Rebuild knowledge indexes when they were excluded from the snapshot.
9. Record actual RPO, RTO, missing files, checksum results, and remediation work.

## Restore Order

1. Configuration and encryption-independent infrastructure.
2. MySQL.
3. Application durable data.
4. Skill store.
5. JiuwenSwarm configuration, sessions, and workspaces.
6. Knowledge index rebuild or index restore.
7. Background workers.
8. EA traffic.

Keep traffic disabled until readiness passes and ownership checks succeed for restored users.
