# Enterprise Asset Sync Foundation V1

This foundation upgrades one-time asset discovery into a governed source
lifecycle without introducing a queue, cache service, or Connector-specific
asset model.

```text
Enterprise Source
       |
       v
Source Run (full / incremental, cursor, attempt)
       |
       v
Stable Source Item (externalItemId)
       |
       +--> unchanged: skip
       +--> content changed: version Candidate
       +--> metadata/path changed: update source observation
       +--> missing after complete full scan: tombstone state
       +--> restored: reactivate the same source item
```

## Control-plane records

`enterprise_asset_source_runs` records one scan attempt, its cursors, completion
semantics, counters, errors, and resume lineage. A unique nullable active-run
key prevents concurrent scans of the same Source.

`enterprise_asset_source_items` maps stable external identities to the existing
Enterprise Asset identity. It records source observations (`etag`, modified
time, content hash, path) and last-seen state. It does not duplicate Asset
owner, classification, authority, lifecycle, or permission metadata.

Candidates carry `syncRunId` and `sourceItemId` only for provenance. Existing
Candidate review and publication remain unchanged.

## Deletion safety

A missing item is inferred only when all conditions are true:

1. the run is a `full` scan;
2. the Connector declares the scan complete;
3. the existing active item was not seen in that completed run.

Incremental scans, incomplete scans, failed runs, and partial runs never infer
deletion. Missing is a tombstone observation, not an automatic Asset retirement
or runtime removal.

## Version safety

An unchanged content hash does not create a Candidate. A changed content hash
creates a version Candidate while retaining the stable Enterprise Asset ID. If
the source changes bytes without changing its declared version, GRACE creates
an immutable `+revision.<hash>` candidate and raises
`VERSION_CONTENT_CONFLICT`; it never overwrites existing evidence.

## Resume semantics

A run may resume only a failed or partial run for the same Source. It inherits
the previous cursor unless an explicit cursor is supplied and increments the
attempt number. Connector batching and background execution can build on this
contract later without changing Source or Candidate identity.
