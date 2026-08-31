# Wealth Manager Skill 2.1.4 Optimization Review V1

Status: Engineering candidate / Runtime diagnostic complete / final wording rerun pending

Reviewed candidate: `wealth-manager-assistant@2.1.4`

Review date: 2026-08-31

Reviewer: `AI-WM-EXPERT-05` / AI-assisted wealth management optimization review

## Objective

Version 2.1.4 keeps the professional reasoning of 2.1.3 while removing two factual overreaches and shortening the formal-recommendation path.

The optimization does not add a new governance engine. EA Runtime continues to determine authorization, suitability and product eligibility; the Skill consumes one governed allocation result and focuses on allocation judgment and customer communication.

## Changes

1. The user-supplied allocation amount is treated only as the current calculation basis. It cannot be described as new money, idle money, maturity proceeds or the customer's total investable assets without supporting facts.
2. Empty holding or maturity arrays are described as no rows returned by the governed source, not as proof that the customer has no holdings or maturities.
3. A formal recommendation starts with one `prepare_wealth_allocation_context` call. The Skill must not separately reload customer profile, portfolio, policy or the complete product shelf.
4. The governed allocation result now includes the portfolio snapshot, product category, current sales status and sales period.
5. Product-detail lookup is limited to one liquidity carrier and at most two final core products when missing term, liquidity or fee facts would change the proposal.
6. Follow-up timing must come from a customer commitment, current sales period or institution rule. The Skill cannot invent a fixed 30-day reminder.
7. A/B plans reuse one verified liquidity carrier and one compact product set. The Skill cannot describe the allocation amount as new money or combine it with current holdings unless the source explicitly establishes that relationship.

## Expected outcome

- Preserve the product-selection and liquidity reasoning demonstrated by 2.1.3.
- Reduce business calls from ten to no more than four for the positive recommendation scenario.
- Avoid unsupported claims about source of funds, current holdings and reminder timing.
- Keep the answer concise enough for a frontline wealth manager to use.

## Runtime diagnostic

Two real Jiuwen Runtime comparisons were executed with `glm-5.2` against the same positive recommendation request.

- The first diagnostic (`skill-eval-e707d7c3dcb9-mtgr19ul`) confirmed that 2.1.4 reduced the 2.1.3 business-call path from ten calls to six and stopped inventing a fixed reminder time. It also exposed that the enterprise model planned customer profile and portfolio calls in the same first turn as native Skill loading.
- The second diagnostic (`skill-eval-c5fad607533f-mtgrh5np`) completed in 150,970 ms with six business calls and 124,685 total tokens. Compared with the 2.1.3 diagnostic baseline of 186,719 ms, ten business calls and 163,338 tokens, this is about 19% faster, 40% fewer business calls and 24% fewer tokens.
- The second answer used only the five products returned by the governed `eligibleProducts` set. The anonymous Judge incorrectly rewarded the no-Skill answer for adding R4 products and translating raw `C4` to a natural-language risk category. The Judge guidance now explicitly prohibits that inference; this Judge result is diagnostic and non-certifying.
- The answer still described the 600,000-yuan calculation basis as new money and combined it with current holdings. The final candidate text now prohibits both claims and limits A/B to one shared three-product set. This final artifact has not been rerun and must remain a candidate.

The diagnostic supports the direction and demonstrates a material efficiency improvement, but it does not approve production release. A short final rerun should confirm the last wording changes before promotion. This review does not represent an independent human expert signature.
