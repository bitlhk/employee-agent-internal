# Insurance Customer Profile Authorization Review V1

Status: NOT APPROVED / Provider Scope Gap

Review date: 2026-08-24

## Decision

Do not grant the Insurance Advisor Role Pack access to `wealth_assistant_customer` in its current form.

The canonical `customer_profile` semantics remain reusable, and the enterprise source may remain a future shared source. The current Provider contract cannot enforce the minimum insurance-purpose field projection, so granting the MCP server would expose a materially broader wealth customer payload than the Insurance Golden Tasks require.

No Role Asset grant, Binding, Resolver, Golden Set, or Principal Authorization state is changed by this review.

## Minimum Insurance Purpose Fields

IA-GT-01 and IA-GT-02 require the following minimum business facts:

- stable, non-sensitive customer subject reference and display name;
- proof that the customer is within the current Insurance Advisor service scope;
- customer status and recent-contact summary;
- vehicle identity in masked form, brand/type, new-energy attribute, count, and usage nature;
- renewal date/status and current coverage summary;
- claims or high-risk summary required for escalation, without raw case material;
- confirmed needs, budget concern, service preference, and communication preference;
- source and data `asOf` timestamp.

The task does not require full phone number, detailed address, native place, education, employer details, bank balances, holdings, product recommendation scores, banking activity metrics, payment information, identity documents, or raw claim materials.

## Current Provider Contract

The current `wealth_assistant_customer_detail` response includes broad wealth-domain data:

- customer master fields including full phone number and detailed address;
- investment-risk and wealth-customer attributes;
- deposit and financial-asset balances;
- held and matured wealth products;
- product recommendation scores;
- banking activity and relationship metrics.

The observed response does not provide the vehicle, usage-nature, renewal, current insurance coverage, and claims-summary fields required by the Insurance Golden Tasks.

## Enforcement Assessment

The current authorization path verifies that a Role Pack is granted the entire MCP server and derives a row-level `userCode`. It does not pass or enforce:

- runtime purpose;
- an insurance-specific field allowlist;
- a response projection version;
- field-level denial evidence.

The Customer Provider returns the complete customer-detail payload after server-level and row-level authorization. Existing Eligibility therefore cannot prove that an Insurance Advisor receives only the minimum insurance-purpose fields.

Result:

```text
Same canonical Context:     YES
Potential shared source:    YES
Current MCP grant safe:     NO
Field projection enforced:  NO
Insurance authorization:    NOT APPROVED
```

## Required Remediation Before Re-review

The same physical Provider may be reconsidered only after it supports a governed insurance projection:

1. accept trusted `role` and `purpose` from the runtime authorization decision;
2. enforce Insurance Advisor row/customer scope independently of Wealth Manager scope;
3. return a versioned `InsuranceCustomerProfileV1` allowlist projection;
4. omit all non-allowlisted wealth, contact, address, holdings, recommendation, and activity fields;
5. provide vehicle, renewal, coverage, and risk-summary fields from authoritative systems;
6. record projection version, requested purpose, applied filter, filtered-field count, source time, and result fingerprint in Provider evidence;
7. pass field-leakage, cross-role, missing-field, stale-data, and unauthorized-customer tests.

The preferred architecture is a purpose-aware projection from the same enterprise customer source. A separate Mock or duplicate customer source does not satisfy Shared Binding Identity.

## Gate B Consequence

Insurance Principal Authorization Fingerprint remains unchanged. The current authorization-aware Gate validation snapshot remains valid for the blocked state:

```text
799ec8c235e756f4530851eca6d6d6d7acaea09f675adbf6fff87e677bb49ba4
```

Gate B remains blocked for Insurance `customer_profile` at Candidate Provided `2/3`. No new Gate snapshot or full certification rerun is required until authorization or an input bound by the Context snapshot changes.
