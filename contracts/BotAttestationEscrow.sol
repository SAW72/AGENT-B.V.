// SPDX-License-Identifier: MIT
// Bot-to-bot attestation escrow.
// Holds funds until both counterparties present valid, non-expired, non-denylisted stamps.
// Unaudited. Production-bound Base Sepolia design. Not deployed. Not an illustration.
pragma solidity ^0.8.20;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IDenylist } from "./Denylist.sol";

interface IVault {
    enum Tier {
        None,
        Chat,
        DataTools,
        Financial,
        Critical
    }
    function grantAccess(
        bytes32 botId,
        uint8 requestedPerms
    ) external view returns (bool);
    function operator(
        bytes32 botId
    ) external view returns (address);
    function bots(
        bytes32
    )
        external
        view
        returns (
            bytes32 weightHash,
            bytes32 behaviorSig,
            bytes32 promptHash,
            Tier tier,
            bool active,
            uint256 registeredAt
        );
}

interface IDisputePanel {
    function outcome(
        bytes32 disputeId
    ) external view returns (bool exists, bool resolved, bool upheld, bytes32 subjectHash);

    /// @dev Public getter for `DisputePanel.disputes`. Tuple order is the `Dispute` struct:
    ///      subjectHash, challenger, reason, votesFor, votesAgainst, resolved, upheld, createdAt.
    ///      A dispute exists iff `createdAt != 0`, the same rule `outcome` uses.
    function disputes(
        bytes32 disputeId
    )
        external
        view
        returns (
            bytes32 subjectHash,
            address challenger,
            string memory reason,
            uint256 votesFor,
            uint256 votesAgainst,
            bool resolved,
            bool upheld,
            uint256 createdAt
        );

    /// @notice Open the panel case. `dispute` calls this in the same transaction.
    /// @dev The live `DisputePanel` already has this function. The challenger it stores is
    ///      `msg.sender`, which is this escrow. This interface does not deploy a panel.
    function openDispute(
        bytes32 disputeId,
        bytes32 subjectHash,
        string calldata reason
    ) external;
}

/// @title BotAttestationEscrow
/// @notice Escrows value for a bot-to-bot transaction until both sides verify each other.
/// @dev Who may `release`, and how `dispute` opens a panel case, is specified in
///      `BotAttestationEscrow.spec.md` (same directory). `dispute` opens the case itself.
/// @dev Denylist policy: `governance` is immutable and is CORE_TIMELOCK in production.
///      The deployer cannot be `governance`. `createEscrow` and dependency swaps
///      (`setDenylist`, `setVault`, `setDisputePanel`) run only while `owner() == governance`,
///      which means the timelock has accepted Ownable2Step ownership. Swaps also revert
///      while `lockedValue != 0`, so an owner cannot point `_verifyBot` at an empty
///      registry under open funds. `totalOwed` is intentionally excluded from that gate:
///      ETH already credited for `withdraw` is not an open escrow, and an unclaimed
///      credit must not freeze governance. Invariant: `address(this).balance >= lockedValue + totalOwed`.
///      A credited balance can be collected only by an account that can call `withdraw` or `withdrawTo`:
///      an EOA, an EIP-7702 account, or a wallet/contract with that call. A non-upgradeable contract
///      that cannot call either function strands its own credit. There is no gasless claim yet, so a
///      payee whose ETH balance is zero still needs gas to withdraw.
///      Swaps emit governance events. There is no hot EOA admin.
contract BotAttestationEscrow is Ownable2Step, ReentrancyGuard {
    /// @notice Timelock that must own this contract before funding or dependency swaps.
    /// @dev Production value is CORE_TIMELOCK. A later owner who is not this address
    ///      cannot retarget the denylist; they can transfer ownership back.
    address public immutable governance;

    /// @notice How long after `expiresAt` an unresolved linked case still blocks `refund`.
    /// @dev The payee may `dispute` at `expiresAt`. The panel has this long to vote before
    ///      an unresolved case refunds the payer. `refund` is allowed when
    ///      `block.timestamp >= expiresAt + RULING_GRACE` and the case is still unresolved.
    ///      A resolved ruling does not wait on this clock: upheld pays the payee, and
    ///      an unwind refunds immediately. Not a storage variable.
    uint256 public constant RULING_GRACE = 7 days;

    /// @notice ETH still held for Open or Disputed escrows. Not the raw contract balance.
    uint256 public lockedValue;

    /// @notice Sum of `pendingWithdrawals`. ETH credited by `release` or `refund` and not yet pulled.
    /// @dev Intentionally excluded from `whileUnfunded`. Setters stay locked only while
    ///      `lockedValue != 0` (an escrow is still Open or Disputed). A recipient who never
    ///      calls `withdraw` must not freeze `setDenylist`, `setVault`, or `setDisputePanel`.
    ///      Invariant: `address(this).balance >= lockedValue + totalOwed`.
    uint256 public totalOwed;

    IDenylist public denylist;
    IVault public vault;
    IDisputePanel public disputePanel;

    enum EscrowState {
        Open,
        Released,
        Refunded,
        Disputed
    }

    struct Escrow {
        address payer;
        address payee;
        bytes32 payerBotId;
        bytes32 payeeBotId;
        uint256 amount;
        uint256 createdAt;
        uint256 expiresAt;
        EscrowState state;
        bytes32 disputeId;
        /// @dev The payer or payee who called `dispute`. Not `tx.origin`, and not the panel challenger.
        address party;
    }

    mapping(bytes32 => Escrow) public escrows; // keyed by escrowId
    mapping(bytes32 => bool) public usedEscrowIds; // replay protection

    /// @notice Claimable ETH for `account`. `release` credits `payee`; `refund` credits `payer`.
    /// @dev Public getter is the view. The account pulls it with `withdraw` or `withdrawTo`.
    mapping(address => uint256) public pendingWithdrawals;

    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed payer,
        address indexed payee,
        bytes32 payerBotId,
        bytes32 payeeBotId,
        uint256 amount,
        uint256 expiresAt
    );
    event EscrowReleased(bytes32 indexed escrowId, uint256 amount);
    event EscrowRefunded(bytes32 indexed escrowId, uint256 amount);
    /// @notice `recipient` was credited `amount` to pull later. `isRelease` is true for `release`, false for `refund`.
    /// @dev `EscrowReleased` / `EscrowRefunded` still fire, but they no longer mean ETH was pushed.
    ///      Parameter name is `amount`, matching `EscrowReleased` / `EscrowRefunded`. The topic hash
    ///      depends on types, not the name.
    event Credited(bytes32 indexed escrowId, address indexed recipient, uint256 amount, bool isRelease);
    /// @notice `account` pulled `amount` of their own credit to `to`.
    event Withdrawn(address indexed account, address indexed to, uint256 amount);
    /// @notice `party` is the payer or payee who called `dispute` (`msg.sender`). Not `tx.origin`.
    /// @dev The panel challenger is this escrow. Arbitrators read `party`.
    event EscrowDisputed(bytes32 indexed escrowId, bytes32 disputeId, address party);
    /// @notice Governance record of a denylist swap. `actor` is `governance` after it has accepted ownership.
    event DenylistUpdated(
        address indexed previousDenylist, address indexed newDenylist, address indexed actor, uint256 timestamp
    );
    /// @notice Governance record of a vault swap. Same shape as `DenylistUpdated`.
    /// @dev Constructor initial set uses `previousVault = address(0)`.
    event VaultUpdated(
        address indexed previousVault, address indexed newVault, address indexed actor, uint256 timestamp
    );
    /// @notice Governance record of a dispute-panel swap. Same shape as `DenylistUpdated`.
    /// @dev Constructor initial set uses `previousPanel = address(0)`.
    event DisputePanelUpdated(
        address indexed previousPanel, address indexed newPanel, address indexed actor, uint256 timestamp
    );

    /// @notice No `escrows` row was written for `id`.
    /// @dev `id` is the `bytes32` escrow id. Unset storage is not a valid `Open` escrow.
    error EscrowNotFound(bytes32 id);
    error EscrowNotOpen();
    error EscrowExpired();
    error AttestationFailed(string reason);
    error InvalidParties();
    error Replay();
    error InvalidDispute();
    /// @notice `bytes(reason).length` is above 256. The panel stores the string with no cap.
    error DisputeReasonTooLong();
    /// @dev Selector retained. `dispute` opens the case and does not attach an existing ruling.
    error DisputeAlreadyResolved();
    /// @dev Selector retained. `dispute` opens the case and does not read a pre-existing tally.
    error DisputeVotesCast();
    /// @dev Selector retained. `dispute` opens the case and does not attach one opened earlier.
    error DisputePredatesEscrow();
    /// @dev Selector retained. The panel challenger of a case `dispute` opens is this escrow.
    ///      The caller is stored as `party`.
    error DisputeChallengerNotParty();
    error DisputeAfterExpiry();
    error DisputePending();
    /// @notice A linked dispute is still unresolved after `expiresAt`, and `RULING_GRACE` has not elapsed.
    /// @dev `refund` only. `block.timestamp > expiresAt` and `block.timestamp < expiresAt + RULING_GRACE`.
    ///      At `expiresAt` the in-window check still reverts `DisputePending`. At
    ///      `expiresAt + RULING_GRACE` an unresolved case refunds. A resolved ruling does not use this error.
    error RulingPending();
    /// @notice This caller may not `release` in the current state.
    /// @dev While `Open`, only the payer may release. The payee and every other caller revert
    ///      here, before expiry and before the Vault or denylist are read. While `Disputed`,
    ///      a caller other than the payer or the payee reverts here. A party on a case that
    ///      is not a completed uphold reverts `DisputePending` instead, including during
    ///      `RULING_GRACE`. An upheld case lets either party release.
    error ReleaseNotAuthorized();
    /// @notice `dispute` caller is neither the payer nor the payee.
    error NotParty();
    error ZeroAddress();
    error InvalidGovernance();
    error NotGovernance();
    error FundingBeforeGovernance();
    error DependencyChangeWhileFunded();
    error DenylistUnchanged();
    error VaultUnchanged();
    error DisputePanelUnchanged();
    error WithdrawFailed();

    /// @param _governance CORE_TIMELOCK in production. Must be non-zero and must not be the deployer.
    constructor(
        address _denylist,
        address _vault,
        address _panel,
        address _governance
    ) Ownable(msg.sender) {
        if (_governance == address(0)) revert ZeroAddress();
        if (_governance == msg.sender) revert InvalidGovernance();
        governance = _governance;
        _setDenylist(_denylist);
        _setVault(_vault);
        _setDisputePanel(_panel);
    }

    /// @notice Point `_verifyBot` at a different denylist.
    /// @dev Who: `governance`, and only while that address is the Ownable2Step owner.
    ///      The deployer is owner until `acceptOwnership` and cannot call this.
    ///      An owner who is not `governance` cannot call this either.
    ///      When: only while `lockedValue == 0`. A swap under an open escrow would let
    ///      `release` read a registry that does not list the locked bots.
    ///      `totalOwed` is intentionally not part of this check. Credited ETH is already
    ///      settled and waiting on `withdraw`; including it would let a 1-wei unclaimed
    ///      credit freeze governance the same way a reverting recipient used to.
    ///      The `DenylistUpdated` event (previous, new, caller, timestamp) is the
    ///      governance record. Production has no separate hot EOA admin.
    function setDenylist(
        address _denylist
    ) external onlyGovernance whileUnfunded {
        _setDenylist(_denylist);
    }

    /// @notice Re-point the vault. Same authority and funded-lock as `setDenylist`.
    /// @dev Who: `governance`, and only while that address is the Ownable2Step owner.
    ///      When: only while `lockedValue == 0`. `totalOwed` is intentionally excluded;
    ///      see `setDenylist`.
    ///      `VaultUpdated` records previous, new, caller, and timestamp.
    ///      The same address reverts `VaultUnchanged`.
    function setVault(
        address _vault
    ) external onlyGovernance whileUnfunded {
        _setVault(_vault);
    }

    /// @notice Re-point the dispute panel. Same authority and funded-lock as `setDenylist`.
    /// @dev Who: `governance`, and only while that address is the Ownable2Step owner.
    ///      When: only while `lockedValue == 0`. `totalOwed` is intentionally excluded;
    ///      see `setDenylist`.
    ///      `DisputePanelUpdated` records previous, new, caller, and timestamp.
    ///      The same address reverts `DisputePanelUnchanged`.
    function setDisputePanel(
        address _panel
    ) external onlyGovernance whileUnfunded {
        _setDisputePanel(_panel);
    }

    modifier onlyGovernance() {
        if (msg.sender != governance || owner() != governance) revert NotGovernance();
        _;
    }

    /// @dev Open or disputed escrows only. `totalOwed` is intentionally excluded so a
    ///      credited-but-unclaimed balance cannot lock the owner setters.
    modifier whileUnfunded() {
        if (lockedValue != 0) revert DependencyChangeWhileFunded();
        _;
    }

    function _setDenylist(
        address _denylist
    ) internal {
        if (_denylist == address(0)) revert ZeroAddress();
        address previous = address(denylist);
        if (previous == _denylist) revert DenylistUnchanged();
        denylist = IDenylist(_denylist);
        emit DenylistUpdated(previous, _denylist, msg.sender, block.timestamp);
    }

    function _setVault(
        address _vault
    ) internal {
        if (_vault == address(0)) revert ZeroAddress();
        address previous = address(vault);
        if (previous == _vault) revert VaultUnchanged();
        vault = IVault(_vault);
        emit VaultUpdated(previous, _vault, msg.sender, block.timestamp);
    }

    function _setDisputePanel(
        address _panel
    ) internal {
        if (_panel == address(0)) revert ZeroAddress();
        address previous = address(disputePanel);
        if (previous == _panel) revert DisputePanelUnchanged();
        disputePanel = IDisputePanel(_panel);
        emit DisputePanelUpdated(previous, _panel, msg.sender, block.timestamp);
    }

    /// @notice Create an escrow for a bot-to-bot payment.
    /// @param escrowId Unique id (caller-generated, e.g. hash of intent + nonce).
    /// @param payee Address receiving funds on release. Must be the payee bot's Vault operator.
    /// @param payerBotId On-chain bot id of the paying bot. Caller must be its Vault operator.
    /// @param payeeBotId On-chain bot id of the receiving bot.
    /// @param durationSeconds How long the escrow stays open before expiry.
    function createEscrow(
        bytes32 escrowId,
        address payee,
        bytes32 payerBotId,
        bytes32 payeeBotId,
        uint256 durationSeconds
    ) external payable nonReentrant returns (bytes32) {
        // No funding until CORE_TIMELOCK has accepted. The deployer key must not lock ETH.
        if (owner() != governance) revert FundingBeforeGovernance();
        if (usedEscrowIds[escrowId]) revert Replay();
        if (payee == address(0) || msg.sender == payee) revert InvalidParties();
        if (payerBotId == bytes32(0) || payeeBotId == bytes32(0) || payerBotId == payeeBotId) {
            revert InvalidParties();
        }
        if (msg.value == 0) revert AttestationFailed("zero amount");
        if (durationSeconds == 0 || durationSeconds > 30 days) revert AttestationFailed("bad duration");

        // EOA ↔ botId bind: only the Vault operator may lock or receive under a botId.
        if (vault.operator(payerBotId) != msg.sender) revert InvalidParties();
        if (vault.operator(payeeBotId) != payee) revert InvalidParties();

        // Fail closed at lock time so invalid counterparties cannot trap funds.
        _verifyBot(payerBotId, "payer");
        _verifyBot(payeeBotId, "payee");

        usedEscrowIds[escrowId] = true;
        lockedValue += msg.value;
        uint256 expiresAt = block.timestamp + durationSeconds;
        escrows[escrowId] = Escrow({
            payer: msg.sender,
            payee: payee,
            payerBotId: payerBotId,
            payeeBotId: payeeBotId,
            amount: msg.value,
            createdAt: block.timestamp,
            expiresAt: expiresAt,
            state: EscrowState.Open,
            disputeId: bytes32(0),
            party: address(0)
        });

        emit EscrowCreated(escrowId, msg.sender, payee, payerBotId, payeeBotId, msg.value, expiresAt);
        return escrowId;
    }

    /// @dev An id that was never created has `payer == address(0)`. That word is the existence
    ///      test. Unset storage is otherwise `Open` with `expiresAt == 0` and `amount == 0`, so
    ///      `refund` would treat it as already expired and credit 0 to `address(0)`.
    ///      `createEscrow` rejects `msg.value == 0` and stores `msg.sender` as `payer`, but amount
    ///      is not the test: a created row with a zero amount still has a non-zero payer, and a
    ///      zero amount must not be reported as missing. `usedEscrowIds` is the same creation
    ///      fact in another mapping. `refund` and `dispute` already load `payer`, and an open
    ///      `release` loads it in `_requireBoundOperators`. Reading the replay map as well would
    ///      add a cold SLOAD on every call.
    function _requireEscrow(
        bytes32 escrowId
    ) internal view returns (Escrow storage e) {
        e = escrows[escrowId];
        if (e.payer == address(0)) revert EscrowNotFound(escrowId);
    }

    /// @notice Credit the payee recorded at create time. Does not transfer ETH.
    /// @dev Caller, by state. See `BotAttestationEscrow.spec.md`.
    ///      - `Open`: the payer only. The payee and a stranger revert `ReleaseNotAuthorized`
    ///        before expiry and before the Vault or denylist are read. The payee must not
    ///        credit itself ahead of the payer's `dispute` link.
    ///      - `Disputed`: payer or payee only, and only after the linked case is resolved
    ///        and upheld. A stranger reverts `ReleaseNotAuthorized`. A party reverts
    ///        `DisputePending` until that ruling. An unwind is not a release.
    ///      - `Released` or `Refunded`: `EscrowNotOpen` for every caller.
    ///      Governance is not a release caller. `refund` stays permissionless.
    ///      Open (non-disputed) release fails closed: both bots must still be active in
    ///      the Vault, not denylisted, Financial+ tier, and bound to the operators stored
    ///      on the escrow (`_verifyBot` and `_requireBoundOperators`).
    ///      A disputed escrow can release only if the panel upheld the original deal.
    ///      That upheld path stays open after `expiresAt` and skips re-attestation and
    ///      operator rebinding by design. The panel already ruled the deal stands, and
    ///      `refund` is closed, so a later denylist hit, burn, tier drop, or operator
    ///      rotation must not strand the locked ETH. The credit is `e.payee` from create,
    ///      not whatever address currently operates the payee bot. This function does not
    ///      call the payee. The payee pulls the ETH with `withdraw` or `withdrawTo`. See `withdraw`
    ///      for who can collect that credit and why a zero-ETH payee still needs gas.
    function release(
        bytes32 escrowId
    ) external nonReentrant {
        Escrow storage e = _requireEscrow(escrowId);
        bool panelUpheld = false;
        if (e.state == EscrowState.Disputed) {
            // Party check before the panel read. A stranger does not get a view call.
            if (msg.sender != e.payer && msg.sender != e.payee) revert ReleaseNotAuthorized();
            _requirePanelUpheld(e, escrowId);
            panelUpheld = true;
        } else if (e.state != EscrowState.Open) {
            revert EscrowNotOpen();
        } else if (msg.sender != e.payer) {
            revert ReleaseNotAuthorized();
        }
        // Open escrows expire. An upheld dispute does not: release remains the payee path.
        if (!panelUpheld && block.timestamp > e.expiresAt) revert EscrowExpired();

        // Post-ruling attestation and operator checks can both fail after an uphold
        // while refund is already closed. Credit the create-time payee without re-checking.
        // Open deals still fail closed. No external call: a reverting payee must not roll this back.
        if (!panelUpheld) {
            _requireBoundOperators(e);
            _verifyBot(e.payerBotId, "payer");
            _verifyBot(e.payeeBotId, "payee");
        }

        uint256 amt = e.amount;
        address recipient = e.payee;
        e.state = EscrowState.Released;
        lockedValue -= amt;
        pendingWithdrawals[recipient] += amt;
        totalOwed += amt;
        emit EscrowReleased(escrowId, amt);
        emit Credited(escrowId, recipient, amt, true);
    }

    /// @notice Credit the payer if the escrow expires or the panel rules an unwind. Does not transfer ETH.
    /// @dev `Disputed` alone is not enough — that would let either party unwind unilaterally.
    ///      An upheld panel ruling closes refund permanently, including after `expiresAt`
    ///      and during `RULING_GRACE`. A resolved unwind refunds immediately, including
    ///      inside the window and inside the grace. An unresolved case reverts
    ///      `DisputePending` while `block.timestamp <= expiresAt`, and `RulingPending`
    ///      while `expiresAt < block.timestamp < expiresAt + RULING_GRACE`. At
    ///      `block.timestamp >= expiresAt + RULING_GRACE` an unresolved case refunds.
    ///      That grace is why the payee must `dispute` before expiry: while `Open`, only
    ///      the payer can `release`, so a silent payee is refunded at `expiresAt`.
    ///      Credits `e.payer`. Does not call the payer. The payer collects with `withdraw`
    ///      or `withdrawTo`. See `withdraw` for the recipient rule.
    ///      After `expiresAt`, `Disputed` checks in this order: upheld → `DisputePending`;
    ///      else unresolved and still inside `RULING_GRACE` → `RulingPending`; else refund.
    ///      The in-window order is unchanged: upheld → `DisputePending`, then
    ///      `InvalidDispute`, then `DisputePending` if the case is not a completed unwind.
    function refund(
        bytes32 escrowId
    ) external nonReentrant {
        Escrow storage e = _requireEscrow(escrowId);
        if (e.state == EscrowState.Open) {
            require(block.timestamp > e.expiresAt, "not expired");
        } else if (e.state == EscrowState.Disputed) {
            // Upheld means the original deal stands. Do not let expiry or grace flip that into a payer refund.
            if (_panelUpheld(e, escrowId)) revert DisputePending();
            if (block.timestamp <= e.expiresAt) {
                _requirePanelUnwind(e, escrowId);
            } else if (_panelUnresolved(e, escrowId) && block.timestamp < e.expiresAt + RULING_GRACE) {
                // Filed at expiresAt. The panel has RULING_GRACE before an unresolved case refunds.
                revert RulingPending();
            }
        } else {
            revert EscrowNotOpen();
        }

        uint256 amt = e.amount;
        address recipient = e.payer;
        e.state = EscrowState.Refunded;
        lockedValue -= amt;
        pendingWithdrawals[recipient] += amt;
        totalOwed += amt;
        emit EscrowRefunded(escrowId, amt);
        emit Credited(escrowId, recipient, amt, false);
    }

    /// @notice Pull the caller's full credit to themselves.
    /// @dev The caller must accept ETH. A rejecting caller reverts `WithdrawFailed` and keeps the credit.
    ///      Recipients must be EOAs, EIP-7702 accounts, or wallets/contracts able to call `withdraw` or
    ///      `withdrawTo`. A non-upgradeable contract that cannot make that call strands its own credit.
    ///      There is no gasless claim yet, so a payee with 0 ETH needs gas to submit this transaction.
    function withdraw() external nonReentrant {
        _withdraw(msg.sender, msg.sender);
    }

    /// @notice Pull the caller's full credit to `to`.
    /// @dev For a caller whose own address rejects ETH. `to` must accept the transfer.
    ///      The caller can spend only their own `pendingWithdrawals` balance, and only if that caller
    ///      can submit the transaction: an EOA, an EIP-7702 account, or a wallet/contract with this call.
    ///      A non-upgradeable contract that cannot call `withdraw` or `withdrawTo` strands its own credit.
    ///      There is no gasless claim yet, so a payee with 0 ETH needs gas to submit this transaction.
    /// @param to Destination. Must be non-zero.
    function withdrawTo(
        address to
    ) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        _withdraw(msg.sender, to);
    }

    /// @dev Checks-effects-interactions. The ETH send uses `call` with an empty returndata
    ///      region so a recipient cannot force the caller to copy a returndata bomb.
    function _withdraw(
        address account,
        address to
    ) internal {
        uint256 amt = pendingWithdrawals[account];
        // Caller can pull only their own credit, and only when it is non-zero.
        require(amt > 0, "nothing to withdraw");
        pendingWithdrawals[account] = 0;
        totalOwed -= amt;

        bool ok;
        assembly {
            // gas, to, value, in-offset, in-size, out-offset, out-size.
            // out-size 0: do not copy returndata into memory.
            ok := call(gas(), to, amt, 0, 0, 0, 0)
        }
        if (!ok) revert WithdrawFailed();
        emit Withdrawn(account, to, amt);
    }

    /// @notice Flag an escrow for dispute and open the panel case in this transaction.
    /// @dev Does not authorize a refund. There is no path that only links an existing case.
    ///      Checks, in order, after `EscrowNotFound`: the caller is the payer or the payee;
    ///      the escrow is `Open`; `disputeId` is not zero; `disputeId` is not `escrowId`,
    ///      `panelSubject(escrowId, createdAt)`, or `keccak256(abi.encode(escrowId, createdAt))`;
    ///      `bytes(reason).length` is 256 or less; `block.timestamp` is at or before `expiresAt`.
    ///      Effects are stored before the external call: state `Disputed`, `disputeId`, and
    ///      `party = msg.sender` (not `tx.origin`). Then `openDispute(disputeId, subject, reason)`
    ///      with `subject = panelSubject(escrowId, createdAt)`. A revert from the panel reverts
    ///      this transaction and leaves the escrow `Open`. The panel challenger is `address(this)`,
    ///      and only for the case this call just opened. Arbitrators read `party`.
    function dispute(
        bytes32 escrowId,
        bytes32 disputeId,
        string calldata reason
    ) external nonReentrant {
        Escrow storage e = _requireEscrow(escrowId);
        if (msg.sender != e.payer && msg.sender != e.payee) revert NotParty();
        if (e.state != EscrowState.Open) revert EscrowNotOpen();
        if (disputeId == bytes32(0)) revert InvalidDispute();
        bytes32 subject = panelSubject(escrowId, e.createdAt);
        if (disputeId == escrowId || disputeId == subject || disputeId == keccak256(abi.encode(escrowId, e.createdAt)))
        {
            revert InvalidDispute();
        }
        if (bytes(reason).length > 256) revert DisputeReasonTooLong();
        if (block.timestamp > e.expiresAt) revert DisputeAfterExpiry();

        e.state = EscrowState.Disputed;
        e.disputeId = disputeId;
        e.party = msg.sender;
        emit EscrowDisputed(escrowId, disputeId, msg.sender);

        disputePanel.openDispute(disputeId, subject, reason);
    }

    /// @notice Subject a panel case must use for this escrow row.
    /// @dev `keccak256(abi.encode(block.chainid, address(this), escrowId, createdAt))`.
    ///      `createdAt` is the timestamp `createEscrow` stored. Two deployments that share
    ///      a panel, an `escrowId`, and a `createdAt` still hash apart, because the
    ///      escrow address is inside the preimage. `dispute` passes this exact value to
    ///      `openDispute`. Ruling checks require the same hash.
    function panelSubject(
        bytes32 escrowId,
        uint256 createdAt
    ) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), escrowId, createdAt));
    }

    function _requireBoundOperators(
        Escrow storage e
    ) internal view {
        if (vault.operator(e.payerBotId) != e.payer) revert InvalidParties();
        if (vault.operator(e.payeeBotId) != e.payee) revert InvalidParties();
    }

    /// @dev True only when this escrow's panel case exists, matches, is resolved, and is upheld.
    function _panelUpheld(
        Escrow storage e,
        bytes32 escrowId
    ) internal view returns (bool) {
        (bool exists, bool resolved, bool upheld, bytes32 subject) = disputePanel.outcome(e.disputeId);
        return exists && subject == panelSubject(escrowId, e.createdAt) && resolved && upheld;
    }

    /// @dev True when the linked case exists, the subject matches this row, and the panel has not resolved it.
    ///      A missing id or a subject mismatch is not "unresolved": after `expiresAt` those still take the
    ///      expiry backstop, the same as before `RULING_GRACE`.
    function _panelUnresolved(
        Escrow storage e,
        bytes32 escrowId
    ) internal view returns (bool) {
        (bool exists, bool resolved,, bytes32 subject) = disputePanel.outcome(e.disputeId);
        return exists && subject == panelSubject(escrowId, e.createdAt) && !resolved;
    }

    function _requirePanelUnwind(
        Escrow storage e,
        bytes32 escrowId
    ) internal view {
        (bool exists, bool resolved, bool upheld, bytes32 subject) = disputePanel.outcome(e.disputeId);
        if (!exists || subject != panelSubject(escrowId, e.createdAt)) revert InvalidDispute();
        if (!resolved) revert DisputePending();
        if (upheld) revert DisputePending();
    }

    function _requirePanelUpheld(
        Escrow storage e,
        bytes32 escrowId
    ) internal view {
        (bool exists, bool resolved, bool upheld, bytes32 subject) = disputePanel.outcome(e.disputeId);
        if (!exists || subject != panelSubject(escrowId, e.createdAt)) revert InvalidDispute();
        if (!resolved || !upheld) revert DisputePending();
    }

    function _verifyBot(
        bytes32 botId,
        string memory role
    ) internal view {
        (bytes32 weightHash, bytes32 behaviorSig, bytes32 promptHash, IVault.Tier tier, bool active,) =
            vault.bots(botId);
        if (!active) revert AttestationFailed(string.concat(role, " bot inactive"));
        if (uint8(tier) < uint8(IVault.Tier.Financial)) {
            revert AttestationFailed(string.concat(role, " bot below Financial tier"));
        }
        // Vault access path (active + Financial+ perm cap). Catch string reverts
        // so callers always see AttestationFailed.
        try vault.grantAccess(botId, uint8(IVault.Tier.Financial)) returns (bool allowed) {
            if (!allowed) {
                revert AttestationFailed(string.concat(role, " bot access denied"));
            }
        } catch {
            revert AttestationFailed(string.concat(role, " bot access denied"));
        }
        // PromptBlock, SignatureBlock, and ExactBlock are hard blocks. None is the only pass.
        IDenylist.MatchLevel level = denylist.check(weightHash, behaviorSig, promptHash);
        if (level != IDenylist.MatchLevel.None) {
            revert AttestationFailed(string.concat(role, " bot denylisted"));
        }
    }
}
