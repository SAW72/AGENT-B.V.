> **INTERNAL, counsel review only, not an offer or announcement.**

# Legal jurisdiction matrix (risk map)

**Status:** Informal **risk map** for Agent-BV maintainers.  
**Not** a formal legal opinion, not a compliance program, and **not a catalog of every law worldwide**.  
**Operator:** Steward of the King LLC · **Contact:** hello@stewardoftheking.com

Counsel should refresh this before any public launch, token distribution, paid institutional product, or marketing that looks like certification or insurance.

Agent-BV is a **US-based experimental** AI/crypto trust-signal project (scores, stamps, denylists, testnet contracts, optional BVT operational token). The table flags **material** regimes that commonly attach to that fact pattern.

| Regime | Why it can attach | Current experimental posture | Watch-outs |
| --- | --- | --- | --- |
| **U.S. federal securities (Howey / Reves; Securities Act / Exchange Act)** | Any token, stake, fee-share, or "earn" narrative can be argued to be an investment contract or note. | No public sale; docs say BVT is operational (fees, auditor bond, governance). Testnet has no value. | Do not market ROI, yield, or profit-share. Counsel **before** any public distribution or listing. See [BVT_SECURITIES_DISCLAIMER.md](BVT_SECURITIES_DISCLAIMER.md). |
| **FTC Act §5 / state UDAP (deceptive or unfair practices)** | Overclaiming "certified safe," "banks can require," "insured," or hardware attestation when the path is a stub. | Stamps are heuristics; TEE may be stub; contracts may be unaudited. | Keep marketing aligned with [DISCLAIMER.md](../DISCLAIMER.md). No fake scarcity, live TVL, or audit-firm badges. |
| **CFAA and similar computer-crime statutes** | Adversarial prompts, denylist research, and "authorized testing" only. Unauthorized access to third-party systems is a crime. | Acceptable use: authorized testing only ([TERMS.md](../TERMS.md)). | Do not probe production systems without written authorization. |
| **OFAC / U.S. sanctions & AML** | API, token, or staking access by sanctioned persons or comprehensively sanctioned jurisdictions. | Terms bar restricted users; no KYC product yet. | Screen before any hosted, paid, or withdrawal-capable surface. |
| **Insurance labeling (state insurance codes; "transacting insurance")** | Calling a fee-funded pool "insurance," promising payouts, or selling "coverage levels." | Pool is an **experimental claims backstop — NOT insurance**. | Never issue certificates of insurance. Institutions that want insurance buy it from a licensed carrier. |
| **Ohio nexus / multi-state common law & consumer statutes** | Operator nexus and Terms choose **Ohio, USA**. Users and institutions may sit in other states (privacy, UDAP, money-transmission, insurance). | Governing law: Ohio ([TERMS.md](../TERMS.md)). No public street address in this pack. | A choice-of-law clause does not waive mandatory out-of-state consumer or insurance rules. |
| **CCPA/CPRA and other U.S. state privacy laws** | Account data, logs, prompts/outputs, fingerprints, wallet addresses. | MVP [PRIVACY.md](../PRIVACY.md): no sale; retention section with 90-day logs; rights requests to hello@stewardoftheking.com. | Production personal data needs a fuller notice-at-collection, retention schedule, and vendor list. |
| **GDPR / UK GDPR** | Prompts, logs, and identifiers of EU/UK residents; U.S. hosting; public-chain irreversibility. | **Not certified** for EU/UK; experimental note in Privacy. No representative appointed in this pack. | Do not target EU/UK as a product market without a real transfer mechanism, RoPA, and counsel. |
| **EU AI Act (and UK AI proposals)** | Scoring/stamping bots that gate financial access can look like a high-risk "AI system" or prohibited social-scoring pattern if oversold. | Positioned as optional experimental signal, not a safety component of a regulated product. | Do not market as an EU-conformity assessment or CE-style AI mark. |
| **MiCA (EU) and other crypto-asset regimes** | Any public offer, admission to trading, or "crypto-asset service" involving BVT or similar. | No EU offer; testnet only as of this writing; no invented mainnet addresses. | Counsel before any EEA marketing or exchange listing. |
| **Global residual** | Export controls, local licensing, defamation (public denylist), IP in prompts/outputs. | Out of scope for this short map. | Assume additional rules apply; this table is not exhaustive. |

## How to use this map

1. Treat every row as a **hypothesis to test with counsel**, not a green light.
2. If a feature crosses from "repo/demo" into "hosted product + money + institutions," re-open securities, insurance, OFAC, and privacy rows first.
3. Prefer **separate written contracts** for any institutional reliance; repo Terms do not create a lawsuit waiver or insurance policy.

Related: [DISCLAIMER.md](../DISCLAIMER.md) · [TERMS.md](../TERMS.md) · [PRIVACY.md](../PRIVACY.md) · [BVT_SECURITIES_DISCLAIMER.md](BVT_SECURITIES_DISCLAIMER.md)
