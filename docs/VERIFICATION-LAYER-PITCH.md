> **INTERNAL, counsel review only, not an offer or announcement.**

# AGENT B.V. — Verification Layer for Points Programs

**Status:** Draft pitch. Do not send until counsel reviews the mirrored-points angle.

## The problem

AI bots are farming points programs at scale. The ROBO airdrop saw one group take 87% of tokens across 11,000 wallets. LayerZero zeroed 803,000 addresses. As of September 2026, sybil filters aimed at AI accounts are still rare. It is a matter of when projects start blocking them, not if.

## The solution

AGENT B.V. is a verification layer. Route AI-assisted activity through AGENT B.V., and we attest that a human is behind it. Points go to real users, not bot swarms.

## How it works

1. Users who want to use AI for activity on your program route it through AGENT B.V.
2. AGENT B.V. runs the activity through its adversarial scenario library and behavioral auditing pipeline.
3. A human-verified attestation is issued on-chain.
4. Your program credits the user's points. AGENT B.V. records a mirrored point for the verification.

## Why this is framed as a service

AGENT B.V. is compensated for verification work, not for holding or investing. The comparison is a bandwidth network paying users in stablecoin for a service. Service compensation is not the same thing as an investment contract. This is an argument, not a legal conclusion. Counsel should review it before the pitch goes out.

The mirrored-points structure means AGENT B.V. earns a record from third-party programs' activity. That is a slightly different regulatory posture than only verifying bots. A securities lawyer should look at that specific angle before this is sent.

## What a partner gets

- Sybil resistance aimed at AI accounts
- On-chain, independently verifiable attestations
- No change to the partner's existing points structure
- No token, no purchase, and no referral loop required on the partner's side

## What it costs

A mirrored point per verification. That is the whole commercial term in this draft.

## What the attestation actually says

The attestation distinguishes:

- a human user
- an AI agent that passed or failed the audit (trusted or not trusted, with a reason)
- an AI agent instructed by a verified human
- an AI agent instructed only by another AI

For any action that moves, locks, or irreversibly commits funds, the decision chain's last approver must be a verified human. An AI may propose and recommend. It may not be the terminal approver. Details are in `docs/decision-chain-spec.md`.
