# Wealth Manager Skill 2.1.2 Internal Pilot Decision V1

Status: Contract verified / Shanghai dual-model isolated pilot failed / Candidate rolled back

Date: 2026-08-29

Candidate: `wealth-manager-assistant@2.1.2`

Candidate artifact SHA-256: `b669dd2ad7e6f95a1b0945d2c43302f1d307d7b1d8c8b463424fbcd2fba2f606`

## Decision

`2.1.2` does not pass the single-adoption environment pilot and must not replace
the role default or the current `lgj-lihongkun` adoption. The adoption has been
rolled back to `wealth-manager-assistant@2.0.1`.

No formal score, grade, certification, market quality badge, or human expert
approval is produced by this pilot.

## Valid test boundary

The final decision uses two new isolated Jiuwen sessions. Two earlier requests
without an explicit `channel` resolved to the existing `main` session and are
excluded because their conversation history was not controlled.

Both valid sessions used the same prompt:

```text
明天下午要拜访陈明（C005），请准备访前简报和三至五条谈话要点。
```

The prompt did not request a downloadable file and did not add a test-only
instruction to suppress file generation.

## DeepSeek result

- Model: `deepseek-v4-flash`
- Native Skill evidence: `wealth-manager-assistant@2.1.2`
- Stream completion: one `__stream_end`, no stream transport error
- File behavior: called `write_file` twice despite the Skill rule
- User-visible result: `未知工具 write_file 连续调用 2 次，停止重试`

The generated file body preserved the raw `C4`, customer tier `2`, and empty
record semantics, but the business result was replaced by a tool error. This is
an environment pilot failure.

Evidence SHA-256:
`3e36492eaa75934311f9cf84ddd42f46b0aa7fd46a72b24a17a8bdbeef8c5f17`

## Doubao result

- Model: `Doubao Seed 2.1 Pro`
- Native Skill evidence: `wealth-manager-assistant@2.1.2`
- Stream completion: one `__stream_end`, no stream transport error
- File behavior: called `write_file` once and then returned the body in chat
- Raw-code behavior: preserved `C4`, occupation category `1`, and customer tier
  `2` without unsupported label translation
- Unsupported claims: added `3个月`, `3个工作日`, `他行资金`, and `闲置资金`
  without current evidence
- Presentation leak: exposed the internal `DEGRADED` status to the business user

The fallback preserved the business body, but the unsupported facts and service
deadline violate the frozen evidence-integrity rules. This is an environment
pilot failure.

Evidence SHA-256:
`ba4a01b82870a0e03904a054f16da3146d996c461b1f21226205f93f2e7f8f21`

## Rollback evidence

The Shanghai adoption `lgj-lihongkun` was restored to:

```text
wealth-manager-assistant@2.0.1
artifactSha256=88f47211ef32735324688988d5557b69b5fa77c09aedf6812ee38308989fa09f
runtimeBinding=ready
```

An isolated native `skill_tool` load confirmed version `2.0.1`, followed by one
normal stream completion and no stream error.

Rollback evidence SHA-256:
`81c859527d4fa722e512576298611050448d4c64600af4d11bda1d6ec45c15f9`

## Environment state

Shanghai application release:
`20260829T074322Z-fa5c2f4d522e`

The release keeps `2.1.2` as an immutable evaluation candidate only. It does not
change the role-default Skill, other adoptions, or the default model.

## Next boundary

Do not continue adding repeated governance prose to the Skill. The next narrow
decision is whether the Runtime should expose file-write tools only when the
user explicitly requests an artifact, while professional fact quality remains
an evaluation assertion. That change requires a separate platform review and
is not approved by this pilot record.
