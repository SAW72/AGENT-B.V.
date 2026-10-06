// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { IAccessControl } from "@openzeppelin/contracts/access/IAccessControl.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Safe calldata for the booked governance-timelock hardening. It does not send transactions.
/// @dev The booked target is applied on Base Sepolia: `getMinDelay()` is 86400 and `EXECUTOR_ROLE` is
///      held only by the governance Safe `0x12b3683A30De9845767c1f27a5D23591cA83dD54`. That Safe is 2-of-2,
///      so losing either key freezes admin changes. Spencer delegated that executor choice to Pete.
///      This script still only prints the batch that landed. `--broadcast` reverts. Agents do not pass it.
contract HardenGovernanceTimelock is Script {
    using stdJson for string;

    address public constant GOVERNANCE_TIMELOCK = 0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33;
    /// @dev Governance Safe. Live `PROPOSER_ROLE` and `CANCELLER_ROLE`. Booked `EXECUTOR_ROLE` target.
    address public constant PROPOSER = 0x12b3683A30De9845767c1f27a5D23591cA83dD54;
    address public constant CORE_TIMELOCK = 0x10CC9474b45625ADfd05C209f2518023484878D9;

    /// @dev 24 hours. Above the 300 second deploy floor. Not the delay argument of this schedule.
    uint256 public constant MIN_DELAY_TARGET = 86_400;
    /// @dev Booked observation of the pre-apply chain. The script re-reads `getMinDelay()` at preview time.
    uint256 public constant BOOKED_LIVE_MIN_DELAY = 300;

    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant SALT = keccak256("GOVERNANCE_TIMELOCK_HARDENING_V1");
    string public constant SALT_LABEL = "GOVERNANCE_TIMELOCK_HARDENING_V1";

    struct Batch {
        address[] targets;
        uint256[] values;
        bytes[] payloads;
        bytes32 predecessor;
        bytes32 salt;
        uint256 delay;
    }

    function broadcasting() public view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    /// @notice Forge `--broadcast` / `--resume` is refused. The Safe submits `scheduleBatch`.
    function requireNotBroadcasting(
        bool isBroadcast
    ) public pure {
        if (isBroadcast) revert("HardenTimelock: do not --broadcast; the Safe sends these calls");
    }

    /// @notice Grant `executor` `EXECUTOR_ROLE`, revoke `address(0)`, then `updateDelay(86400)`.
    /// @param scheduleDelay The existing `getMinDelay()`, not `MIN_DELAY_TARGET`.
    function build(
        address timelock,
        address executor,
        uint256 scheduleDelay
    ) public pure returns (Batch memory batch) {
        if (timelock == address(0)) revert("HardenTimelock: timelock unset");
        if (executor == address(0)) revert("HardenTimelock: executor is open");
        if (executor == timelock) revert("HardenTimelock: executor is the timelock");
        if (scheduleDelay == 0) revert("HardenTimelock: schedule delay unset");
        if (MIN_DELAY_TARGET <= 300) revert("HardenTimelock: target delay is not above 300");

        batch.targets = new address[](3);
        batch.values = new uint256[](3);
        batch.payloads = new bytes[](3);
        batch.targets[0] = timelock;
        batch.targets[1] = timelock;
        batch.targets[2] = timelock;
        batch.payloads[0] = abi.encodeCall(IAccessControl.grantRole, (EXECUTOR_ROLE, executor));
        batch.payloads[1] = abi.encodeCall(IAccessControl.revokeRole, (EXECUTOR_ROLE, address(0)));
        batch.payloads[2] = abi.encodeCall(TimelockController.updateDelay, (MIN_DELAY_TARGET));
        batch.predecessor = bytes32(0);
        batch.salt = SALT;
        batch.delay = scheduleDelay;
    }

    /// @notice `schedule` while the operation is unset, `execute` while it is pending, or `already-applied`.
    /// @dev `already-applied` is a chain read. The deployment book records that state.
    function preview(
        address timelock,
        address executor
    ) public view returns (Batch memory batch, string memory action) {
        TimelockController controller = TimelockController(payable(timelock));
        uint256 liveDelay = controller.getMinDelay();
        if (liveDelay == 0) revert("HardenTimelock: live minDelay is zero");

        bool openExecutor = controller.hasRole(EXECUTOR_ROLE, address(0));
        bool namedExecutor = controller.hasRole(EXECUTOR_ROLE, executor);
        bool atTarget = liveDelay == MIN_DELAY_TARGET && namedExecutor && !openExecutor;

        batch = build(timelock, executor, liveDelay);
        bytes32 id =
            controller.hashOperationBatch(batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt);
        if (atTarget) return (batch, "already-applied");
        if (controller.isOperationDone(id)) revert("HardenTimelock: operation done but target not reached");
        if (controller.isOperation(id)) return (batch, "execute");
        return (batch, "schedule");
    }

    /// @notice Booked target matches this script, and the book records that the chain has applied it.
    function assertBook() public view {
        string memory json = vm.readFile("deployments/base-sepolia.json");
        if (json.readAddress(".governanceTimelock") != GOVERNANCE_TIMELOCK) {
            revert("HardenTimelock: book timelock");
        }
        if (json.readAddress(".governanceTimelockHardening.timelock") != GOVERNANCE_TIMELOCK) {
            revert("HardenTimelock: book hardening timelock");
        }
        if (json.readUint(".governanceTimelockHardening.minDelayTarget") != MIN_DELAY_TARGET) {
            revert("HardenTimelock: book minDelay target");
        }
        if (json.readAddress(".governanceTimelockHardening.executorTarget") != PROPOSER) {
            revert("HardenTimelock: book executor");
        }
        if (keccak256(bytes(json.readString(".governanceTimelockHardening.executorMode"))) != keccak256("closed")) {
            revert("HardenTimelock: book executor mode");
        }
        if (json.readAddress(".governanceTimelockHardening.proposer") != PROPOSER) {
            revert("HardenTimelock: book proposer");
        }
        if (json.readUint(".governanceTimelockHardening.liveMinDelay") != MIN_DELAY_TARGET) {
            revert("HardenTimelock: book live delay");
        }
        if (keccak256(bytes(json.readString(".governanceTimelockHardening.liveExecutor"))) != keccak256("closed")) {
            revert("HardenTimelock: book live executor");
        }
        if (!json.readBool(".governanceTimelockHardening.applied")) revert("HardenTimelock: book not applied");
        if (keccak256(bytes(json.readString(".governanceTimelockHardening.status"))) != keccak256("applied")) {
            revert("HardenTimelock: book status");
        }
        if (keccak256(bytes(json.readString(".governanceTimelockHardening.saltLabel"))) != keccak256(bytes(SALT_LABEL)))
        {
            revert("HardenTimelock: book salt");
        }
        if (json.readAddress(".Denylist.owner") != GOVERNANCE_TIMELOCK) revert("HardenTimelock: denylist owner");
        if (json.readAddress(".Vault.owner") != GOVERNANCE_TIMELOCK) revert("HardenTimelock: vault owner");
        if (json.readAddress(".BotAttestationEscrow.owner") != GOVERNANCE_TIMELOCK) {
            revert("HardenTimelock: escrow owner");
        }
        if (json.readAddress(".BotAttestationEscrow.constructorArgs.governance") != GOVERNANCE_TIMELOCK) {
            revert("HardenTimelock: escrow governance");
        }
    }

    function run() external view {
        requireNotBroadcasting(broadcasting());
        assertBook();

        console.log("SIMULATE; no transaction will be sent");
        console.log("Spencer delegated the executor choice to Pete.");
        console.log("named executor is the governance Safe", PROPOSER);
        console.log("TARGET minDelay", MIN_DELAY_TARGET);
        console.log("booked pre-apply minDelay", BOOKED_LIVE_MIN_DELAY);
        console.log("proposer Safe", PROPOSER);

        (Batch memory batch, string memory action) = preview(GOVERNANCE_TIMELOCK, PROPOSER);
        _log(batch, action);
        console.log("Agents must not --broadcast.");
    }

    function _log(
        Batch memory batch,
        string memory action
    ) internal view {
        TimelockController controller = TimelockController(payable(batch.targets[0]));
        console.log("action", action);
        console.log("LIVE getMinDelay", controller.getMinDelay());
        console.log("LIVE open executor", controller.hasRole(EXECUTOR_ROLE, address(0)));
        console.log("LIVE Safe executor", controller.hasRole(EXECUTOR_ROLE, PROPOSER));
        console.log("TARGET executor", PROPOSER);
        console.log("schedule delay is the live minDelay, not the 86400 target", batch.delay);
        console.log("predecessor");
        console.logBytes32(batch.predecessor);
        console.log("salt");
        console.logBytes32(batch.salt);
        uint256 n = batch.targets.length;
        for (uint256 i = 0; i < n; i++) {
            console.log("target", batch.targets[i]);
            console.log("value", batch.values[i]);
            console.log("payload");
            console.logBytes(batch.payloads[i]);
        }
        bytes32 id =
            controller.hashOperationBatch(batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt);
        console.log("operationId");
        console.logBytes32(id);
        if (keccak256(bytes(action)) == keccak256("already-applied")) {
            console.log(
                "Chain matches the target. The book records applied."
            );
            return;
        }
        if (keccak256(bytes(action)) == keccak256("schedule")) {
            console.log("scheduleBatch calldata");
            console.logBytes(
                abi.encodeCall(
                    TimelockController.scheduleBatch,
                    (batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt, batch.delay)
                )
            );
        }
        console.log("executeBatch calldata");
        console.logBytes(
            abi.encodeCall(
                TimelockController.executeBatch,
                (batch.targets, batch.values, batch.payloads, batch.predecessor, batch.salt)
            )
        );
        console.log(
            "Safe proposes scheduleBatch. After the existing delay, executeBatch while the executor is still open."
        );
    }
}
