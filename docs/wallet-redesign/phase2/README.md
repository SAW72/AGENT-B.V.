# Phase 2 screenshots

Captured from the local production preview (`vite preview`) served under `/app/`. Widths are 1280 and 390, plus the connected header at 320.

The first-run, task-picker, fund step, fund review, release input, and 390 chip-row shots use a mock wallet. It reports an address and a chain id, and it rejects signing. The carried-escrow shot uses no wallet. No key is loaded. The faucet link in those shots is the official Base docs page, `https://docs.base.org/get-started/get-funds`.

Shots that were not replaced in the walkthrough reshoot use a fixture wallet. Those task and form shots connect `0x5D467FA00eC0E92044f779e495a17db66c5964aa`. Fund shots that reach review connect the payer operator `0x6dBe4B1c56494Ee00d6f97FFE9f853F42299D6Ac`. `eth_sendTransaction` is never forwarded to the network. Contract reads, balances, arbitrator seating, escrow state, and receipts use the real Base Sepolia RPC at `sepolia.base.org`. Nobody signed a transaction.

Fund waiting, cancelled, pending, and confirmed use payee `0x6C756dacfEcEeA12D5D39536d2eCC175f18bc5A4` and the registered Vault bots (payer `0x2c2859b9e712890799696d217e9fe2eec1151822ed1b7168785b38991dc42637`, payee `0xc62c848cf38434b66945ed12b266365ef9390b0281b0ca6bc20ba7ab46a06d2f`). A real `createEscrow` eth_call to escrow `0x3d660502D75f1e97b08c110255921b437A3C4C42` returns the fresh escrow id, and eth_estimateGas for that same call is 288132. The only mocked method is `eth_sendTransaction`: it hangs, returns wallet error 4001, returns a hash that is not on Base Sepolia, or returns Spencer's existing tx `0xed74e63fe193b6c919e872788497d8ae80e3e9e2b7b5e098c47c4a228f837043`. That receipt is read live and funded escrow `0x00228e1f9dc268aedcd8a4b7e47672da25ab81695026faf50836a57a18806e17`, which is not the fresh id on the form (`0x501158350b97069742427229c2dc3f1b23223452805301ce2fee53e776a05814`). Nothing was broadcast.

An earlier `InvalidParties` revert used unregistered bot ids (`0xab…` and `0xcd…`) with `from` set to the deployer, who is not the payer bot's operator. Those two test bots are registered. The payer bot's operator is `0x6dBe…D6Ac`.

Release, refund, and dispute input shots show the live read. Opening review from the address bar (`?step=2`) lands on step 1 with the id filled and nothing prepared or sent. Vote stays disabled because the connected wallet is not a seated arbitrator. Withdraw shows a live credit of zero.

The pending shot returns a hash that is not on Base Sepolia; the real receipt read stays pending inside the grace window. The unreadable shot forces `eth_getTransactionReceipt` for one hash to a transport error.

Before shots are main `74f09b79` (Phase 1, PR #73).

The connected header at 320px measures 48px tall, on two rows: the Agent-BV name, then the testnet pill and the compact wallet chip.

| File stem | What it shows |
| --- | --- |
| `before-*-home` | Phase 1 long page, before guided flows |
| `before-320-header` | Phase 1 header at 320px with a wallet connected |
| `after-*-first-run-disconnected` | Start here, no wallet. Current step is Connect your wallet |
| `after-*-first-run-wrong-network` | Start here on the wrong chain. Current step is Switch to Base Sepolia |
| `after-*-first-run-ready` | Start here on Base Sepolia. Current step is Fill in the escrow, with the faucet link |
| `after-*-task-picker` | Task picker under the walkthrough, wallet on Base Sepolia |
| `after-390-chip-row` | Fund step 1 chip row at 390. Four named chips, wrapped, none clipped |
| `after-*-carried-escrow` | `/app/?escrow=` then Release. The escrow id is filled. Nothing is prepared or sent |
| `after-*-fund-step1` | Fund, escrow id and payee |
| `after-*-fund-step2` | Fund, bot identifiers |
| `after-*-fund-step3` | Fund, amount and time window |
| `after-*-fund-review` | Fund review, full escrow id with Copy, nothing sent |
| `after-*-release-input` | Release input, live read, action unavailable |
| `after-*-release-review` | `/app/release?escrow=…&step=2` lands on step 1, id filled, nothing prepared |
| `after-*-refund-input` | Refund input, live read, action unavailable |
| `after-*-refund-review` | `/app/refund?escrow=…&step=2` lands on step 1, id filled, nothing prepared |
| `after-*-dispute-input` | Dispute input, live subject read |
| `after-*-dispute-review` | `/app/dispute?escrow=…&step=2` lands on step 1, id filled, nothing prepared |
| `after-*-vote-input` | Vote visible and disabled for a non-arbitrator |
| `after-*-vote-review` | `/app/vote?dispute=…&step=2` lands on step 1, id filled, nothing prepared |
| `after-*-withdraw-input` | Withdraw input, live credit read |
| `after-*-withdraw-review` | `/app/withdraw?step=2` lands on step 1, nothing prepared |
| `after-*-fund-waiting` | Confirm in MetaMask, with the popup hint |
| `after-*-fund-cancelled` | Cancelled in the fixture wallet (4001) |
| `after-*-fund-pending` | Waiting for Base Sepolia |
| `after-*-pending-strip` | Pending transactions strip, including Copy on the escrow id |
| `after-*-fund-confirmed` | One confirmed card and one Next to `/app/release`. Receipt is Spencer's tx; the form id is the fresh simulation id |
| `after-*-receipt-unreadable` | Receipt read forced to error |
| `after-*-l8-future-record` | Future-dated record keeps the hash until Try again anyway |
| `after-320-header` | Connected header at 320px |
