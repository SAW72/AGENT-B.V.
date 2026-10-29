# Sanctions appeals

**Status: DRAFT**

Appeals go to hello@stewardoftheking.com.

Reviewer: [SPENCER TO NAME]

Response time: [SPENCER TO SET]

We screen wallet addresses against the U.S. Treasury OFAC SDN list. Screening may not catch every sanctioned party.

A confirmed true match is never unblocked. If the wallet address is on the current SDN list, or that list is not ready, the release is refused and the block stays.

False positives only may be released. The release is `POST /v1/admin/sanctions/release`. The caller names an admin id in `x-sanctions-actor` and sends that admin's secret in `x-admin-secret` or `Authorization: Bearer`. `SANCTIONS_RELEASE_ADMINS` is a JSON map of admin id to the sha256 hex of that secret. It is read from the environment. It is not stored in this repo. An empty value refuses the route.

Every release attempt that passes that check is inserted into the append-only table `sanctions_release_audit`, including a refused true match and a refused release while the SDN list is not ready. The row stores the admin id in `actor`. Rows in that table are not updated or deleted. Database triggers abort UPDATE and DELETE. A refused true match does not remove the block.

A release deletes the sticky match only in the claim relayer database. It does not clear `sanctions_wallets` on the points indexer. That indexer row is the record that a ready SDN list once contained the address. A later publication that omits the address does not prove the earlier match was a false positive. The indexer has no release route. Points stay withheld. A second clear on the indexer would be a separate audited decision, and Spencer has not asked for one.
