# Wealth Manager Skill 2.1.3 Runtime Review V1

Status: Runtime professional-value pilot PASS / production promotion pending

Reviewed candidate: `wealth-manager-assistant@2.1.3`

Review date: 2026-08-31

Reviewer: `AI-WM-EXPERT-04` / AI-assisted wealth management professional review

Candidate artifact: `be28b298fd3ff80406338099c8e7c4ff2fd18e24c270f958f2d1bc0e785b0bfc`

## Scope

This candidate keeps the professional reasoning introduced in 2.1 and addresses the execution and product-reasoning issues found in real EA comparisons:

1. Use task-specific fast paths instead of scanning every available tool.
2. Stop product retrieval when a previsit or loss-recovery task is not ready for recommendation.
3. Compare product performance only on the same metric, period, and data timestamp; historical returns must not be described as future return potential.
4. Keep enterprise sales eligibility separate from third-party product facts, and never use fixed-term products to satisfy a high-liquidity floor.
5. Allow professional allocation ratios when they are derived from confirmed constraints, amount-balanced, explained, and explicitly subject to customer confirmation.

## Real EA pilot

The comparison used the same `glm-5.2` execution model, the same EA Runtime, the same authorized tools, and the same prompt on both sides. Side A had no target Skill; side B loaded `wealth-manager-assistant@2.1.3`. Promptfoo executed the two sides and the Finance Skill Eval wealth profile performed anonymous pairwise judging.

### Diagnostic cases

The immediately preceding 2.1.3 fast-path artifact, whose previsit and loss-recovery instructions are unchanged in the final artifact, produced:

| Task | Result | Observed professional difference |
|---|---|---|
| Product-maturity previsit | B preferred | B stopped after customer verification failed and did not search or recommend products; runtime fell from 79.6s to 41.7s and business calls from 10 to 1. |
| Loss-recovery preparation | B preferred | B focused on purchase-time suitability, service history, funding horizon and real loss tolerance instead of introducing market news or replacement products. |

These two runs are diagnostic evidence, not final-artifact certification, because later edits changed the candidate digest only in the recommendation and product-fact sections.

### Final-artifact positive recommendation

The final artifact was run against the real ready path for 陈明 (`CUST-000005`), 600,000 yuan, a horizon of at least three years, and a 20% high-liquidity floor.

- Runtime identity: verified; native Skill load: `wealth-manager-assistant@2.1.3`.
- Stream completion: PASS; tool calls and results completed.
- Result: B preferred with high-confidence business judgment.
- A latency: 67.3s; B latency: 186.7s.
- A business calls: 3; B business calls: 10 plus one `skill_tool` load.

The quality gain was concrete rather than compliance-only:

- B rechecked product facts and removed P004 after the enterprise sales record showed that its old sales period had ended without renewal.
- B used open money-market funds for the liquidity layer and kept 131-day, 323-day and 333-day products out of the high-liquidity floor.
- B explained the reinvestment risk created by using sub-one-year products for a three-year objective.
- B generated two amount-balanced proposals and explained the trade-off between liquidity, fixed-income weight and equity exposure.
- B retained the raw `C4` code instead of inventing an institution-specific natural-language label.

The run also exposed the current cost: the more complete product validation improved professional quality but added about 119 seconds and seven business calls. This latency is acceptable for a diagnostic candidate but not yet a production target.

## Runtime fixes discovered by evaluation

The pilot found and corrected two platform issues that were not Skill defects:

1. The unified customer ID `CUST-000005` is now translated internally to the governed Wealth source ID `C005` when the legacy domain Provider is used. The Agent and receipts retain the canonical ID.
2. The wealth Judge now distinguishes enterprise `salesEligibility` from third-party fund facts. A third-party channel's distribution status cannot silently override the bank's product shelf.

## Residual issues and release decision

The final answer still described the user-provided pending amount as “new allocation funds” even though the empty holding list only proves that the governed source returned no holding rows. It also proposed a fixed 30-day reminder without a supplied service rule. Both are small but real fact-discipline regressions.

Therefore:

- `2.1.3` may remain available as a local evaluation candidate and leadership demonstration artifact.
- It must not replace the current production Skill or be deployed to Shanghai yet.
- Promotion requires removal of the two unsupported claims, at least three repeated positive-recommendation runs, and a latency/tool-call reduction pass that does not weaken product reasoning.

## Expected value

- Single-customer previsit should focus on the customer, portfolio, current policy, and decision-changing questions.
- Formal recommendation should prefer the governed allocation context and query only missing facts for at most two candidates.
- Loss recovery should diagnose the existing decision and service history before considering replacement products.
- Default output should be concise enough for frontline use while retaining the core diagnosis, customer language, and next action.

This review does not represent an independent human expert signature or production approval. It records an AI-assisted, real-runtime professional-value pilot and its current limitations.
