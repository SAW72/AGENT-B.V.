# Decision Chain Spec — Agent B.V.

**Status:** Draft. Generic. It does not name any operator, product-manager bot, or wallet.

## Purpose

Every action Agent B.V. verifies carries a **decision chain**: an ordered, signed record of who proposed it, who reviewed it, and who approved it. The chain answers one question: who actually decided?

The chain is the product. A badge is only a summary of the chain.

## Chain structure

Each entry is a signed record:

- **actor_id** — identity of the proposer or approver
- **actor_type** — `human` or `ai`
- **model_version** — required when `actor_type` is `ai`; the model and version that produced the action
- **timestamp** — when the action was taken
- **signature** — cryptographic proof the actor authorized this entry
- **scope** — what the actor was authorized to decide
- **authority** — `propose`, `review`, or `approve`

Order is fixed: proposer first, then each reviewer, then the terminal approver. Agent B.V. rejects a chain that is missing, reordered, or unsigned.

## Human vs AI

A badge is not a claim the client can invent.

- The origin tag is written server-side. A client must not be able to hide it or flip it.
- `human` entries require a verified identity anchor (government ID check, passkey, or a wallet signature tied to a prior human verification) plus behavioral signals. A checkbox is not verification.
- `ai` entries must include the agent name and model version.
- No AI actor may present itself as human. No human entry may be stripped of its human tag.
- Nothing here is certainty. The goal is to make impersonation more expensive than it is worth.

## AI instructed by AI vs AI instructed by a human

The chain shows this without knowing the operator's org chart.

- **AI instructed by AI.** Every actor in the chain has `actor_type: ai`. A lead agent may propose, sequence, and recommend. The lineage is still all AI.
- **AI instructed by a human.** A verified human appears in the chain as an actor who approved before the action, not only after it.

Pre-approval means the human decided. A signature added after the action already executed means the AI decided and the human confirmed later. Agent B.V. records which one it is. Post-hoc confirmation is not treated as prior authority.

An AI that reports to another AI is not the same record as an AI that reports to a human. The chain is the difference. No special case is hardcoded for any particular bot fleet.

## Terminal approver rule

For any action that moves, locks, or irreversibly commits funds — transfers, swaps, staking, contract deployments, or anything with a financial consequence — the terminal approver must be a verified human.

An AI agent, including a lead or coordinating agent, may propose, sequence, and recommend. It cannot be the last signature on money. If the terminal approver is `ai`, Agent B.V. blocks the action and logs the attempt with the full chain.

Ordinary scoped work that does not move funds may be approved by an AI actor if that actor's scope says so. Scope is explicit. It is not inferred.

## Accountability

Every AI actor in a chain may also carry an `accountable_human_id`. That field names the human responsible for the agent. Responsibility is not the same as authority. The accountable human is who gets notified. The terminal approver is who was allowed to decide. Those can be the same person. They are not assumed to be.

## Badges derived from the chain

| Badge | When it is issued |
|---|---|
| Trusted | Agent passed the scenario library and behavioral audit. Includes agent name and model version. |
| Not trusted | Agent failed. Includes a written reason. |
| Human | User passed human verification. |
| Human-instructed | Chain contains a verified human approval before execution. |
| Bot-instructed | Every actor is AI. Allowed for non-financial scope only. |

## Audit

Every chain, approved or blocked, is logged with its full contents. No silent failures.

## Open question

Whether human approval is a single signature, or a threshold (for example two humans above a set value), is not decided here. A threshold changes the chain: the terminal slot becomes a set of human signatures, and the action waits until the threshold is met. Do not ship a threshold rule until that number and the value bands are chosen.

## Legal note

This spec describes verification and authority. It does not create a token, a reward, or a promise of value. Counsel should review it together with `docs/AGENT-BV-POINTS-SPEC.md` before either is announced.
