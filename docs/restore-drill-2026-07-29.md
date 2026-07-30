# Restore Drill Evidence - 2026-07-29

## Scope

- Source: Shanghai production full encrypted snapshot
- Transfer path: production host -> off-site backup host -> isolated round-trip copy
- Source commit: `b8739b5dfd5ab69ddfe61b46d8ab5ed78b2ca73f`
- Database profile: `full`
- Recovery runtime: network-disabled MySQL 8.0.41 container

## Result

- Snapshot checksums passed at the source, off-site destination, and round-trip copy.
- All five encrypted archives decrypted and passed format validation.
- Application data, skill store, JiuwenSwarm state, and platform configuration extracted into isolated paths.
- 66 database tables imported successfully.
- Audit trigger and attestation-view counts reconciled.
- Critical user, Agent adoption, skill-market, and knowledge-base counts were queried successfully.
- Data-layer RTO: 36 seconds.
- Evidence RPO at drill start: 182 seconds.
- Temporary database and restored plaintext data were deleted automatically.

## Findings Closed During The Drill

1. MySQL protocol compression reduced the full backup window from an aborted
   30-minute uncompressed run to approximately three minutes.
2. Legacy generated-skill links and runtime skill projections were not portable.
   They are now excluded; the encrypted skill store remains authoritative.
3. Archive validation now rejects absolute and escaping symbolic or hard links.
4. MySQL readiness now requires an authenticated query instead of
   `mysqladmin ping`.
5. The full audit import requires a 3 GB recovery-container memory budget.

## Follow-Up

The dedicated-host full application exercise was completed on 2026-07-30.
See `full-application-restore-drill-2026-07-30.md`.
