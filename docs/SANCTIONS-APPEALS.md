# Sanctions appeals

**Status: DRAFT**

Appeals go to hello@stewardoftheking.com.

Reviewer: [SPENCER TO NAME]

Response time: [SPENCER TO SET]

We screen wallet addresses against the U.S. Treasury OFAC SDN list. Screening may not catch every sanctioned party.

A confirmed true match is never unblocked. If the wallet address is on the current SDN list, or that list is not ready, the release is refused and the block stays.

False positives only may be released. The release is `POST /v1/admin/sanctions/release`. The caller must authenticate with the secret in `SANCTIONS_RELEASE_SECRET`. That value is read from the environment. It is not stored in this repo. An empty value refuses the route.

Every release is inserted into the append-only table `sanctions_release_audit`. Rows in that table are not updated or deleted. A refused true match is also appended, and it does not remove the block.
