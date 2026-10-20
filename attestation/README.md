# Attestation Layer

Proof that the audit actually ran on the bot you think it ran on.

## The problem
On-chain hashes prove a report existed. They do not prove the report came from a real run against a real bot. A malicious or sloppy auditor can hash a fake fingerprint and write it on-chain, and nobody can tell the difference.

## The fix: Trusted Execution Environment (TEE)
Run the audit inside hardware that signs the result cryptographically. The chain receives proof the computation happened, not just proof someone claimed it happened.

Think of it like a notary who actually watched the signing instead of stamping a blank page.

## Components
- `tee_attestation.md` — how to wrap the audit runner in a TEE (Intel SGX, AMD SEV, or cloud TEE like AWS Nitro Enclaves / GCP Confidential Computing).
- `attestation_report_schema.md` — the signed report format: bot ID, scenario set hash, fingerprint hash, TEE quote, timestamp, auditor signature.
- `verify_attestation.py` — stub verifier that checks the TEE quote against the expected measurement and compares the on-chain hash to the signed report.

## Quick start
1. Read `tee_attestation.md`.
2. Wrap `agentic/tool_calling_loop.py` (or the full pipeline) inside a TEE.
3. Emit a signed attestation report.
4. Submit the report hash + TEE quote to the chain contract.
5. Anyone can run `verify_attestation.py` to confirm the run was genuine.

## Status
Design + schema + stub verifier. Next: pick a TEE provider and wire the first real enclave run.

The software scorer is the judgment. The stamp API and `--require-attestation` accept that score. A model reply is guidance and is not attestation-grade.

**Until a real TEE is wired and documented as live, do not market stamps as hardware-attested.** The current verifier is a stub; on-chain hashes do not prove an enclave ran. See [DISCLAIMER.md](../DISCLAIMER.md).
