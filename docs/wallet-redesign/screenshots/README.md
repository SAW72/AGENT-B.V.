# Phase 1 screenshots

Captured from the local production preview. Widths are 1280 and 390.

The after shots use an injected mock wallet that never broadcasts. Reject, pending, and confirmed are fixtures (`eth_sendTransaction` is not sent to the network). Contract reads use the real Base Sepolia RPC at `sepolia.base.org`. Nobody signed a transaction.

The before shots are main `c9585ec8` (`Show every Prepare result under its button`), with no wallet injected.

| File stem | What it shows |
| --- | --- |
| `before-*-create-form` | Create a claim, before this phase |
| `after-*-idle-fund` | Idle. Prepare this escrow |
| `after-*-escrow-id-hint` | Escrow ID hint |
| `after-*-dispute-id-hint` | Dispute ID hint |
| `after-*-review-full-payee` | Review with the full payee, duration, and contract |
| `after-*-needs-wallet` | Needs wallet |
| `after-*-wrong-network` | Wrong network |
| `after-*-busy-preparing` | Busy. Preparing |
| `after-*-waiting-wallet` | Waiting for the wallet, with the 5 second hint |
| `after-*-cancelled` | Cancelled in the wallet |
| `after-*-pending` | Pending, including the slow note |
| `after-*-confirmed` | Confirmed, with the new id and the next step |
| `after-*-error` | Error |
| `after-*-amount-over-balance` | Amount over the test ETH balance |
| `after-*-duration-presets` | Duration presets |
