# Points Systems and Accountability Layer

**Status:** Draft. Not announced. No token exists. No rewards are promised.

This file is the single copy inside AGENT B.V. of everything discussed for the points programs and the accountability layer. Partner rubrics also live in their own repos:

- STRANDED: points program doc and `docs/POINTS-ANNOUNCEMENT-DRAFT.md` in SAW72/STRANDED
- RAT Score: points program doc and `docs/POINTS-ANNOUNCEMENT-DRAFT.md` in SAW72/rwa-transparency-score
- Agent B.V. detail: `docs/AGENT-BV-POINTS-SPEC.md`, `docs/VERIFICATION-LAYER-PITCH.md`, `docs/decision-chain-spec.md`

Counsel should review before any of this is published.

---

## 1. Rules that apply to every program

1. **Post-facto only.** Points record activity that already happened. Do not announce "use this and you will be rewarded" while the activity is still open.
2. **No consideration.** No purchase, no referral bonus, no holding requirement.
3. **No token during the points phase.** No testnet reward token. No dollar amounts. No "your points are worth X."
4. **Verifiable ledger.** Append-only, keyed by wallet. Unique on (wallet, action, tx_hash). On-chain actions store the transaction hash.
5. **Read-only dashboard.** It reads the wallet address you entered and shows points by category and rank. It does not read a connected wallet. No login, no sign-up, no connect-wallet button.
6. **Freeze.** If the points program ends or pauses, Agent-BV announces it at least 14 days ahead, stops new writes at the stated time, and keeps the off-chain record read-only so anyone can still look up a wallet's activity. There is no snapshot for distribution, no Merkle root, no claim, and nothing is paid out, converted or transferred. The record may be archived or deleted later under the privacy policy.

Points are a record of activity, not an incentive. The product has to be worth using on its own.

---

## 2. STRANDED points

Depth over breadth. One real rescue is worth a lot.

| Action | Points | Notes |
|---|---|---|
| Rescue completed (GasRescue) | 100 + 1 per $1 of token value rescued | Core user signal |
| Relayer job executed | 50 | Registered operator identity required |
| Registry find posted | 30 | Must be a real stranded balance |
| Registry find claimed | 50 | Claim must succeed on-chain |
| Active wallet session | 10 per week | One session per wallet per week |
| Bug report / security finding | 100–500 by severity | Tx hash or reproducible steps |

Anti-gaming: one rescue is 100 points no matter how many wallets. No referral bonuses. No points for holding or transferring. Relayer jobs need a registered operator.

Chain of record: Arbitrum Sepolia.

If the user used an AI agent to perform the rescue, the points count on STRANDED only when AGENT B.V. has attested a human behind that activity. See section 5.

---

## 3. RAT Score points

Breadth over depth. Many small scores, not one big rescue. Not part of the CoinMarketCap build-a-thon submission.

| Action | Points | Notes |
|---|---|---|
| Score generated | 5 | One score generation per wallet per day counts |
| Score attested on-chain | 25 | ScoreAttestation hash on Base Sepolia |
| Score shared on X | 15 | Distribution |
| API integration built | 100 | Must be live and publicly documented |
| Bug report / security finding | 100–500 by severity | Tx hash or reproducible steps |

Same anti-gaming rules. Repeated runs of the same issuer do not multiply.

Chain of record: Base Sepolia.

AI-generated scores count only with an AGENT B.V. attestation. See section 5.

---

## 4. AGENT B.V. points

| Action | Points | Notes |
|---|---|---|
| Verification run completed | 10 | One run per wallet per day |
| Attestation issued on-chain | 50 | Hash locked on-chain |
| Integration built by another project | 100 | Live and publicly documented |
| Bug report / security finding | 100–500 by severity | Reproducible steps or tx hash |
| Partner credits a user because of an AGENT B.V. attestation | 1 mirrored point | No attestation, no mirror |

AGENT B.V. does not pay the partner's points. The partner does. AGENT B.V. only records that it did the verification.

---

## 5. Go-between rule

Other points programs that do not want AI swarms farming them can require this path:

1. The user wants to use an AI agent on STRANDED, RAT Score, or another partner program.
2. That activity is routed through AGENT B.V.
3. AGENT B.V. runs the adversarial scenario library and the behavioral audit.
4. A human-verified attestation is issued on-chain, with the decision chain attached.
5. The partner credits the user's points. AGENT B.V. records one mirrored point.

Without that attestation, AI-assisted activity does not earn partner points.

This is framed as pay for a service (verification), not as a stake in the partner's token. That framing is an argument for counsel, not a conclusion. Earning a record from a third-party program's activity is a different posture than only scoring bots. Do not pitch it publicly until a securities lawyer has read section 5 and `docs/VERIFICATION-LAYER-PITCH.md`.

---

## 6. Accountability layer

The accountability layer is the decision chain. A badge is only a short label on top of that chain. Full field list is also in `docs/decision-chain-spec.md`.

### What a chain entry contains

- `actor_id`
- `actor_type`: `human` or `ai`
- `model_version`: required for `ai`
- `timestamp`
- `signature`
- `scope`: what this actor was allowed to decide
- `authority`: `propose`, `review`, or `approve`
- `accountable_human_id`: optional. The human responsible for an AI actor. Responsibility is not authority. The person who gets notified is not automatically the person who was allowed to approve.

Order is proposer, then reviewers, then the terminal approver. A missing, reordered, or unsigned chain is rejected.

### Human versus AI

- Origin is written server-side. A client cannot hide the tag or flip it.
- A human entry needs a real identity anchor (government ID check, passkey, or a wallet signature tied to a prior human verification) plus behavioral signals. A checkbox is not proof.
- An AI entry names the agent and the model version.
- No AI may present itself as human. No human entry may lose its tag.
- The goal is not certainty. The goal is to make a fake human expensive.

### Who instructed the agent

- **Bot-instructed.** Every actor in the chain is `ai`. A lead agent may propose, sequence, and recommend. The lineage is still all AI.
- **Human-instructed.** A verified human approved before the action executed.

A signature added after the action already ran is a confirmation, not prior authority. Agent B.V. records which one it is. An agent that reports to another agent is a different chain from an agent that reports to a human. Nothing in this spec is hardcoded to a particular bot fleet or operator.

### Terminal approver

If the action moves, locks, or irreversibly commits funds — transfer, swap, stake, deploy, or anything else with a financial consequence — the last approver must be a verified human.

An AI may propose and recommend. It may approve ordinary work inside an explicit scope that does not touch funds. It may not be the last signature on money. If it tries, Agent B.V. blocks the action and logs the full chain.

Whether large transfers need more than one human signature is undecided. Do not invent a dollar threshold here.

### Badges

| Badge | Meaning |
|---|---|
| Trusted | Agent passed the scenario library and behavioral audit. Name and model version are on the badge. |
| Not trusted | Agent failed. The badge includes a written reason. No silent failure. |
| Human | User passed human verification. This badge alone does not authorize moving funds. |
| Human-instructed | A verified human approved before execution. |
| Bot-instructed | Every actor is AI. Allowed only inside a non-financial scope. |

### Audit

Every chain, approved or blocked, is stored in full. No silent failures.

---

## 7. What is deliberately not in this draft

- No live dashboard URL yet.
- No token, testnet or otherwise.
- No public announcement.
- No referral program.
- No promise that points convert.
- No threshold amount for multi-human approval. That stays open until a number is chosen.
