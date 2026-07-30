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
OFFSITE_BACKUP_FREQUENCY=weekly
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
4. Confirm `.last-offsite-success` is no older than 26 hours when
   `OFFSITE_BACKUP_FREQUENCY=daily`, or eight days when it is `weekly`.
5. Alert when any validation fails.

The default Sunday off-site copy runs only after the full local snapshot passes
checksum, decryption, and archive validation. Set
`OFFSITE_BACKUP_FREQUENCY=daily` for the A-level 24-hour disaster-recovery RPO;
daily core snapshots are validated before transfer and Sunday still uses the
full profile.

## Isolated Restore Exercise

Never test a restore over the production directories.

The backup command enables MySQL protocol compression by default, preventing a
remote database from sending the uncompressed dump over the network. Set
`MYSQL_DUMP_COMPRESS=false` only for an older client or server that does not
support compression.

Runtime skill projections, generated-skill links, dependency smoke virtual
environments, caches, and `node_modules` are excluded. Their authoritative
packages are held in the separately encrypted skill store and are reconciled
back into each Agent after recovery. This keeps snapshots portable and prevents
legacy absolute links from crossing the restore boundary.

The repository includes a data-layer restore drill that validates and decrypts
the selected snapshot, restores all durable archives to an isolated directory,
imports MySQL into a temporary network-disabled container, verifies critical
tables and audit triggers, and writes an RPO/RTO report:

```bash
sudo EMPLOYEE_AGENT_BACKUP_CONFIG_DIR=/root/.config/employee-agent \
  /root/employee-agent/scripts/run-restore-drill.sh latest
```

The temporary MySQL container has no published port and is deleted when the
drill exits. Restored files are also removed by default; set
`RESTORE_DRILL_KEEP_DATA=true` only on an approved isolated host when manual
inspection is required. The generated `REPORT` contains counts and operational
timings, not row contents.

The default drill budget is 3 GB memory, 2 CPU, and a 4 GB tmpfs. Override
`RESTORE_DRILL_MYSQL_MEMORY`, `RESTORE_DRILL_MYSQL_CPUS`, or
`RESTORE_DRILL_MYSQL_TMPFS_SIZE` on a smaller dedicated recovery host.

On the approved isolated recovery host, install the monthly timer explicitly:

```bash
sudo RESTORE_DRILL_RECOVERY_HOST=1 \
  /root/employee-agent/scripts/install-restore-drill-timer.sh
```

When backups first land on a separate backup node, use
`scripts/sync-latest-backup.sh` there to push the latest checksum-valid encrypted
snapshot to the recovery host. Schedule that transfer before 06:30; the restore
timer deliberately starts at 06:30 on the first day of each month so it consumes
the latest completed transfer.

The repository also provides `scripts/install-backup-sync-timer.sh`. Install the
sync runner on the backup node, place its environment in the root-readable
`/root/.config/employee-agent/backup-sync.env`, and enable the daily 04:30 timer.
The timer uses a dedicated SSH key that can write only to the recovery host's
backup account; the recovery host does not receive credentials that can modify
the primary backup node.

The installer refuses to run without the recovery-host acknowledgement. It
does not enable scheduled restore work on the production application host. The
timer writes its latest successful bounded report to
`/var/lib/employee-agent-restore-drills/.last-success-report`.

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

## Post-Restore Reconciliation

Before starting EA on a replacement host:

1. Prefer repository-relative paths for repository-owned configuration:

   ```dotenv
   ROLE_SKILL_MCP_BASELINE_PATH=docs/design/role-skill-mcp-baseline.json
   ```

   External enterprise baselines must be restored separately and configured
   with their new absolute path. EA does not silently replace a missing
   enterprise baseline with the public default.

2. Rebase durable Skill sources and discard restored runtime projections. Each
   `--path-map` is explicit and its destination must already exist:

   ```bash
   cd /srv/employee-agent
   pnpm restore:reconcile -- \
     --path-map=/root/employee-agent=/srv/employee-agent \
     --path-map=/root/skill-store=/srv/skill-store
   ```

   The command retains durable source packages, recalculates JiuwenSwarm
   runtime paths, and reconciles enabled skills into current Agent workspaces.

3. When `UPLOAD_ANTIVIRUS_MODE=required`, install and verify ClamAV before
   admitting traffic:

   ```bash
   sudo apt-get install -y clamav clamav-daemon
   sudo systemctl enable --now clamav-freshclam clamav-daemon
   printf 'employee-agent antivirus readiness probe\n' | clamdscan --no-summary -
   ```

   A required but unavailable scanner makes `/health/ready` return `503`.
   New installations can request this policy with
   `scripts/bootstrap-install.sh --with-antivirus`.

4. Start the knowledge service before EA. On startup, EA compares every
   non-empty knowledge base in MySQL with the knowledge service's physical
   indexes. Missing indexes receive durable `index_missing_recovery` jobs.
   Readiness remains closed until this audit has completed; index rebuilds then
   continue through the managed background worker.

5. Start JiuwenSwarm and EA, then wait for `/health/ready` before enabling the
   reverse proxy.
