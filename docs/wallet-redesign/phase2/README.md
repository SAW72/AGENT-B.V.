# Phase 2 screenshots

Captured from the local production preview (`vite preview`). Widths are 1280 and 390, plus the connected header at 320.

After shots use a fixture wallet (`0x5D467FA00eC0E92044f779e495a17db66c5964aa` on the action shots, `0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac` on the earlier task and form shots). `eth_sendTransaction` is never forwarded to the network. Contract reads, balances, arbitrator seating, escrow state, and receipts use the real Base Sepolia RPC at `sepolia.base.org`. Nobody signed a transaction.

The live Vault has no registered bots, so a real `createEscrow` eth_call reverts `InvalidParties`. The waiting, cancelled, pending, and confirmed fund shots answer that one preflight eth_call as success so the wallet step can be shown. Every other read still goes to Base Sepolia. Each of those images says so in the caption bar.

There is no escrow on the live contract, so release, refund, and dispute cannot prepare. Those input shots show the real read. Their review shots are the review step opened from the address bar with nothing prepared, which does not submit. Vote stays disabled because the fixture is not a seated arbitrator. Withdraw shows a live credit of zero.

The confirmed fund shot returns historical Base Sepolia tx `0x0d39f2502956d1199bb9d264704aacab85ca7a5d54de3e1634b201c730b62b6c` from the fixture and reads that receipt from the RPC. The pending shot returns a hash that is not on Base Sepolia; the real receipt read stays pending inside the grace window. The unreadable shot forces `eth_getTransactionReceipt` for one hash to a transport error.

Before shots are main `74f09b79` (Phase 1, PR #73).

The connected header at 320px measures 48px tall, on two rows: the Agent-BV name, then the testnet pill and the compact wallet chip.

| File stem | What it shows |
| --- | --- |
| `before-*-home` | Phase 1 long page, before guided flows |
| `before-320-header` | Phase 1 header at 320px with a wallet connected |
| `after-*-task-picker` | Task picker home |
| `after-*-fund-step1` | Fund, escrow id and payee |
| `after-*-fund-step2` | Fund, bot identifiers |
| `after-*-fund-step3` | Fund, amount and time window |
| `after-*-fund-review` | Fund review in plain words |
| `after-*-release-input` | Release input, live read, action unavailable |
| `after-*-release-review` | Release review opened from the link, nothing prepared |
| `after-*-refund-input` | Refund input, live read, action unavailable |
| `after-*-refund-review` | Refund review opened from the link, nothing prepared |
| `after-*-dispute-input` | Dispute input, live subject read |
| `after-*-dispute-review` | Dispute review opened from the link, nothing prepared |
| `after-*-vote-input` | Vote visible and disabled for a non-arbitrator |
| `after-*-vote-review` | Vote review opened from the link, nothing prepared |
| `after-*-withdraw-input` | Withdraw input, live credit read |
| `after-*-withdraw-review` | Withdraw review opened from the link, nothing prepared |
| `after-*-fund-waiting` | Confirm in MetaMask, with the popup hint |
| `after-*-fund-cancelled` | Cancelled in the fixture wallet (4001) |
| `after-*-fund-pending` | Waiting for Base Sepolia |
| `after-*-pending-strip` | Pending transactions strip, including Copy on the escrow id |
| `after-*-fund-confirmed` | Confirmed, with Next: release the payment |
| `after-*-receipt-unreadable` | Receipt read forced to error |
| `after-*-l8-future-record` | Future-dated record keeps the hash until Try again anyway |
| `after-320-header` | Connected header at 320px |
