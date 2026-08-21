# Enterprise Source Connector V1

## Status

Filesystem/NAS Connector V1 is the first implementation of the GRACE enterprise source connector contract.

It proves that a mounted enterprise document source can be converted continuously into governed Candidate Assets without bypassing review, release, Eligibility, or Context Resolution.

Current baseline: **Product Loop Verified**. The dedicated browser test uses a real administrator session and the current worktree server to cover source registration, failure recovery, four incremental source changes, remediation, and review submission.

## Runtime chain

```text
Mounted directory / NAS
        -> authorized full scan
        -> stable Source Item identity
        -> Source Run and Sync Plan
        -> Standard candidate ingestion
        -> Metadata Suggestion / Remediation
        -> Candidate Asset
        -> existing Review / Release flow
```

The connector never publishes an asset automatically.

## Source configuration

Create an active `document_repository` source whose `sourceUri` is a local `file://` URI, then invoke the admin `enterpriseAssets.syncFilesystemSource` mutation.

```text
sourceUri: file:///mnt/bank-knowledge/wealth
```

The existing Enterprise Asset admin page exposes the same operation as **同步挂载目录** for registered `file://` document sources.

The same page includes **来源同步状态** rather than a separate operations dashboard. It shows the latest Run status, last successful synchronization, created/changed/skipped/tombstone counts, source inventory, failure reason, and an explicit recovery action. Source health remains separate from task-level Context Readiness.

## Four-step demonstration

Prepare each source change, then click **同步挂载目录** in the admin page:

```bash
pnpm connector:filesystem:demo --step=1
pnpm connector:filesystem:demo --step=2
pnpm connector:filesystem:demo --step=3
pnpm connector:filesystem:demo --step=4
```

The expected Run results are respectively:

1. 10 New;
2. 1 New, 2 Revision, 8 Skip;
3. 1 metadata/path change with the same Source Item and Enterprise Asset, 10 Skip;
4. 1 Tombstone Candidate, 10 Skip.

The script only mutates a marked demo directory under an authorized Connector root. It refuses to reset a non-empty directory that does not contain its GRACE demo marker.

The administrator browser flow is repeatable with:

```bash
pnpm test:e2e:connector
```

This test starts the current worktree on an isolated local port, creates a temporary administrator and source, exercises failure/resume plus all four change steps, verifies stable identity directly, submits one remediated Candidate for review, checks desktop/mobile layout, and removes its test data.

The resolved source path must be contained by one of the server-side roots in `ENTERPRISE_FILESYSTEM_CONNECTOR_ROOTS`. Multiple Linux roots are colon-delimited. The default allowlist is the application-controlled `data/enterprise-connectors` directory.

## Security boundaries

- Arbitrary paths and non-`file://` URIs are rejected.
- Symbolic links are not followed.
- The source root must itself be a real directory, not a symbolic link.
- Supported knowledge extensions use the existing GRACE allowlist.
- File count, depth, per-file bytes, and total bytes are bounded.
- Candidate content is read only for new or content-changed items.
- Candidate content is rehashed, content-validated, and malware-scanned before staging.
- A file changed between scan and staging fails the Run instead of ingesting inconsistent bytes.

## Identity and change semantics

The stable external identity is `filesystem device + inode + birth-time`. A rename on the same mounted filesystem therefore retains the same Source Item and Enterprise Asset identity, while inode reuse after deletion does not alias a new file to the retired item. Mounts that do not expose these identity fields fail closed.

```text
new identity             -> New Candidate
same identity/new bytes  -> Revision Candidate
same identity/same bytes -> Skip (metadata/path observation may update)
missing after complete full scan -> Tombstone Candidate state
```

If bytes change while the declared version remains unchanged, the existing version is never overwritten. The candidate receives `+revision.<hash>` and `VERSION_CONTENT_CONFLICT` for human resolution.

## Run and deletion semantics

- Every invocation creates a Source Run.
- A source permits only one active Run.
- Failed or partial Runs can be resumed with explicit lineage and incremented attempt.
- A failed scan releases the active-run lock and remains auditable.
- Missing items are inferred only after a successful, complete full scan.
- Incremental, interrupted, partial, or failed scans never infer deletion.
- `cursorAfter` is a deterministic fingerprint of the complete observed source snapshot.

## Acceptance baseline

The V1 tests cover:

1. stable external identity across rename;
2. zero duplicate Candidate for unchanged content;
3. Enterprise Asset identity retention on content change;
4. non-overwriting `+revision.<hash>` semantics;
5. failed Run recovery and resume lineage;
6. deterministic continuation cursor;
7. no deletion from incomplete or incremental scans;
8. tombstones only from successful complete full scans;
9. path allowlist and symbolic-link boundaries;
10. duplicate active Run rejection;
11. failed Run visibility and browser recovery;
12. administrator remediation and review submission;
13. desktop and mobile operations layout without document overflow.

OBS/S3, OA, SharePoint, and federated knowledge providers should reuse the same ingestion service and Source Run/Source Item contract. They differ only in source discovery and content materialization.
