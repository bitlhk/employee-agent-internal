# Enterprise Object Storage Connector V1

## Status

`OBS/S3 Connector V1: Product Loop Verified`

This connector validates that an OBS or S3-compatible object source can enter
the existing GRACE source lifecycle without creating a second asset model:

```text
List Objects
  -> stable bucket/key identity
  -> ETag/lastModified fast validation
  -> controlled download when required
  -> antivirus and content validation
  -> SHA-256 content identity
  -> Candidate / Revision / Skip / Tombstone
  -> Remediation / Review / Release
```

The connector discovers and stages candidates. It never approves or publishes
an enterprise asset automatically.

## Source Configuration

The source registry stores only non-sensitive connector configuration:

```text
obs://demo-bank/wealth/policy/?
  endpoint=https%3A%2F%2Fobs.cn-east-3.myhuaweicloud.com&
  region=cn-east-3&
  credentialRef=env%3A%2F%2FGRACE_OBS&
  forcePathStyle=true
```

Supported fields are deliberately narrow:

| Field | Meaning |
|---|---|
| `endpoint` | Allowlisted S3-compatible endpoint; required for `obs://` |
| `bucket` | Source bucket, represented by the URI host |
| `prefix` | Allowed object prefix, represented by the URI path |
| `region` | Signing region |
| `credentialRef` | Server-side `env://NAME` reference, never a credential value |
| `forcePathStyle` | Whether the client uses path-style bucket addressing |

For `credentialRef=env://GRACE_OBS`, the runtime resolves:

```text
GRACE_OBS_ACCESS_KEY_ID
GRACE_OBS_SECRET_ACCESS_KEY
GRACE_OBS_SESSION_TOKEN        # optional
```

Credential values are not written to Asset Metadata, Binding, Candidate,
Receipt, Source Run metadata, or audit metadata.

Custom endpoints must be listed in the comma-delimited
`ENTERPRISE_OBJECT_STORAGE_ENDPOINTS` environment variable. Unknown URI query
parameters are rejected to prevent credentials being placed in source URLs.

## Identity And Change Detection

The canonical external identity is `bucket + object key`. The database stores a
deterministic SHA-256 identifier derived from that canonical value so full S3
key lengths do not exceed indexed column limits. A content revision at the same
key keeps the existing Enterprise Asset ID.

ETag is a remote change validator, not a content hash. Multipart and
provider-specific ETags are stored as received after quote normalization. GRACE
reuses the prior content hash only when ETag, object size, and second-normalized
`lastModified` all match. Otherwise it downloads the body and computes SHA-256.

The download response ETag and Last-Modified must still match the listing
snapshot. If the object changes between listing and download, the run fails and
must be retried.

## Pagination, Recovery, And Deletion

The connector follows S3 `ContinuationToken` pages until a complete listing is
obtained. A missing continuation token on a truncated response is an error.

A failed page or object download fails the Source Run with `scanComplete=false`.
Recovery creates a linked retry Run and repeats the complete listing. V1 does
not continue from a middle page because earlier page state is not committed;
restarting preserves a single coherent deletion snapshot.

Tombstones are produced only after all pages and required downloads complete.
Partial or failed listings never infer deletion.

## Operational Limits

The runtime limits are configurable:

```text
ENTERPRISE_OBJECT_STORAGE_MAX_OBJECTS
ENTERPRISE_OBJECT_STORAGE_MAX_OBJECT_BYTES
ENTERPRISE_OBJECT_STORAGE_MAX_DOWNLOAD_BYTES
ENTERPRISE_OBJECT_STORAGE_MAX_PAGES
```

Unsupported file extensions are counted and skipped. Supported bodies reuse the
same upload content validation, antivirus policy, candidate staging, metadata
suggestion, and remediation paths as file upload and Filesystem/NAS sources.

## Verification

```bash
pnpm vitest run server/_core/object-storage-source-connector.test.ts
RUN_DB_INTEGRATION_TESTS=1 node --env-file-if-exists=.env \
  node_modules/vitest/vitest.mjs run --no-file-parallelism --maxWorkers=1 \
  server/db/object-storage-source-connector.integration.test.ts
pnpm exec playwright test e2e/object-storage-connector.pw.ts \
  --config playwright.connector.config.ts
```

The browser scenario verifies registration, paginated sync, failed download
recovery, additions, revisions, unchanged skips, full-listing tombstones,
remediation review, credential isolation, and desktop/mobile layout.

Real Huawei Cloud OBS environment acceptance is intentionally separate from the
protocol-level product loop. Execute
`docs/huawei-obs-environment-acceptance-runbook-v1.md` before marking the
connector `Environment Verified`. That acceptance stops at Candidate /
Remediation and does not exercise the later Knowledge-indexing
`StandardParseResult` path.
