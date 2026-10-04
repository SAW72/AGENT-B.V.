// SPDX-License-Identifier: MIT
// Prod smoke P2-B: refund/release/dispute of an id that was never created.
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { BotAttestationEscrow } from "../contracts/BotAttestationEscrow.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { DisputePanel } from "../contracts/DisputePanel.sol";
import { Vault } from "../contracts/Vault.sol";

/// @notice Regression for the Base Sepolia finding that `refund` of a never-created id succeeds.
contract BotAttestationEscrowNotFoundTest is Test {
    /// @dev `forge inspect BotAttestationEscrow storage-layout`. ReentrancyGuard keeps
    ///      its status in an ERC-7201 slot, so it is not in this sequence.
    uint256 internal constant ESCROWS_SLOT = 7;
    uint256 internal constant USED_ESCROW_IDS_SLOT = 8;

    Denylist denylist;
    Vault vault;
    DisputePanel panel;
    BotAttestationEscrow escrow;

    address governance;
    address payer;
    address payee;

    bytes32 payerBot = keccak256("payer-bot");
    bytes32 payeeBot = keccak256("payee-bot");

    function setUp() public {
        denylist = new Denylist();
        vault = new Vault(address(denylist));
        panel = new DisputePanel();
        governance = makeAddr("governance");
        escrow = new BotAttestationEscrow(address(denylist), address(vault), address(panel), governance);
        escrow.transferOwnership(governance);
        vm.prank(governance);
        escrow.acceptOwnership();

        payer = makeAddr("payer");
        payee = makeAddr("payee");
        vault.register(payerBot, keccak256("w1"), keccak256("b1"), keccak256("p1"), Vault.Tier.Financial, payer);
        vault.register(payeeBot, keccak256("w2"), keccak256("b2"), keccak256("p2"), Vault.Tier.Financial, payee);
        vm.deal(payer, 10 ether);
    }

    /// @dev Prod smoke P2-B. Unset storage is `Open` with expiry 0, so `refund` used to succeed
    ///      and credit 0 to `address(0)`.
    function test_prodSmoke_P2B_refundNeverCreatedIdRevertsEscrowNotFound() public {
        bytes32 id = keccak256("prod-smoke-p2b-never-created");
        _assertRefundMissing(bytes32(0));
        _assertRefundMissing(id);
    }

    function test_releaseNeverCreatedIdRevertsEscrowNotFound() public {
        bytes32 id = keccak256("never-created-release");
        _assertReleaseMissing(id);

        // At timestamp 0, expiry 0 is not in the past, so the old `Open` read would not be
        // `EscrowExpired`. The id is still missing.
        vm.warp(0);
        _assertReleaseMissing(keccak256("never-created-release-t0"));
    }

    function test_disputeNeverCreatedIdRevertsEscrowNotFound() public {
        bytes32 id = keccak256("never-created-dispute");
        vm.expectRevert(abi.encodeWithSelector(BotAttestationEscrow.EscrowNotFound.selector, id));
        escrow.dispute(id, keccak256("panel-case"), "attestation stale");
    }

    function testFuzz_neverCreatedEscrowIdRevertsEscrowNotFound(
        bytes32 id
    ) public {
        vm.expectRevert(abi.encodeWithSelector(BotAttestationEscrow.EscrowNotFound.selector, id));
        escrow.refund(id);
        vm.expectRevert(abi.encodeWithSelector(BotAttestationEscrow.EscrowNotFound.selector, id));
        escrow.release(id);
        vm.expectRevert(abi.encodeWithSelector(BotAttestationEscrow.EscrowNotFound.selector, id));
        escrow.dispute(id, keccak256("panel-case"), "attestation stale");
    }

    /// @dev A row with a real payer and `usedEscrowIds` set, but amount 0, is not missing.
    ///      `createEscrow` rejects zero value; this write is the storage shape that must not
    ///      be treated as unset just because `amount` is 0.
    function test_zeroAmountCreatedEscrowIsNotMissing() public {
        bytes32 id = keccak256("zero-amount-created");
        // Struct fields are unpacked: payer +0, payee +1, amount +4, expiresAt +6.
        bytes32 row = keccak256(abi.encode(id, ESCROWS_SLOT));
        vm.store(address(escrow), row, bytes32(uint256(uint160(payer))));
        vm.store(address(escrow), bytes32(uint256(row) + 1), bytes32(uint256(uint160(payee))));
        vm.store(address(escrow), bytes32(uint256(row) + 6), bytes32(block.timestamp + 1000));
        vm.store(address(escrow), keccak256(abi.encode(id, USED_ESCROW_IDS_SLOT)), bytes32(uint256(1)));

        (address storedPayer,,,, uint256 amount,,,,,) = _row(id);
        assertEq(storedPayer, payer);
        assertEq(amount, 0);
        assertTrue(escrow.usedEscrowIds(id));

        vm.expectRevert(bytes("not expired"));
        escrow.refund(id);

        // The row exists. A party hits the operator check, not `EscrowNotFound`.
        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.InvalidParties.selector);
        escrow.release(id);

        vm.prank(payer);
        vm.expectRevert(bytes("panel not seated"));
        escrow.dispute(id, keccak256("zero-amount-case"), "attestation stale");
    }

    /// @dev A real open escrow still takes the expiry path, not `EscrowNotFound`.
    function test_openEscrowRefundStillNotExpired() public {
        bytes32 id = keccak256("real-open");
        vm.prank(payer);
        escrow.createEscrow{ value: 1 ether }(id, payee, payerBot, payeeBot, 3600);
        vm.expectRevert(bytes("not expired"));
        escrow.refund(id);
    }

    function _assertRefundMissing(
        bytes32 id
    ) internal {
        uint256 lockedBefore = escrow.lockedValue();
        uint256 owedBefore = escrow.totalOwed();
        uint256 dustBefore = escrow.pendingWithdrawals(address(0));

        vm.expectRevert(abi.encodeWithSelector(BotAttestationEscrow.EscrowNotFound.selector, id));
        escrow.refund(id);

        assertEq(escrow.lockedValue(), lockedBefore);
        assertEq(escrow.totalOwed(), owedBefore);
        assertEq(escrow.pendingWithdrawals(address(0)), dustBefore);
        assertFalse(escrow.usedEscrowIds(id));
        (address storedPayer,,,,,,, BotAttestationEscrow.EscrowState state,,) = _row(id);
        assertEq(storedPayer, address(0));
        assertEq(uint8(state), uint8(BotAttestationEscrow.EscrowState.Open));
    }

    function _assertReleaseMissing(
        bytes32 id
    ) internal {
        vm.expectRevert(abi.encodeWithSelector(BotAttestationEscrow.EscrowNotFound.selector, id));
        escrow.release(id);
        assertEq(escrow.pendingWithdrawals(address(0)), 0);
        assertFalse(escrow.usedEscrowIds(id));
    }

    function _row(
        bytes32 id
    )
        internal
        view
        returns (
            address storedPayer,
            address storedPayee,
            bytes32 storedPayerBot,
            bytes32 storedPayeeBot,
            uint256 amount,
            uint256 createdAt,
            uint256 expiresAt,
            BotAttestationEscrow.EscrowState state,
            bytes32 disputeId,
            address party
        )
    {
        return escrow.escrows(id);
    }
}
