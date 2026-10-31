# Agent-BV Privacy Notice (MVP)

**Last updated:** 2026-10-29

**Controller:** Steward of the King LLC  
**Contact:** hello@stewardoftheking.com

This Privacy Notice describes how the experimental Agent-BV Service may process information. It is an **MVP notice**, not a certified GDPR Article 13/14 pack and not a CCPA "notice at collection" filed with any regulator.

If you do not agree, do not use the Service. See also **[DISCLAIMER.md](DISCLAIMER.md)** and **[TERMS.md](TERMS.md)**.

---

## 1. Who is responsible

The **controller** (or equivalent) is **Steward of the King LLC**. Steward of the King LLC is an Ohio (USA) limited liability company. A street address is not published in this MVP notice. Contact: **hello@stewardoftheking.com**.

This Service is **US-first** and experimental. It is not held out as an EU/UK-certified processing operation.

## 2. Categories of data we may process

Depending on how you use the Service, we may process:

| Category | Examples |
| --- | --- |
| **Account / operator data** | identifiers you volunteer (name, handle, GitHub or email if you contact us), API keys you supply in your own environment, role (auditor, builder, institution). |
| **Fingerprints and scores** | behavioral fingerprints, rubric scores, tier assignments, denylist match levels, stamp hashes. |
| **Prompts and outputs** | scenario prompts, model completions, tool-call traces, audit reports, dispute or claim narratives you submit. |
| **Wallet and chain data** | public wallet addresses, transaction hashes, contract addresses, stake/slash events. Public-chain data is already public. |
| **Logs and telemetry** | IP address, user-agent, request paths, timestamps, error traces, and similar security logs. |

We do not need government ID for the public repo. Do not submit secrets, health records, or children's data.

## 3. How we use data

We use the data above to:

- run audits, issue **experimental** stamps, and operate denylist/registry prototypes;
- debug, secure, and improve the Service;
- comply with law (including sanctions screening where applicable); and
- communicate about incidents or Terms changes if you have given a contact method.

Legal bases (where a basis is required) are typically **legitimate interests** in operating an experimental research tool, **contract** (the Terms), and **legal obligation**.

## 4. We do not sell personal information

We **do not sell** personal information and we **do not share** it for cross-context behavioral advertising as those terms are used in California and similar U.S. state laws. If that ever changes, this notice will be updated first.

## 5. Sharing

We may share information with:

- **Processors** (hosting and database (Render, Cloudflare), CI, email, model APIs such as xAI) under their terms;
- **Public blockchains and RPCs** when you or the protocol write data on-chain. Those writes are typically **worldwide and irreversible**;
- **Professional advisors** and dispute/arbitration participants in a documented process;
- **Authorities** when required by law, valid legal process, or to protect rights, safety, or the Service; and
- a successor, if the experimental project is transferred, subject to this notice or equivalent.

Independent auditors or meta-auditors may see reports you choose to publish or register.

## 6. Retention

We keep off-chain information only as long as we need it to provide the Service, keep it secure, resolve disputes, and meet our legal obligations. After that, we delete it or anonymize it so it no longer identifies you.

- **Application and security logs:** deleted or anonymized within about **90 days**, unless a specific security incident, dispute, or legal requirement needs them longer.
- **Contact and account details you give us:** kept while you use the Service and for a reasonable period afterward to handle follow-up, disputes, or legal requirements, then deleted or anonymized.
- **Fingerprints, scores, stamps, and reports you register:** kept for the life of the registry entry. When the entry is removed, we delete or anonymize the off-chain copy.
- **Backups:** deleted copies may remain in backups until those backups roll off on their normal cycle.
- **On-chain data:** anything written to a public blockchain is **permanent and public**. We cannot edit or delete it, and neither can anyone else.

You may ask us to delete off-chain records we control by emailing **hello@stewardoftheking.com**. We will honor the request unless we must keep the information for legal, security, or dispute reasons, and in that case we will tell you.

## 6.1 Sanctions screening and retention

We screen wallet addresses against the U.S. Treasury OFAC SDN list. Screening may not catch every sanctioned party.

Screening records are kept apart from ordinary application logs:

- A clear row and an unavailable row are kept for 90 days, then deleted.
- A match, a block, and a dispute are kept for 10 years. That period cites 31 CFR 501.601.
- A release of a false positive is appended to an audit table. That table is not deleted on this schedule.

For a match, the wallet address itself is kept so the record can be reported. Other screening rows store only a keyed hash. A released false positive keeps only its audit row.

The denial a person sees does not say why access was refused. Appeals are described in [docs/SANCTIONS-APPEALS.md](docs/SANCTIONS-APPEALS.md).

## 7. Security

We use reasonable administrative and technical measures appropriate to an experimental project (access control, env-only secrets, no committed API keys). **No method is 100% secure.** TEE attestation may be a stub; do not assume hardware-backed confidentiality or integrity.

## 8. Children

The Service is not directed to children under 13 (or under 16 where that is the relevant age). We do not knowingly collect children's personal information. If you believe we have, contact **hello@stewardoftheking.com**.

## 9. U.S. state privacy rights (including California)

If you are a resident of California or another U.S. state with a comprehensive privacy law, you may have rights to know/access, delete, correct, and opt out of sale/share (we do not sell/share as described above), and to non-discrimination for exercising rights.

To exercise rights, email **hello@stewardoftheking.com** with "Privacy request" and your state. We will verify the request as required. You may use an authorized agent where the law allows. We do not currently process "sensitive" personal information to infer characteristics as a consumer product.

This MVP may not yet meet every formal CCPA/CPRA "notice at collection" or annual metrics requirement; treat this as an experimental notice and contact us before sending production personal data.

## 10. EU / UK experimental note

If you are in the EEA, UK, or Switzerland: the Service is **experimental and not certified** for GDPR / UK GDPR. We do not currently appoint an EU/UK representative or offer the Service as a product targeting those markets. Cross-border transfers (including to the United States and to public chains) may occur. Do not submit personal data relating to EU/UK residents unless you have a lawful basis and have accepted the risk that this MVP notice is incomplete for those regimes. See [docs/LEGAL_JURISDICTION_MATRIX.md](docs/LEGAL_JURISDICTION_MATRIX.md).

## 11. Contact

Privacy questions and requests: **hello@stewardoftheking.com**.
