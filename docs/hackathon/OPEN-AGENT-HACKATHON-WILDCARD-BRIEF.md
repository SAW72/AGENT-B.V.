# Open Agent Hackathon — Wildcard Tinkerer Track Brief

**Prepared for:** Bob, Product Manager — Agent-BV
**Prepared by:** Ara (research & strategy)
**Date:** October 10, 2026
**Status:** Draft for review — do not submit until polish/fixes are complete

---

## 1. The opportunity

The **Open Agent Hackathon** runs **October 22–27, 2026**, with up to **$20,000** across four tracks. Registration closes **October 22**.

Regular tracks require building core functionality during the build window — pre-built projects cannot be resubmitted there. The **Wildcard Tinkerer** track is the exception: you bring an existing project and extend it during the build window. That is exactly Agent-BV's situation.

**The catch:** the wildcard track requires integrating the sponsor technologies — **Zetaris** and **Meterless** — and scoring is on the *new* work, not what Agent-BV already does. So the entry is not "Agent-BV as-is"; it is "Agent-BV + sponsor integrations built during Oct 22–27."

---

## 2. What Agent-BV already is (the foundation)

- Adversarial audit stack for AI agents: **125 scenario prompts** across five categories (privilege escalation, data exfiltration, instruction override, long-horizon sabotage, tool-abuse chains)
- Multi-axis scoring rubric and behavioral fingerprinting
- Behavioral archaeology and sandbagging detection
- Agentic tool-use layer (`agentic/tool_calling_loop.py`)
- On-chain attestation on Base Sepolia: Denylist, Vault, Liability, InsuranceFund, DisputePanel, and the live **BotAttestationEscrow** at `0x3d660502D75f1e97b08c110255921b437A3C4C42`
- Gate B seated with three arbitrators; ownership with the governance timelock
- Wallet UX at https://agent-a-wallet-ux.pages.dev reading live contracts
- Full test run passed (all tests green)
- Dual license: AGPL-3.0 or commercial
- Open items in `SECURITY.md` before mainnet: one ruling can settle two deployments; an early vote blocks the link; `release()` has no caller check

---

## 3. Sponsor technologies

### 3.1 Zetaris — federated data harness

Zetaris lets agents query live data across cloud, on-prem, and edge sources **without moving or duplicating it**. For Agent-BV this means the audit pipeline can query live on-chain data, historical attestation records, and behavioral logs in place, instead of copying everything into a central database first. The "query in place" angle is exactly what an audit product wants to claim: auditors can pull attestation history across deployments without centralizing sensitive data.

**Integration angle:** Zetaris-fed live data queries become the data layer behind the audit pipeline and the wallet UX reputation views.

### 3.2 Meterless — local-first context layer for agents

Meterless ships four engines:

| Engine | Role |
|---|---|
| **H-MEM** | Tiered memory with a built-in **audit ledger** for memory provenance and conflict handling |
| **World Model** | Shared state across agents |
| **Markovian** | Bounded long-task reasoning |
| **Scout Intent** | Intent routing |

Meterless's repo ships hackathon starter templates, so the integration path is documented.

**Integration angle:** H-MEM's audit ledger maps directly onto Agent-BV's core value — behavioral archaeology and fingerprinting. Wiring H-MEM's audit ledger into the attestation pipeline is a coherent extension, not a forced one. Memory compounding across audit sessions gives the product a longitudinal dimension it currently lacks.

---

## 4. Proposed integration architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AGENT-BV CORE (existing)                 │
│  125 scenarios → scoring rubric → fingerprint → attestation   │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
                ▼                             ▼
┌───────────────────────────┐   ┌──────────────────────────────┐
│  ZETARIS (data layer)     │   │  METERLESS (memory layer)    │
│  • Query attestation      │   │  • H-MEM audit ledger        │
│    history in place       │   │    → provenance of every     │
│  • Cross-deployment       │   │      behavioral signal       │
│    reputation queries     │   │  • World Model → shared      │
│  • No data centralization │   │    state across audit runs   │
│                           │   │  • Markovian → long-horizon  │
│                           │   │    scenario execution        │
│                           │   │  • Scout Intent → routing    │
│                           │   │    audit tasks to the right  │
│                           │   │    engine                    │
└───────────────────────────┘   └──────────────────────────────┘
                │                             │
                └──────────┬──────────────────┘
                           ▼
              ┌────────────────────────────┐
              │  Wallet UX (existing)      │
              │  agent-a-wallet-ux.        │
              │  pages.dev                 │
              │  + new Zetaris-fed views   │
              └────────────────────────────┘
```

**Data flow (proposed):**

1. Audit run produces behavioral signals (existing pipeline).
2. Signals are written to H-MEM's tiered memory with provenance entries in its audit ledger (Meterless).
3. Attestation records and cross-deployment history are queried via Zetaris without centralizing them.
4. The wallet UX surfaces both: the live on-chain attestation (existing) and the compounded memory/reputation view (new).

---

## 5. What the demo would show (five steps)

1. Run the existing audit pipeline — 125 scenarios, scoring, fingerprint.
2. Show the audit report and the on-chain attestation on Base Sepolia.
3. Show H-MEM's audit ledger capturing provenance of each behavioral signal across sessions.
4. Show a Zetaris-fed query pulling attestation history across deployments in place.
5. Open the wallet UX and demonstrate the new compounded reputation view.

---

## 6. Honest caveats (keep these in the submission)

- Testnet only (Base Sepolia). No mainnet deployment yet.
- Three open security items in `SECURITY.md` (see Section 2).
- Scores are heuristics, not certifications.
- Sponsor integrations are new work built during the build window — the existing stack is the foundation, not the entry.

Judges trust a project that names its own gaps more than one that hides them.

---

## 7. Timeline

| Date | Action |
|---|---|
| Now – Oct 21 | Polish and fix (in progress by the team) |
| **Oct 22** | **Registration closes** — register even if submission isn't final |
| Oct 22–27 | Build window: implement Zetaris + Meterless integrations |
| Oct 27 | Submission deadline |

**Key point:** registration and submission are separate deadlines. Register on the 22nd regardless of polish status.

---

## 8. Open questions for Bob

1. Which Zetaris and Meterless repos/APIs should we pin as dependencies? (Meterless ships starter templates — confirm which one fits the Python audit pipeline vs. the wallet UX.)
2. Should the H-MEM audit ledger write be synchronous with attestation stamping, or async?
3. Do we want a separate `hackathon/` branch for the wildcard work so main stays clean?
4. Who owns the demo script and the submission write-up?

---

## 9. Next step

Once the polish/fixes land, the next concrete action is: **register for the Open Agent Hackathon by October 22**, then scope the Zetaris and Meterless integration tickets for the build window.
