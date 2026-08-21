# StandardParseResult V1

`StandardParseResult` is the versioned derived contract between enterprise
source ingestion, document parsing, metadata suggestion, remediation, and
knowledge indexing.

```text
PDF / Office / OCR / Text
          |
          v
StandardParseResult V1
          |
          +--> Metadata suggestion
          +--> Version and effective-date hints
          +--> Quality diagnostics
          +--> LlamaIndex parent/child indexing
```

It is not an Enterprise Asset, an authority decision, or a second source of
truth. Owner, classification, lifecycle, authority, supersession, and release
status still require deterministic governance and human confirmation.

## Contract

Schema: `ea.standard-parse-result.v1`

The contract contains:

- source content hash and parser version;
- normalized full text and structured segments;
- heading path, page, position, and table/text type;
- structural counts;
- extracted date, version, and effective-date hints with evidence positions;
- parse diagnostics;
- a deterministic fingerprint excluding `generatedAt`.

The source `contentHash` and `parserVersion` control invalidation. A source
content change or a parser behavior change requires regeneration. The
`parseResultFingerprint` detects mutation of a cached derived artifact.

## Runtime use

The existing knowledge parser builds this contract for Markdown, text, CSV,
JSON, YAML, PDF, DOCX, PPTX, and XLSX. PDF OCR remains part of the existing
parser path. LlamaIndex node construction consumes `segments` from the
standard result and stores `parse-result.json` beside the document node cache.

Metadata code may consume explicit hints as suggestions. It must not silently
turn a suggested version or effective date into an approved enterprise fact.
The candidate remains `draft` until the existing review workflow confirms the
metadata.
