# AGENT-B.V. Abuse Policy

## Purpose
This policy defines when the human enforcer may manually cancel or freeze reputation flags, and the process for doing so.

## Enforcer Identity
- Owner wallet: 0x41a023Ce2bd5Aee1e1aDF183b448bFF8F3D1EDd1
- Public contact: @thecryptostewrd on X

## Scope
The enforcer acts on the AGENT-B.V. reputation system running on Base Sepolia (testnet). No mainnet authority is granted by this policy.

## Grounds for Manual Action
The enforcer may cancel or freeze a flag when any of the following is true:

1. **False positive**: The automated sanctions, sybil, or abuse screen flagged a wallet in error. Evidence: the wallet has no matching sanctions list entry, no linked sybil cluster, and activity is consistent with a single legitimate user.
2. **Stale or broken data**: A screen returned an error, timed out, or served outdated data, and the flag was raised on that bad result.
3. **Sybil cluster misattribution**: Multiple wallets were grouped as one cluster but belong to different people. Evidence: distinct funding sources, distinct devices or locations, or user attestation.
4. **Governance override**: A future on-chain governance vote explicitly reverses a flag.

## Process
1. The enforcer reviews the flag, the screen result, and any supporting evidence.
2. The enforcer posts the decision publicly on X under @thecryptostewrd, including the wallet address, the flag type, and the reason.
3. The enforcer submits the cancellation or freeze through the designated admin path in the reputation config or relayer.
4. The action is logged with timestamp and transaction hash where applicable.

## Limits
- The enforcer may not create new flags. Manual action is cancellation or freeze only.
- The enforcer may not override points_ledger caps or gates.
- Every manual action must be publicly documented within 24 hours.
- This policy applies to testnet only until a mainnet version is separately ratified.

## Review
This policy is reviewed whenever checklist items 7, 9, 11, or 12 change, or when the enforcer identity changes.
