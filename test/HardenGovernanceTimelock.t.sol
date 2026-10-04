// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { HardenGovernanceTimelock } from "../script/HardenGovernanceTimelock.s.sol";

/// @notice Booked hardening target and the Safe batch that would install it. No fork and no broadcast.
contract HardenGovernanceTimelockTest is Test {
    using stdJson for string;

    HardenGovernanceTimelock internal hard;

    function setUp() public {
        hard = new HardenGovernanceTimelock();
    }

    function test_bookPinsTargetNotLiveDelay() public view {
        hard.assertBook();
        string memory json = vm.readFile("deployments/base-sepolia.json");
        assertEq(json.readUint(".governanceTimelockHardening.minDelayTarget"), 86_400);
        assertGt(json.readUint(".governanceTimelockHardening.minDelayTarget"), 300);
        assertEq(json.readUint(".governanceTimelockHardening.liveMinDelay"), 300);
        assertFalse(json.readBool(".governanceTimelockHardening.applied"));
        assertEq(json.readAddress(".governanceTimelockHardening.executorTarget"), hard.PROPOSER());
        assertEq(json.readString(".governanceTimelockHardening.executorMode"), "closed");
        assertEq(json.readString(".governanceTimelockHardening.liveExecutor"), "open");
        assertEq(json.readString(".governanceTimelockHardening.status"), "target-not-applied");
        assertEq(json.readAddress(".Denylist.owner"), hard.GOVERNANCE_TIMELOCK());
        assertEq(json.readAddress(".Vault.owner"), hard.GOVERNANCE_TIMELOCK());
        assertEq(json.readAddress(".BotAttestationEscrow.owner"), hard.GOVERNANCE_TIMELOCK());
        assertEq(json.readAddress(".BotAttestationEscrow.pendingOwner"), address(0));
        assertEq(json.readAddress(".BotAttestationEscrow.constructorArgs.governance"), hard.CORE_TIMELOCK());
        assertEq(
            keccak256(bytes(json.readString(".governanceTimelockHardening.saltLabel"))),
            keccak256(bytes(hard.SALT_LABEL()))
        );
    }

    function test_buildUsesLiveDelayAndClosedExecutor() public {
        (TimelockController controller, address proposer) = _openController(300);
        HardenGovernanceTimelock.Batch memory batch =
            hard.build(address(controller), proposer, controller.getMinDelay());

        assertEq(batch.delay, 300);
        assertLt(batch.delay, hard.MIN_DELAY_TARGET());
        assertEq(batch.salt, keccak256("GOVERNANCE_TIMELOCK_HARDENING_V1"));
        assertEq(batch.predecessor, bytes32(0));
        assertEq(batch.targets.length, 3);
        assertEq(batch.payloads[0], abi.encodeCall(IAccessControl.grantRole, (controller.EXECUTOR_ROLE(), proposer)));
        assertEq(batch.payloads[1], abi.encodeCall(IAccessControl.revokeRole, (controller.EXECUTOR_ROLE(), address(0))));
        assertEq(batch.payloads[2], abi.encodeCall(TimelockController.updateDelay, (86_400)));
        vm.expectRevert(bytes("HardenTimelock: executor is the timelock"));
        hard.build(address(controller), address(controller), 300);
        vm.expectRevert(bytes("HardenTimelock: executor is open"));
        hard.build(address(controller), address(0), 300);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(batch.targets[i], address(controller));
            assertEq(batch.values[i], 0);
        }
        assertTrue(proposer != address(0));
    }

    function test_previewSchedulesUntilTheBatchLands() public {
        (TimelockController controller, address proposer) = _openController(300);
        (, string memory beforeSchedule) = hard.preview(address(controller), proposer);
        assertEq(beforeSchedule, "schedule");

        HardenGovernanceTimelock.Batch memory batch = hard.build(address(controller), proposer, 300);
        vm.prank(proposer);
        controller.scheduleBatch(
            batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, batch.delay
        );

        (, string memory pending) = hard.preview(address(controller), proposer);
        assertEq(pending, "execute");
        assertEq(controller.getMinDelay(), 300);
        assertTrue(controller.hasRole(controller.EXECUTOR_ROLE(), address(0)));
        assertFalse(controller.hasRole(controller.EXECUTOR_ROLE(), proposer));

        vm.warp(block.timestamp + 300);
        controller.executeBatch(batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt);

        assertEq(controller.getMinDelay(), 86_400);
        assertTrue(controller.hasRole(controller.EXECUTOR_ROLE(), proposer));
        assertFalse(controller.hasRole(controller.EXECUTOR_ROLE(), address(0)));
        assertFalse(controller.hasRole(controller.EXECUTOR_ROLE(), address(controller)));
        assertTrue(controller.hasRole(controller.PROPOSER_ROLE(), proposer));
        assertTrue(controller.hasRole(controller.CANCELLER_ROLE(), proposer));

        (, string memory done) = hard.preview(address(controller), proposer);
        assertEq(done, "already-applied");
    }

    function test_safeExecutorBlocksStrangers() public {
        (TimelockController controller, address proposer) = _openController(300);
        HardenGovernanceTimelock.Batch memory batch = hard.build(address(controller), proposer, 300);
        vm.prank(proposer);
        controller.scheduleBatch(batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, 300);
        vm.warp(block.timestamp + 300);
        controller.executeBatch(batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt);

        bytes memory later = abi.encodeCall(TimelockController.updateDelay, (86_400));
        bytes32 salt = bytes32(uint256(2));
        vm.prank(proposer);
        controller.schedule(address(controller), 0, later, bytes32(0), salt, 86_400);
        vm.warp(block.timestamp + 86_400);

        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature(
                "AccessControlUnauthorizedAccount(address,bytes32)", stranger, controller.EXECUTOR_ROLE()
            )
        );
        controller.execute(address(controller), 0, later, bytes32(0), salt);
        vm.stopPrank();

        vm.prank(proposer);
        controller.execute(address(controller), 0, later, bytes32(0), salt);
        assertTrue(
            controller.isOperationDone(controller.hashOperation(address(controller), 0, later, bytes32(0), salt))
        );
    }

    function test_broadcastIsRefused() public {
        assertFalse(hard.broadcasting());
        hard.requireNotBroadcasting(false);
        vm.expectRevert(bytes("HardenTimelock: do not --broadcast; the Safe sends these calls"));
        hard.requireNotBroadcasting(true);
    }

    function _openController(
        uint256 delay
    ) internal returns (TimelockController controller, address proposer) {
        proposer = makeAddr("safe");
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        controller = new TimelockController(delay, proposers, executors, address(0));
    }
}
