# AGENT B.V. Points Program

**Status:** Draft. Not yet announced. No token exists. No rewards are promised.

## Purpose

Track genuine usage of AGENT B.V., the AI bot verification layer, so that if a token ever launches, early contributors can be recognized. Points are off-chain scores only.

## Design principles

1. **Post-facto only.** Points record activity that already happened. Nothing is announced during the activity phase that says "use this and you will be rewarded."
2. **No consideration.** No purchase, no referral, no holding requirement. Points come from using the product.
3. **No token during points phase.** No testnet token is minted. No dollar values are shown anywhere.
4. **Conversion rate set at TGE, never before.**
5. **Verifiable.** Every on-chain attestation carries its transaction hash.

## Scoring rubric

| Action | Points | Notes |
|---|---|---|
| Verification run completed | 10 | A bot run through the adversarial scenario library |
| Attestation issued on-chain | 50 | High-value action — locks a hash on-chain |
| Integration built by another project | 100 | Another points program or app wires in AGENT B.V. |
| Bug report / security finding | 100–500 by severity | Must include reproducible steps or a tx hash |
| Points earned via AGENT B.V. on a partner program | 1:1 mirror | See cross-program section |

## Cross-program points — the go-between model

AGENT B.V. can sit in front of other projects' points programs, including STRANDED and RAT Score.

- A partner project runs its own points program.
- Users who want to use AI to generate points on that program route the AI-assisted activity through AGENT B.V.
- AGENT B.V. checks that a human is behind the activity and issues an attestation.
- The partner credits the user's points. AGENT B.V. earns one mirrored point for the verification.

This is a service, not a reward. AGENT B.V. is compensated for verification work. The same logic is used by bandwidth networks that pay in stablecoin for a service rather than for holding a token. The March 2026 SEC/CFTC interpretation treats service compensation as failing Howey's first prong when the recipient is paid for work, not for an investment of money.

AI-generated activity on a partner program that wants this protection does not count unless it carries a valid AGENT B.V. attestation.

## Badges

AGENT B.V. issues badges. A badge is a claim about the last verified run, not a promise of future behavior.

- **Trusted.** The agent passed the adversarial scenario library and behavioral audit. The badge names the agent and model version.
- **Not trusted.** The agent failed. The badge includes a written reason. No silent failures.
- **Human.** A user passed human verification (identity anchor plus behavioral signals). The badge says a human is present. It does not by itself authorize fund movement.
- **AI instructed by a human.** The decision chain ends in a verified human before the action.
- **AI instructed by an AI.** Every actor in the decision chain is an AI. This is allowed for ordinary work. It is not allowed as the terminal approver on anything that moves, locks, or irreversibly commits funds.

See `docs/decision-chain-spec.md` for the chain rules.

## Anti-gaming

- No referral bonuses.
- No points for holding or transferring tokens.
- Bug bounties require a verified finding.
- Partner integrations must be live and publicly documented.
- One verification run per wallet per day counts.
- Mirrored points require a valid on-chain attestation. No attestation, no mirror.

## Ledger

- Append-only PostgreSQL table keyed by wallet address.
- Unique constraint on (wallet, action, tx_hash) prevents double-counting.
- Rows for on-chain attestations store the transaction hash.
- Dashboard is read-only: enter a wallet address, see points by category and rank. No login, no connect-wallet button, no sign-up.

## Snapshot and freeze

Same mechanics as STRANDED and RAT Score: 14-day advance notice, T-zero freeze, Merkle tree over (wallet, total_points), on-chain root, claim with a Merkle proof plus a wallet signature. Unclaimed points after 90 days go to a community treasury, not the team.

## Conversion (illustrative only — rate set at TGE)

Example: 5% of a 100M token supply = 5M tokens for points.

- 2M points earned → 2.5 tokens/point
- 5M points earned → 1 token/point
- 10M points earned → 0.5 tokens/point

## Allocation (illustrative)

- Team and investors: 20% (4-year vest, 1-year cliff)
- Treasury: 25%
- Liquidity: 10%
- Public sale: 15%
- Points: 5%
- Unallocated (future incentives): 25%

## Legal note

This structure follows the SEC/CFTC March 2026 joint interpretation guidance on airdrops. It is an interpretation, not a statute, and does not bind a court. A securities lawyer should review before any public announcement or token launch, especially the mirrored-points model, because AGENT B.V. would earn value from third-party programs' activity. That is a different posture than only verifying bots.
