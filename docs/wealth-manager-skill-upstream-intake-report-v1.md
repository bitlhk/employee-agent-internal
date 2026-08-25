# Wealth Manager Skill Upstream Intake Report V1

> Status: governed adaptation candidate implemented; publication pending
> Date: 2026-08-25  
> Source path: `/home/ubuntu/skills/skills-master-skill/skill`  
> Current EA baseline: `wealth-manager-assistant@1.4.0`  
> Current approved artifact SHA-256: `2a755d2bc89c015999634fb05b98184e6c60b01a8e3e997b7648d750593c03f2`
> Candidate: `wealth-manager-assistant@2.0.1`
> Candidate source-tree SHA-256: `88f47211ef32735324688988d5557b69b5fa77c09aedf6812ee38308989fa09f`
> Deterministic security-package SHA-256: `fcbd418fc5b43394d32ea8ccf2671e45e01dde4795000632f21f8b114f38440f`

## 1. Intake Decision

The uploaded directory is not a direct new version of the current
`wealth-manager-assistant` package. It is a delivery workspace containing:

- one routing Skill, `ai-wealth-assistant@3.0.0`;
- nine independently named scenario Skills;
- an MCP source/deployment package;
- a remote integration test script;
- presentation generators, reports, and development guidance.

The current EA marketplace identity is `wealth-manager-assistant`, while the
uploaded router declares `ai-wealth-assistant`. Under the frozen Skill identity
contract, those are different Skills. Content similarity and display names
must not merge them automatically.

Decision:

> Do not publish the whole directory, do not overwrite the current approved
> directory, and do not treat `ai-wealth-assistant@3.0.0` as an automatic
> upgrade of `wealth-manager-assistant@1.4.0`.

The recommended path is to prepare one governed adaptation candidate for the
existing `wealth-manager-assistant` identity. The maintainer must review and
submit the exact adapted artifact; otherwise the adaptation must be maintained
as a system Skill and clearly attributed as adapted content.

## 2. Source Snapshot

The uploaded directory does not include Git metadata, a tag, or a commit ID.
The source URL is known, but the exact upstream revision still needs maintainer
confirmation.

Recorded local fingerprints:

| Scope                                                       | SHA-256                                                            |
| ----------------------------------------------------------- | ------------------------------------------------------------------ |
| Complete uploaded directory, including delivery attachments | `680d34cc43789e233932bf6cdcf10e5e6c97396e262629d9f6fe4f0ba152f216` |
| Ten Skill directories only                                  | `793b087bf30ffe67e6b570500ac93f3b7ef7feafe0823cf14dc9c089fcd01b21` |

These fingerprints prove what was inspected locally. They do not replace an
upstream commit or the final marketplace artifact digest.

The EA static package parser accepted nine correctly framed Skill files and
accepted `wealth-product-analysis` only through fallback parsing. An external
AIG scan of the router was attempted, but its model-backed audit made no
progress and was terminated after more than five minutes. This is recorded as
scanner dependency unavailable, not as a pass or failure. The external scan
must be rerun against the final adapted artifact.

## 3. Skill Inventory

| Skill                          | Declared version | Proposed treatment                                                                                  |
| ------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------- |
| `ai-wealth-assistant`          | `3.0.0`          | Use routing and scenario decomposition as adaptation input; do not create a parallel default router |
| `wealth-kyc-profiling`         | `1.0.0`          | Add as a governed reference after replacing raw customer access                                     |
| `wealth-product-analysis`      | `2.0.0`          | Add as a reference after fixing malformed frontmatter and unsupported chart calls                   |
| `wealth-product-comparison`    | `2.0.0`          | Add as a reference after tool and chart adaptation                                                  |
| `wealth-product-matching`      | `1.0.0`          | Add as a reference only after deterministic suitability integration                                 |
| `wealth-allocation-report`     | `1.0.0`          | Compare with existing governed reference; selectively merge useful output structure                 |
| `wealth-compliance-qa`         | `1.0.0`          | Keep current governed reference as authority; merge only non-conflicting presentation improvements  |
| `wealth-daily-summary`         | `1.0.0`          | Keep current governed reference and add useful templates only                                       |
| `wealth-recommendation-reason` | `2.0.0`          | Keep current governed tool chain; selectively merge six-dimension explanation structure             |
| `wealth-recommendation-script` | `2.0.0`          | Keep current governed tool chain; selectively merge channel-specific output templates               |

## 4. Valuable Upstream Capabilities

The package contains useful Skill-level work that should be preserved:

1. A clear router plus nine single-purpose scenario boundaries.
2. Explicit applicable and non-applicable scenarios for each Skill.
3. Detailed output templates for KYC, product analysis, comparison, matching,
   allocation, recommendation reasons, scripts, compliance, and summaries.
4. Three example cases for most Skills: normal, missing-input, and boundary or
   compliance failure.
5. More detailed professional frameworks, including product comparison,
   recommendation reasoning, and customer-facing communication structures.

These are credible Skill contributions: task decomposition, domain workflow,
professional output structure, and safe-language guidance.

## 5. Publication Blockers

### 5.1 Identity and version are not an upgrade contract

`ai-wealth-assistant` and `wealth-manager-assistant` are different immutable
Skill IDs. The final candidate version for the existing identity remains TBD
and must be strictly greater than `1.4.0`. The maintainer must confirm the
version and changelog; EA must not silently reuse the upstream router's `3.0.0`
history for another identity.

### 5.2 Current GRACE governance would regress

The uploaded Skills use raw tools such as:

- `wealth_assistant_customer_list`;
- `wealth_assistant_product_search`;
- model-performed suitability comparisons.

They do not consume the current governed contracts:

- `get_governed_customer_profile`;
- `get_wealth_policy_basis`;
- `prepare_wealth_maturity_context`;
- `prepare_wealth_allocation_context`;
- operation confirmation, idempotency, and execution Receipt.

Direct replacement would weaken customer field projection, effective-policy
selection, deterministic suitability filtering, bounded maturity scanning, and
governed write operations. Existing GRACE contracts remain authoritative.

### 5.3 Package quality issues

- `wealth-product-analysis/SKILL.md` has malformed frontmatter and is parsed
  only through fallback behavior.
- The ten Skill directories do not contain normalized `manifest.json` files.
- `RenderEchart` is referenced by allocation, product-analysis, and comparison
  content, but it is not a current wealth-role capability.
- Embedded test cases are useful proposals but are not executable Golden Tasks
  and do not prove tool calls or business assertions.
- The delivery report's `37/38 (97.4%)` figure must not be used as a Skill
  quality pass rate. Eleven checks exercise MCP tools, while the 27 named Skill
  scenario checks do not run an Agent or load the Skill. They call data tools
  and record statements such as "the Skill should reject" without observing
  the actual response. This proves partial fixture/API availability, not Skill
  task completion, compliance behavior, or output quality.
- Upstream revision and Skill redistribution/license facts are not frozen.

### 5.4 Delivery attachments are not Skill artifacts

The following must remain outside the marketplace artifact:

- `mcp-servers-deploy-v2.1.zip` and MCP server source;
- `test-full-flow.mjs`;
- `ppt-build/` and generated presentation files;
- architecture, comparison, deployment, and team guidance documents;
- package manager files unrelated to Skill runtime.

The delivery documentation and test script contain environment-specific IPs
and endpoints. The MCP ZIP also contains dependency trees. These can be kept as
upstream engineering evidence but must not be installed into an Agent Skill
workspace.

## 6. Recommended Candidate Shape

Keep one default marketplace and Role Pack identity:

```text
wealth-manager-assistant/
  manifest.json
  SKILL.md
  README.md
  references/
    kyc-profiling/SKILL.md
    product-analysis/SKILL.md
    product-comparison/SKILL.md
    product-matching/SKILL.md
    asset-allocation-report/SKILL.md
    compliance-risk-qa/SKILL.md
    daily-client-work-summary/SKILL.md
    product-recommendation-reason/SKILL.md
    product-recommendation-script/SKILL.md
```

Rules for adaptation:

1. Current GRACE tool, Context, Policy, confirmation, and Receipt contracts win
   when upstream text conflicts with the production baseline.
2. Add the four currently missing scenario references: KYC, product analysis,
   product comparison, and product matching.
3. Selectively merge richer output templates and test ideas into the five
   existing governed references.
4. Remove or conditionally omit `RenderEchart` until a certified capability is
   available to the wealth role.
5. Keep the stable `wealth-manager-assistant` Skill ID. Do not install a second
   broad router by default.
6. Record source origin as adapted, the upstream author as Li Wenhua, the
   repository URL, confirmed revision, and EA adaptation changelog.

The nine scenario Skills may be evaluated later as optional independent market
items. They should not be published in parallel with a broad default router
until trigger overlap, orchestration, and role-install behavior are proven.

### Implemented candidate

The `2.0.1` candidate now follows the shape above. It keeps the existing
`wealth-manager-assistant` identity, adds the four missing governed references,
and preserves the five existing governed references. The marketplace artifact
contains 12 files and nine scenario references; it excludes the upstream MCP
deployment archive, presentation files, remote test scripts, hard-coded
endpoints, credentials, and unsupported chart-rendering calls.

The candidate passed local source parsing, Skill package envelope tests,
TypeScript checks, the frozen 16-case Context Quality Baseline, all 24 Wealth
Role Pack contract cases, all 14 controlled Wealth scenarios, and 35 Knowledge
Service tests. Tencent AI-Infra-Guard scanner `0.2.1` completed against the
deterministic package above with zero findings at every severity. These results
establish an engineering candidate; independent market review, one-Agent
canary, and runtime Provided evidence are still required before role-default
promotion.

## 7. Evaluation and Release Gate

The adapted candidate must be compared with `1.4.0` under the same model,
Context, MCP, identity, clock, and data fixtures.

Required cases:

1. Maturity-customer discovery to governed next action.
2. Customer KYC with field-projected customer profile.
3. Product analysis and two-product comparison using real tool evidence.
4. Customer-specific product matching through
   `prepare_wealth_allocation_context`.
5. Expired or mismatched risk assessment must block a formal recommendation.
6. Current-policy question must use the effective knowledge version.
7. Customer, product, or policy provider unavailable must fail safely.
8. Follow-up creation must require confirmation and produce an execution
   Receipt.

The upstream 38-item script may be retained as MCP smoke-test input after its
environment-specific endpoints are removed. It cannot substitute for the
version-bound Agent behavior evaluation above.

Promotion requires:

- static and external security scanning bound to the exact artifact digest;
- no hard-gate regression against the current wealth Golden Tasks;
- the candidate Skill digest proven in Provided Runtime evidence;
- one-Agent canary before role-default rollout;
- a tested rollback to `1.4.0`.

## 8. Leadership Demo Positioning

The preferred demo story is:

```text
Find a near-maturity customer
  -> explain why the customer should be prioritized
  -> prepare a governed allocation check
  -> stop when risk assessment is invalid
  -> propose a compliant remediation action
  -> create a follow-up only after confirmation
  -> show Context and Execution Receipts
```

The leadership message should distinguish:

- Skill advantage: decomposes a wealth-manager task into a professional,
  repeatable workflow with useful outputs and next actions.
- GRACE advantage: ensures authorized data, effective policy, deterministic
  suitability, safe failure, confirmation, and audit evidence.
- Combined outcome: the role Agent can complete work safely instead of merely
  generating financial text.

## 9. Next Actions

1. Ask the maintainer to provide or confirm the exact Git revision and source
   license/usage status for the uploaded snapshot.
2. Prepare the governed adaptation candidate without changing the current
   approved or runtime package.
3. Produce a file-level changelog and let the maintainer review the final exact
   artifact.
4. The maintainer submits the candidate through the existing
   `wealth-manager-assistant` identity; a different administrator reviews it.
5. Run the fixed comparison and canary release gate before any role-default
   Promote.
