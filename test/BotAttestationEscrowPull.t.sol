// SPDX-License-Identifier: MIT
// Regression for SCA Finding 1 (push-payment DoS). Ported from the scratch PoC
// that failed closed on a reverting recipient. These tests must pass: release
// and refund credit a pull balance, so a rejecting account cannot freeze
// lockedValue or the owner setters.
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { console } from "forge-std/console.sol";
import { StdUtils } from "forge-std/StdUtils.sol";
import { Vm } from "forge-std/Vm.sol";
import { BotAttestationEscrow } from "../contracts/BotAttestationEscrow.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";
import { DisputePanel } from "../contracts/DisputePanel.sol";

contract RejectETH {
    receive() external payable {
        revert("no eth");
    }
}

/// @dev Contract operator that creates escrows and toggles ETH acceptance.
contract TogglePayer {
    bool public accept = true;

    function setAccept(
        bool a
    ) external {
        accept = a;
    }

    function create(
        BotAttestationEscrow e,
        bytes32 id,
        address payee,
        bytes32 a,
        bytes32 b,
        uint256 d
    ) external payable {
        e.createEscrow{ value: msg.value }(id, payee, a, b, d);
    }

    function openAndLink(
        BotAttestationEscrow e,
        bytes32 id,
        bytes32 did
    ) external {
        e.dispute(id, did, "grief");
    }

    function pullTo(
        BotAttestationEscrow e,
        address to
    ) external {
        e.withdrawTo(to);
    }

    receive() external payable {
        require(accept, "no eth");
    }
}

contract ReturnBomb {
    receive() external payable {
        assembly {
            // 200KB returndata. A copying `call` forces the caller to expand memory.
            return(0, 200000)
        }
    }
}

/// @dev On `withdraw`, reenters withdraw / release / refund / createEscrow.
contract WithdrawReenter {
    BotAttestationEscrow public escrow;
    bytes32 public releaseId;
    bytes32 public refundId;
    bytes32 public createId;
    address public otherPayee;
    bytes32 public payerBot;
    bytes32 public payeeBot;
    bool public entered;
    bytes public withdrawErr;
    bytes public releaseErr;
    bytes public refundErr;
    bytes public createErr;

    constructor(
        BotAttestationEscrow _escrow
    ) {
        escrow = _escrow;
    }

    function configure(
        bytes32 _releaseId,
        bytes32 _refundId,
        bytes32 _createId,
        address _otherPayee,
        bytes32 _payerBot,
        bytes32 _payeeBot
    ) external {
        releaseId = _releaseId;
        refundId = _refundId;
        createId = _createId;
        otherPayee = _otherPayee;
        payerBot = _payerBot;
        payeeBot = _payeeBot;
    }

    function pull() external {
        escrow.withdraw();
    }

    function createAfter(
        uint256 value
    ) external {
        escrow.createEscrow{ value: value }(createId, otherPayee, payerBot, payeeBot, 1 hours);
    }

    receive() external payable {
        if (entered) return;
        entered = true;
        try escrow.withdraw() { }
        catch (bytes memory err) {
            withdrawErr = err;
        }
        try escrow.release(releaseId) { }
        catch (bytes memory err) {
            releaseErr = err;
        }
        try escrow.refund(refundId) { }
        catch (bytes memory err) {
            refundErr = err;
        }
        try escrow.createEscrow{ value: msg.value }(createId, otherPayee, payerBot, payeeBot, 1 hours) { }
        catch (bytes memory err) {
            createErr = err;
        }
    }
}

error ReentrancyGuardReentrantCall();

contract BotAttestationEscrowPullTest is Test {
    event EscrowReleased(bytes32 indexed escrowId, uint256 amount);
    event EscrowRefunded(bytes32 indexed escrowId, uint256 amount);
    event Credited(bytes32 indexed escrowId, address indexed recipient, uint256 amount, bool isRelease);
    event Withdrawn(address indexed account, address indexed to, uint256 amount);

    Denylist denylist;
    Vault vault;
    DisputePanel panel;
    BotAttestationEscrow escrow;

    address governance = makeAddr("governance");
    address payer = makeAddr("payer");
    address payee = makeAddr("payee");
    address arb1 = makeAddr("arb1");
    address arb2 = makeAddr("arb2");
    address arb3 = makeAddr("arb3");
    bytes32 payerBot = keccak256("payer-bot");
    bytes32 payeeBot = keccak256("payee-bot");

    function setUp() public {
        denylist = new Denylist();
        vault = new Vault(address(denylist));
        panel = new DisputePanel();
        escrow = new BotAttestationEscrow(address(denylist), address(vault), address(panel), governance);
        escrow.transferOwnership(governance);
        vm.prank(governance);
        escrow.acceptOwnership();
        panel.setArbitrator(arb1, true);
        panel.setArbitrator(arb2, true);
        panel.setArbitrator(arb3, true);
        vault.register(payerBot, keccak256("w1"), keccak256("b1"), keccak256("p1"), Vault.Tier.Financial, payer);
        vault.register(payeeBot, keccak256("w2"), keccak256("b2"), keccak256("p2"), Vault.Tier.Financial, payee);
        vm.deal(payer, 100 ether);
    }

    function _create(
        bytes32 id,
        uint256 amt,
        uint256 dur
    ) internal {
        vm.prank(payer);
        escrow.createEscrow{ value: amt }(id, payee, payerBot, payeeBot, dur);
    }

    function _state(
        bytes32 id
    ) internal view returns (BotAttestationEscrow.EscrowState s) {
        (,,,,,,, s,,) = escrow.escrows(id);
    }

    function _assertFundedGate() internal {
        vm.startPrank(governance);
        vm.expectRevert(BotAttestationEscrow.DependencyChangeWhileFunded.selector);
        escrow.setDenylist(address(0xdead));
        vm.expectRevert(BotAttestationEscrow.DependencyChangeWhileFunded.selector);
        escrow.setVault(address(0xbeef));
        vm.expectRevert(BotAttestationEscrow.DependencyChangeWhileFunded.selector);
        escrow.setDisputePanel(address(0xcafe));
        vm.stopPrank();
    }

    function _assertSettersUnlocked() internal {
        assertEq(escrow.lockedValue(), 0);
        assertGt(escrow.totalOwed(), 0);
        Denylist d2 = new Denylist();
        Vault v2 = new Vault(address(d2));
        DisputePanel p2 = new DisputePanel();
        vm.startPrank(governance);
        escrow.setDenylist(address(d2));
        escrow.setVault(address(v2));
        escrow.setDisputePanel(address(p2));
        vm.stopPrank();
        assertEq(address(escrow.denylist()), address(d2));
        assertEq(address(escrow.vault()), address(v2));
        assertEq(address(escrow.disputePanel()), address(p2));
    }

    function _rule(
        bytes32 did,
        bool uphold
    ) internal {
        vm.prank(arb1);
        panel.vote(did, uphold);
        vm.prank(arb2);
        panel.vote(did, uphold);
        vm.prank(arb3);
        panel.vote(did, false);
    }

    function _assertSolvent() internal view {
        assertGe(address(escrow).balance, escrow.lockedValue() + escrow.totalOwed());
    }

    /// @dev Open `release` is the payer. These tests call as the payer.
    function _release(
        bytes32 id
    ) internal {
        vm.prank(payer);
        escrow.release(id);
    }

    /// @notice PoC 1: rejecting payee on an open release is credited. Setters unlock before withdraw.
    function test_rejectingPayee_openReleaseCreditsAndUnlocks() public {
        bytes32 id = keccak256("d1");
        _create(id, 1 ether, 1 hours);
        _assertFundedGate();
        vm.etch(payee, type(RejectETH).runtimeCode);

        _release(id);

        assertEq(uint8(_state(id)), uint8(BotAttestationEscrow.EscrowState.Released));
        assertEq(escrow.lockedValue(), 0);
        assertEq(escrow.pendingWithdrawals(payee), 1 ether);
        assertEq(escrow.totalOwed(), 1 ether);
        assertEq(payee.balance, 0);
        _assertSolvent();
        _assertSettersUnlocked();

        vm.prank(payee);
        vm.expectRevert(BotAttestationEscrow.WithdrawFailed.selector);
        escrow.withdraw();
        assertEq(escrow.pendingWithdrawals(payee), 1 ether);
    }

    /// @notice PoC 2: rejecting payer past expiry is credited. lockedValue returns to 0 and setters unlock.
    function test_rejectingPayer_expiredRefundCreditsAndUnlocks() public {
        bytes32 id = keccak256("d2");
        _create(id, 1 wei, 1 hours);
        vm.etch(payer, type(RejectETH).runtimeCode);
        vm.warp(block.timestamp + 1 hours + 1);

        vm.expectRevert(BotAttestationEscrow.EscrowExpired.selector);
        _release(id);
        _assertFundedGate();

        escrow.refund(id);

        assertEq(uint8(_state(id)), uint8(BotAttestationEscrow.EscrowState.Refunded));
        assertEq(escrow.lockedValue(), 0);
        assertEq(escrow.pendingWithdrawals(payer), 1 wei);
        assertEq(escrow.totalOwed(), 1 wei);
        assertEq(address(escrow).balance, 1 wei);
        _assertSolvent();

        vm.warp(block.timestamp + 3650 days);
        vm.expectRevert(BotAttestationEscrow.EscrowNotOpen.selector);
        escrow.release(id);
        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.EscrowNotOpen.selector);
        escrow.dispute(id, keccak256("late"), "attestation stale");

        _assertSettersUnlocked();
    }

    /// @notice PoC 2b: payee burned blocks release; expiry still credits the rejecting payer.
    function test_rejectingPayer_payeeBurned_refundCreditsAndUnlocks() public {
        bytes32 id = keccak256("d2b");
        _create(id, 1 ether, 1 hours);
        vm.etch(payer, type(RejectETH).runtimeCode);
        vault.burn(payeeBot);

        vm.expectRevert(abi.encodeWithSelector(BotAttestationEscrow.AttestationFailed.selector, "payee bot inactive"));
        _release(id);
        _assertFundedGate();

        vm.warp(block.timestamp + 1 hours + 1);
        escrow.refund(id);

        assertEq(escrow.lockedValue(), 0);
        assertEq(escrow.pendingWithdrawals(payer), 1 ether);
        assertEq(escrow.totalOwed(), 1 ether);
        _assertSolvent();
        _assertSettersUnlocked();
    }

    /// @notice PoC 3: upheld dispute + rejecting payee credits the payee. Refund stays closed (H-1).
    function test_upheld_rejectingPayee_releaseCreditsAndUnlocks() public {
        bytes32 id = keccak256("d3");
        bytes32 did = keccak256("did3");
        _create(id, 1 ether, 1 hours);
        vm.prank(payer);
        escrow.dispute(id, did, "r");
        _rule(did, true);
        vm.etch(payee, type(RejectETH).runtimeCode);
        // H-1: upheld still closes refund, including after expiry, before the credit lands.
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(BotAttestationEscrow.DisputePending.selector);
        escrow.refund(id);

        _release(id);

        assertEq(escrow.lockedValue(), 0);
        assertEq(escrow.pendingWithdrawals(payee), 1 ether);
        assertEq(uint8(_state(id)), uint8(BotAttestationEscrow.EscrowState.Released));
        vm.expectRevert(BotAttestationEscrow.EscrowNotOpen.selector);
        escrow.refund(id);
        vm.expectRevert(BotAttestationEscrow.EscrowNotOpen.selector);
        escrow.release(id);
        _assertSolvent();
        _assertSettersUnlocked();
    }

    /// @notice PoC 4: panel unwind + rejecting payer credits the payer. Release stays closed.
    function test_unwind_rejectingPayer_refundCreditsAndUnlocks() public {
        bytes32 id = keccak256("d4");
        bytes32 did = keccak256("did4");
        _create(id, 1 ether, 1 hours);
        vm.prank(payer);
        escrow.dispute(id, did, "r");
        _rule(did, false);
        vm.etch(payer, type(RejectETH).runtimeCode);
        // Unwind is not an upheld deal. Release stays closed until refund credits the payer.
        vm.expectRevert(BotAttestationEscrow.DisputePending.selector);
        _release(id);

        escrow.refund(id);

        assertEq(escrow.lockedValue(), 0);
        assertEq(escrow.pendingWithdrawals(payer), 1 ether);
        assertEq(uint8(_state(id)), uint8(BotAttestationEscrow.EscrowState.Refunded));
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(BotAttestationEscrow.EscrowNotOpen.selector);
        escrow.refund(id);
        vm.expectRevert(BotAttestationEscrow.EscrowNotOpen.selector);
        escrow.release(id);
        _assertSolvent();
        _assertSettersUnlocked();
    }

    /// @notice PoC 5: 1-wei grief no longer locks setters. Refund credits the rejecting payer.
    function test_oneWeiGrief_noLongerLocksSetters() public {
        TogglePayer g = new TogglePayer();
        vault.setOperator(payerBot, address(g));
        bytes32 id = keccak256("d5");
        bytes32 did = keccak256("did5");
        g.create{ value: 1 wei }(escrow, id, payee, payerBot, payeeBot, 1 hours);
        vm.warp(block.timestamp + 1 hours);
        g.openAndLink(escrow, id, did);
        g.setAccept(false);
        // Linked at expiresAt. An unresolved case refunds at expiresAt + RULING_GRACE, not one second later.
        vm.warp(block.timestamp + escrow.RULING_GRACE());

        _assertFundedGate();
        vm.prank(payee);
        vm.expectRevert(BotAttestationEscrow.DisputePending.selector);
        escrow.release(id);

        escrow.refund(id);

        assertEq(escrow.lockedValue(), 0);
        assertEq(escrow.totalOwed(), 1);
        assertEq(escrow.pendingWithdrawals(address(g)), 1);
        assertEq(uint8(_state(id)), uint8(BotAttestationEscrow.EscrowState.Refunded));
        _assertSolvent();
        _assertSettersUnlocked();
    }

    /// @notice PoC 6: a 200KB returndata recipient does not force a second memory copy on withdraw.
    function test_returndataBomb_withdrawGasBounded() public {
        bytes32 idA = keccak256("gA");
        bytes32 idB = keccak256("gB");
        _create(idA, 1 ether, 1 hours);
        _release(idA);
        uint256 g0 = gasleft();
        vm.prank(payee);
        escrow.withdraw();
        uint256 normal = g0 - gasleft();

        _create(idB, 1 ether, 1 hours);
        vm.etch(payee, type(ReturnBomb).runtimeCode);
        _release(idB);
        g0 = gasleft();
        vm.prank(payee);
        escrow.withdraw();
        uint256 bomb = g0 - gasleft();

        emit log_named_uint("withdraw gas normal", normal);
        emit log_named_uint("withdraw gas with 200KB returndata", bomb);
        // The callee still expands its own memory. The caller must not copy it.
        // The old push path added more than 150k on top of a normal release.
        assertGt(bomb, normal);
        assertLt(bomb, normal + 150_000);
        assertEq(escrow.pendingWithdrawals(payee), 0);
        assertEq(escrow.totalOwed(), 0);
    }

    /// @notice withdraw reentrancy into withdraw, release, refund, and createEscrow is blocked.
    function test_withdrawReentrancyBlocked() public {
        WithdrawReenter attacker = new WithdrawReenter(escrow);
        vault.setOperator(payeeBot, address(attacker));

        bytes32 attackerPayerBot = keccak256("attacker-payer-bot");
        bytes32 otherPayeeBot = keccak256("other-payee-bot");
        address otherPayee = makeAddr("other-payee");
        vault.register(
            attackerPayerBot, keccak256("wA"), keccak256("bA"), keccak256("pA"), Vault.Tier.Financial, address(attacker)
        );
        vault.register(
            otherPayeeBot, keccak256("wO"), keccak256("bO"), keccak256("pO"), Vault.Tier.Financial, otherPayee
        );

        bytes32 idA = keccak256("re-a");
        bytes32 idB = keccak256("re-b");
        bytes32 idC = keccak256("re-c");
        bytes32 createId = keccak256("re-create");
        attacker.configure(idB, idC, createId, otherPayee, attackerPayerBot, otherPayeeBot);

        vm.startPrank(payer);
        escrow.createEscrow{ value: 1 ether }(idA, address(attacker), payerBot, payeeBot, 30 days);
        escrow.createEscrow{ value: 1 ether }(idB, address(attacker), payerBot, payeeBot, 30 days);
        escrow.createEscrow{ value: 1 ether }(idC, address(attacker), payerBot, payeeBot, 1);
        vm.stopPrank();
        vm.warp(block.timestamp + 2);

        _release(idA);
        assertEq(escrow.pendingWithdrawals(address(attacker)), 1 ether);

        attacker.pull();

        assertTrue(attacker.entered());
        assertEq(bytes4(attacker.withdrawErr()), ReentrancyGuardReentrantCall.selector);
        assertEq(bytes4(attacker.releaseErr()), ReentrancyGuardReentrantCall.selector);
        assertEq(bytes4(attacker.refundErr()), ReentrancyGuardReentrantCall.selector);
        assertEq(bytes4(attacker.createErr()), ReentrancyGuardReentrantCall.selector);

        assertEq(uint8(_state(idB)), uint8(BotAttestationEscrow.EscrowState.Open));
        assertEq(uint8(_state(idC)), uint8(BotAttestationEscrow.EscrowState.Open));
        assertFalse(escrow.usedEscrowIds(createId));
        assertEq(address(attacker).balance, 1 ether);
        assertEq(escrow.pendingWithdrawals(address(attacker)), 0);
        assertEq(escrow.lockedValue(), 2 ether);
        _assertSolvent();
    }

    function test_withdrawReentrancy_followUpStillWorks() public {
        WithdrawReenter attacker = new WithdrawReenter(escrow);
        vault.setOperator(payeeBot, address(attacker));
        bytes32 attackerPayerBot = keccak256("attacker-payer-bot-2");
        bytes32 otherPayeeBot = keccak256("other-payee-bot-2");
        address otherPayee = makeAddr("other-payee-2");
        vault.register(
            attackerPayerBot,
            keccak256("wA2"),
            keccak256("bA2"),
            keccak256("pA2"),
            Vault.Tier.Financial,
            address(attacker)
        );
        vault.register(
            otherPayeeBot, keccak256("wO2"), keccak256("bO2"), keccak256("pO2"), Vault.Tier.Financial, otherPayee
        );

        bytes32 idA = keccak256("re2-a");
        bytes32 idB = keccak256("re2-b");
        bytes32 idC = keccak256("re2-c");
        bytes32 createId = keccak256("re2-create");
        attacker.configure(idB, idC, createId, otherPayee, attackerPayerBot, otherPayeeBot);

        vm.startPrank(payer);
        escrow.createEscrow{ value: 1 ether }(idA, address(attacker), payerBot, payeeBot, 30 days);
        escrow.createEscrow{ value: 1 ether }(idB, address(attacker), payerBot, payeeBot, 30 days);
        escrow.createEscrow{ value: 1 ether }(idC, address(attacker), payerBot, payeeBot, 1);
        vm.stopPrank();
        vm.warp(block.timestamp + 2);
        _release(idA);
        attacker.pull();

        vm.expectRevert(bytes("nothing to withdraw"));
        attacker.pull();

        _release(idB);
        assertEq(uint8(_state(idB)), uint8(BotAttestationEscrow.EscrowState.Released));
        escrow.refund(idC);
        assertEq(uint8(_state(idC)), uint8(BotAttestationEscrow.EscrowState.Refunded));
        assertEq(escrow.pendingWithdrawals(address(attacker)), 1 ether);
        assertEq(escrow.pendingWithdrawals(payer), 1 ether);

        attacker.createAfter(1 ether);
        assertTrue(escrow.usedEscrowIds(createId));
        assertEq(escrow.lockedValue(), 1 ether);
        _assertSolvent();
    }

    function test_doubleWithdrawReverts() public {
        bytes32 id = keccak256("dbl-wd");
        _create(id, 1 ether, 1 hours);
        _release(id);

        vm.prank(payer);
        vm.expectRevert(bytes("nothing to withdraw"));
        escrow.withdraw();
        assertEq(escrow.pendingWithdrawals(payee), 1 ether);

        vm.prank(payee);
        escrow.withdraw();
        assertEq(payee.balance, 1 ether);

        vm.prank(payee);
        vm.expectRevert(bytes("nothing to withdraw"));
        escrow.withdraw();
        vm.prank(payee);
        vm.expectRevert(bytes("nothing to withdraw"));
        escrow.withdrawTo(payer);
        assertEq(escrow.totalOwed(), 0);
        assertEq(payee.balance, 1 ether);
    }

    function test_withdrawTo_rejectingAccountEscapes() public {
        bytes32 id = keccak256("escape");
        _create(id, 1 ether, 1 hours);
        vm.etch(payee, type(RejectETH).runtimeCode);
        _release(id);

        vm.prank(payee);
        vm.expectRevert(BotAttestationEscrow.ZeroAddress.selector);
        escrow.withdrawTo(address(0));
        assertEq(escrow.pendingWithdrawals(payee), 1 ether);

        vm.prank(payee);
        vm.expectRevert(BotAttestationEscrow.WithdrawFailed.selector);
        escrow.withdraw();
        assertEq(escrow.pendingWithdrawals(payee), 1 ether);
        assertEq(escrow.totalOwed(), 1 ether);

        address dest = makeAddr("dest");
        vm.prank(payee);
        escrow.withdrawTo(dest);
        assertEq(dest.balance, 1 ether);
        assertEq(payee.balance, 0);
        assertEq(escrow.pendingWithdrawals(payee), 0);
        assertEq(escrow.totalOwed(), 0);
        assertEq(address(escrow).balance, 0);

        vm.prank(payee);
        vm.expectRevert(bytes("nothing to withdraw"));
        escrow.withdrawTo(dest);
    }

    function test_creditedAndWithdrawnEventArgs() public {
        bytes32 id = keccak256("evt-rel");
        uint256 amount = 1 ether;
        _create(id, amount, 1 hours);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit EscrowReleased(id, amount);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit Credited(id, payee, amount, true);
        _release(id);

        address dest = makeAddr("evt-dest");
        vm.expectEmit(true, true, true, true, address(escrow));
        emit Withdrawn(payee, dest, amount);
        vm.prank(payee);
        escrow.withdrawTo(dest);
        assertEq(dest.balance, amount);

        bytes32 idR = keccak256("evt-ref");
        _create(idR, amount, 100);
        vm.warp(block.timestamp + 101);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit EscrowRefunded(idR, amount);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit Credited(idR, payer, amount, false);
        escrow.refund(idR);

        vm.expectEmit(true, true, true, true, address(escrow));
        emit Withdrawn(payer, payer, amount);
        vm.prank(payer);
        escrow.withdraw();
        assertEq(escrow.pendingWithdrawals(payer), 0);
        assertEq(escrow.totalOwed(), 0);
    }

    function test_twoCreditsWithdrawOnce() public {
        bytes32 id1 = keccak256("sum-1");
        bytes32 id2 = keccak256("sum-2");
        _create(id1, 1 ether, 1 hours);
        _create(id2, 2 ether, 1 hours);
        _release(id1);
        _release(id2);
        assertEq(escrow.pendingWithdrawals(payee), 3 ether);
        assertEq(escrow.totalOwed(), 3 ether);
        assertEq(escrow.lockedValue(), 0);
        _assertSolvent();

        vm.prank(payee);
        escrow.withdraw();
        assertEq(payee.balance, 3 ether);
        assertEq(escrow.totalOwed(), 0);
        assertEq(address(escrow).balance, 0);
    }

    /// @notice Sum of credits equals settled amounts, and balance covers locked + owed.
    function testFuzz_creditsMatchSettledAndSolvent(
        uint96 a,
        uint96 b,
        bool pullPayee,
        bool pullPayer
    ) public {
        uint256 amtA = bound(a, 1, 100 ether);
        uint256 amtB = bound(b, 1, 100 ether);
        vm.deal(payer, amtA + amtB);

        bytes32 idA = keccak256("fuzz-a");
        bytes32 idB = keccak256("fuzz-b");
        _create(idA, amtA, 1 hours);
        _create(idB, amtB, 100);
        _release(idA);
        vm.warp(block.timestamp + 101);
        escrow.refund(idB);

        uint256 settled = amtA + amtB;
        assertEq(escrow.pendingWithdrawals(payee), amtA);
        assertEq(escrow.pendingWithdrawals(payer), amtB);
        assertEq(escrow.pendingWithdrawals(payee) + escrow.pendingWithdrawals(payer), settled);
        assertEq(escrow.totalOwed(), settled);
        assertEq(escrow.lockedValue(), 0);
        _assertSolvent();

        uint256 withdrawn;
        if (pullPayee) {
            vm.prank(payee);
            escrow.withdraw();
            withdrawn += amtA;
        }
        if (pullPayer) {
            vm.prank(payer);
            escrow.withdraw();
            withdrawn += amtB;
        }
        assertEq(escrow.totalOwed() + withdrawn, settled);
        assertEq(escrow.pendingWithdrawals(payer) + escrow.pendingWithdrawals(payee), escrow.totalOwed());
        _assertSolvent();
    }

    function testFuzz_openAndSettledStaySolvent(
        uint96 openAmt,
        uint96 settledAmt,
        bool releaseIt
    ) public {
        uint256 openA = bound(openAmt, 1, 40 ether);
        uint256 settledA = bound(settledAmt, 1, 40 ether);
        vm.deal(payer, openA + settledA);
        bytes32 openId = keccak256(abi.encode("open", openAmt, settledAmt));
        bytes32 settledId = keccak256(abi.encode("settled", openAmt, settledAmt, releaseIt));
        _create(openId, openA, 2 hours);
        _create(settledId, settledA, 2 hours);
        if (releaseIt) {
            _release(settledId);
        } else {
            vm.warp(block.timestamp + 2 hours + 1);
            escrow.refund(settledId);
        }

        assertEq(escrow.lockedValue(), openA);
        assertEq(escrow.totalOwed(), settledA);
        uint256 credits = escrow.pendingWithdrawals(payer) + escrow.pendingWithdrawals(payee);
        assertEq(credits, settledA);
        assertEq(credits, escrow.totalOwed());
        _assertSolvent();
    }
}

contract RejectETH2 {
    receive() external payable {
        revert("no");
    }
}

/// @dev Same-transaction selfdestruct still delivers ETH under Cancun.
contract ForceSend {
    constructor(
        address t
    ) payable {
        selfdestruct(payable(t));
    }
}

/// @dev SCA pull-payment handler: create, release, refund, dispute, rule, reject, withdraw, force-ETH, setters.
contract PullPaymentHandler is StdUtils {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    BotAttestationEscrow public escrow;
    DisputePanel public panel;
    address public payer;
    address public payee;
    address public governance;
    bytes32 payerBot;
    bytes32 payeeBot;
    address[3] arbs;
    bytes32[] public ids;
    mapping(bytes32 => bytes32) public did;
    uint256 public withdrawn;
    uint256 public forced;
    uint256 nonce;
    bool public setterBroken;
    bool public withdrawBlockedOther;
    uint256 public callsRelease;
    uint256 public callsRefund;
    uint256 public callsDispute;
    uint256 public callsRule;
    uint256 public callsWd;
    uint256 public callsWdFail;
    uint256 public callsSetter;
    address public d1;
    address public d2;
    bool flip;

    constructor(
        BotAttestationEscrow e,
        DisputePanel p,
        address _payer,
        address _payee,
        address gov,
        bytes32 a,
        bytes32 b,
        address[3] memory _arbs,
        address _d1,
        address _d2
    ) {
        escrow = e;
        panel = p;
        payer = _payer;
        payee = _payee;
        governance = gov;
        payerBot = a;
        payeeBot = b;
        arbs = _arbs;
        d1 = _d1;
        d2 = _d2;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function create(
        uint96 amt,
        uint32 dur
    ) external {
        if (ids.length >= 12) return;
        uint256 a = bound(amt, 1, 5 ether);
        uint256 d = bound(dur, 1, 3 days);
        bytes32 id = keccak256(abi.encode("s", nonce++));
        vm.deal(payer, payer.balance + a);
        vm.prank(payer);
        escrow.createEscrow{ value: a }(id, payee, payerBot, payeeBot, d);
        ids.push(id);
    }

    function _pick(
        uint256 i
    ) internal view returns (bytes32) {
        return ids[i % ids.length];
    }

    function release(
        uint256 i
    ) external {
        if (ids.length == 0) return;
        bytes32 id = _pick(i);
        (address rowPayer, address rowPayee,,,,,,,,) = escrow.escrows(id);
        // Open release is the payer. After an uphold, either party can release.
        // A payee call while Open reverts and is swallowed here.
        vm.prank(i % 2 == 0 ? rowPayer : rowPayee);
        try escrow.release(id) {
            callsRelease++;
        } catch { }
    }

    function refund(
        uint256 i
    ) external {
        if (ids.length == 0) return;
        try escrow.refund(_pick(i)) {
            callsRefund++;
        } catch { }
    }

    function disputeIt(
        uint256 i,
        bool byPayee
    ) external {
        if (ids.length == 0) return;
        bytes32 id = bytes32(0);
        for (uint256 k; k < ids.length; k++) {
            bytes32 c = ids[(i % ids.length + k) % ids.length];
            (,,,,,, uint256 exp, BotAttestationEscrow.EscrowState st,,) = escrow.escrows(c);
            if (st == BotAttestationEscrow.EscrowState.Open && block.timestamp <= exp) {
                id = c;
                break;
            }
        }
        if (id == bytes32(0)) return;
        address who = byPayee ? payee : payer;
        bytes32 d = keccak256(abi.encode("d", nonce++));
        vm.prank(who);
        try escrow.dispute(id, d, "x") {
            did[id] = d;
            callsDispute++;
        } catch { }
    }

    function rule(
        uint256 i,
        bool uphold
    ) external {
        if (ids.length == 0) return;
        bytes32 d;
        for (uint256 k; k < ids.length; k++) {
            bytes32 c = ids[(i % ids.length + k) % ids.length];
            (,,,,, bool res,,) = panel.disputes(did[c]);
            if (did[c] != 0 && !res) {
                d = did[c];
                break;
            }
        }
        if (d == 0) return;
        for (uint256 k; k < 3; k++) {
            vm.prank(arbs[k]);
            try panel.vote(d, k < 2 ? uphold : !uphold) { }
            catch {
                return;
            }
        }
        callsRule++;
    }

    function toggleReject(
        bool whoPayee,
        bool reject
    ) external {
        address a = whoPayee ? payee : payer;
        vm.etch(a, reject ? type(RejectETH2).runtimeCode : bytes(""));
    }

    function withdraw(
        bool whoPayee,
        bool toSink
    ) external {
        address a = whoPayee ? payee : payer;
        address other = whoPayee ? payer : payee;
        uint256 amt = escrow.pendingWithdrawals(a);
        uint256 otherBefore = escrow.pendingWithdrawals(other);
        vm.prank(a);
        bool ok;
        if (toSink) {
            try escrow.withdrawTo(address(0xBEEF)) {
                ok = true;
            } catch { }
        } else {
            try escrow.withdraw() {
                ok = true;
            } catch { }
        }
        if (ok) {
            withdrawn += amt;
            callsWd++;
        } else {
            callsWdFail++;
            if (escrow.pendingWithdrawals(a) != amt) withdrawBlockedOther = true;
        }
        if (escrow.pendingWithdrawals(other) != otherBefore) withdrawBlockedOther = true;
        // The other party can still withdraw on its own when it accepts ETH.
        if (!ok && escrow.pendingWithdrawals(other) > 0 && other.code.length == 0) {
            uint256 oa = escrow.pendingWithdrawals(other);
            vm.prank(other);
            try escrow.withdraw() {
                withdrawn += oa;
            } catch {
                withdrawBlockedOther = true;
            }
        }
    }

    function forceEth(
        uint96 amt,
        bool viaSelfdestruct
    ) external {
        uint256 a = bound(amt, 1, 1 ether);
        if (viaSelfdestruct) {
            vm.deal(address(this), address(this).balance + a);
            new ForceSend{ value: a }(address(escrow));
        } else {
            vm.deal(address(escrow), address(escrow).balance + a);
        }
        forced += a;
    }

    function trySetters() external {
        if (escrow.lockedValue() != 0) return;
        flip = !flip;
        vm.prank(governance);
        try escrow.setDenylist(flip ? d2 : d1) {
            callsSetter++;
        } catch {
            setterBroken = true;
        }
    }

    function warp(
        uint32 dt
    ) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 days));
    }
}

/// forge-config: default.invariant.runs = 200
/// forge-config: default.invariant.depth = 300
/// forge-config: default.invariant.fail_on_revert = true
contract PullPaymentInvariantTest is Test {
    PullPaymentHandler internal handler;
    BotAttestationEscrow internal escrow;
    uint256[8] internal tot;

    function setUp() public {
        Denylist dl = new Denylist();
        Denylist dl2 = new Denylist();
        Vault vault = new Vault(address(dl));
        DisputePanel panel = new DisputePanel();
        address gov = makeAddr("gov");
        escrow = new BotAttestationEscrow(address(dl), address(vault), address(panel), gov);
        escrow.transferOwnership(gov);
        vm.prank(gov);
        escrow.acceptOwnership();
        address[3] memory arbs = [makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        for (uint256 k; k < 3; k++) {
            panel.setArbitrator(arbs[k], true);
        }
        address payer = makeAddr("sp");
        address payee = makeAddr("se");
        vault.register(keccak256("pb"), keccak256("1"), keccak256("2"), keccak256("3"), Vault.Tier.Financial, payer);
        vault.register(keccak256("eb"), keccak256("4"), keccak256("5"), keccak256("6"), Vault.Tier.Financial, payee);
        handler = new PullPaymentHandler(
            escrow, panel, payer, payee, gov, keccak256("pb"), keccak256("eb"), arbs, address(dl), address(dl2)
        );
        targetContract(address(handler));
        // `ids(uint256)` reverts out of range. Fuzz only the handler actions so fail_on_revert stays on.
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = PullPaymentHandler.create.selector;
        selectors[1] = PullPaymentHandler.release.selector;
        selectors[2] = PullPaymentHandler.refund.selector;
        selectors[3] = PullPaymentHandler.disputeIt.selector;
        selectors[4] = PullPaymentHandler.rule.selector;
        selectors[5] = PullPaymentHandler.toggleReject.selector;
        selectors[6] = PullPaymentHandler.withdraw.selector;
        selectors[7] = PullPaymentHandler.forceEth.selector;
        selectors[8] = PullPaymentHandler.trySetters.selector;
        selectors[9] = PullPaymentHandler.warp.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
    }

    function invariant_solvent() public view {
        assertGe(address(escrow).balance, escrow.lockedValue() + escrow.totalOwed());
    }

    function invariant_accounting() public view {
        uint256 open;
        uint256 settled;
        uint256 n = handler.idsLength();
        for (uint256 i; i < n; i++) {
            (,,,, uint256 amt,,, BotAttestationEscrow.EscrowState s,,) = escrow.escrows(handler.ids(i));
            if (s == BotAttestationEscrow.EscrowState.Open || s == BotAttestationEscrow.EscrowState.Disputed) {
                open += amt;
            } else {
                settled += amt;
            }
        }
        assertEq(escrow.lockedValue(), open);
        assertEq(escrow.totalOwed() + handler.withdrawn(), settled);
        assertEq(
            escrow.pendingWithdrawals(handler.payer()) + escrow.pendingWithdrawals(handler.payee()), escrow.totalOwed()
        );
        // Deposits minus withdrawals, plus ETH forced in outside the escrow flow.
        assertEq(address(escrow).balance, open + escrow.totalOwed() + handler.forced());
    }

    function invariant_noLocks() public view {
        assertFalse(handler.setterBroken());
        assertFalse(handler.withdrawBlockedOther());
    }

    function afterInvariant() public {
        tot[0] += handler.callsRelease();
        tot[1] += handler.callsRefund();
        tot[2] += handler.callsDispute();
        tot[3] += handler.callsRule();
        tot[4] += handler.callsWd();
        tot[5] += handler.callsWdFail();
        tot[6] += handler.callsSetter();
        tot[7] += handler.forced();
        console.log(
            "rel/ref/disp/rule",
            handler.callsRelease(),
            handler.callsRefund(),
            handler.callsDispute() * 1000 + handler.callsRule()
        );
        console.log("wd ok/fail/setterOK", handler.callsWd(), handler.callsWdFail(), handler.callsSetter());
    }
}
