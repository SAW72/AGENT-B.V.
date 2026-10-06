// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

interface ISafe {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @notice Move ownership off `CORE_TIMELOCK` `0x10CC…78D9` onto a deployed `TimelockController`.
/// @dev `CORE_TIMELOCK` is an EOA with EIP-7702 delegation, not a timelock.
///      `requireValidTimelock` runs before every step. `NEW_TIMELOCK` must equal `EXPECTED_TIMELOCK`.
///      Step `transfer` (Spencer broadcast) moves Ownable2Step rows only.
///      Step `accept` prints `scheduleBatch` / `executeBatch` calldata. It does not broadcast.
///      Step `immediate` (Spencer broadcast) calls `setOwner` on Liability, InsuranceFund, and DisputePanel.
///      It reverts unless every in-scope Ownable2Step row already shows `owner() == NEW_TIMELOCK`.
///      Step `check` reverts unless the nine migration rows have the expected owner. It does not broadcast.
///      A contract whose `governance()` is `CORE_TIMELOCK` is skipped unless `MIGRATE_ESCROWS=1`.
///      `MIGRATE_ESCROWS` must be exactly 0 or 1. `NEW_TIMELOCK` must be the `TimelockController` CREATE in the
///      deploy record (`TIMELOCK_DEPLOY_JSON`, or `broadcast/DeployTimelock.s.sol/<chainid>/run-latest.json`).
///      Chain ids 84532 and 31337 are allowed. Every other chain reverts.
///      `getMinDelay()` must be at least 300 seconds.
///      This script never reads `PRIVATE_KEY`. Agents do not pass `--broadcast`. It does not create a Safe.
contract MigrateOwnershipToTimelock is Script {
    address public constant CORE_TIMELOCK = 0x10CC9474b45625ADfd05C209f2518023484878D9;
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    uint256 public constant ANVIL_CHAIN_ID = 31337;
    uint256 public constant MIN_DELAY = 300;

    address public constant SIMULATE_SENDER = 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001;
    address public constant FOUNDRY_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    /// @dev Set by tests so parallel `forge test` runs do not share env vars. Operators use the env vars.
    bool public forceEscrowMigration;
    bool internal escrowFlagPinned;
    uint256 internal pinnedEscrowFlag;
    address internal pinnedSafe;
    address internal pinnedExpected;
    address internal pinnedNewTimelock;
    bool internal stepIsPinned;
    string internal pinnedStep;
    bool internal deployJsonPinned;
    string internal pinnedDeployJson;

    /// @dev Stable salt so a resumed print of the same remaining set matches the scheduled operation.
    bytes32 public constant ACCEPT_SALT = keccak256("CORE_TIMELOCK_MIGRATION_ACCEPT_V1");
    bytes32 public constant PREDECESSOR = bytes32(0);
    bytes32 public constant ROLE_GRANTED_TOPIC = keccak256("RoleGranted(bytes32,address,address)");
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    bytes32 public constant CANCELLER_ROLE = keccak256("CANCELLER_ROLE");

    /// @dev Receipt fields the deploy-provenance check needs. `roles` and `accounts` are RoleGranted pairs
    /// emitted by the created timelock.
    struct DeployReceipt {
        uint256 status;
        address contractAddress;
        bytes32[] roles;
        address[] accounts;
    }

    uint256 internal constant BOOK_SLOTS = 14;
    uint256 internal constant MIGRATION_ROWS = 9;

    struct TransferResult {
        uint256 immediate;
        uint256 twoStepQueued;
        uint256 pendingThenQueued;
        uint256 skipped;
    }

    function broadcasting() public view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }

    /// @notice Test-only pins. Broadcast still reads `SAFE_ADDRESS`, `EXPECTED_TIMELOCK`, and `NEW_TIMELOCK`.
    function useSafe(
        address safe
    ) external {
        if (broadcasting()) revert("MigrateOwnership: set SAFE_ADDRESS");
        pinnedSafe = safe;
    }

    function useExpected(
        address expected
    ) external {
        if (broadcasting()) revert("MigrateOwnership: set EXPECTED_TIMELOCK");
        pinnedExpected = expected;
    }

    function pinNewTimelock(
        address newTimelock
    ) external {
        if (broadcasting()) revert("MigrateOwnership: set NEW_TIMELOCK");
        pinnedNewTimelock = newTimelock;
    }

    function pinStep(
        string calldata step
    ) external {
        if (broadcasting()) revert("MigrateOwnership: set MIGRATION_STEP");
        pinnedStep = step;
        stepIsPinned = true;
    }

    /// @notice Test-only deploy-record path. Broadcast reads `TIMELOCK_DEPLOY_JSON` or the default broadcast file.
    function useDeployJson(
        string calldata path
    ) external {
        if (broadcasting()) revert("MigrateOwnership: set TIMELOCK_DEPLOY_JSON");
        pinnedDeployJson = path;
        deployJsonPinned = true;
    }

    /// @notice Test-only `MIGRATE_ESCROWS` pin. Must be 0 or 1. Broadcast reads the env var.
    function pinMigrateEscrows(
        uint256 flag
    ) external {
        if (broadcasting()) revert("MigrateOwnership: set MIGRATE_ESCROWS");
        decodeMigrateEscrows(true, flag);
        pinnedEscrowFlag = flag;
        escrowFlagPinned = true;
    }

    /// @notice 84532 and 31337 proceed. Every other chain reverts.
    function requireAllowedChain() public view {
        uint256 id = block.chainid;
        if (id == BASE_SEPOLIA_CHAIN_ID || id == ANVIL_CHAIN_ID) return;
        revert("MigrateOwnership: chain refused");
    }

    /// @notice 300 seconds on an allowed chain. Every other chain reverts.
    function minDelayFloor() public view returns (uint256) {
        requireAllowedChain();
        return MIN_DELAY;
    }

    /// @notice Step `transfer` and step `immediate` broadcasts must be the `CORE_TIMELOCK` keystore.
    function requireBroadcastSender(
        address sender
    ) public pure {
        if (sender == FOUNDRY_DEFAULT_SENDER || sender == SIMULATE_SENDER) {
            revert("MigrateOwnership: pass --account and --sender");
        }
        if (sender != CORE_TIMELOCK) revert("MigrateOwnership: sender must be CORE_TIMELOCK");
    }

    function readAddress(
        string memory key,
        string memory unsetErr
    ) public view returns (address a) {
        try vm.envAddress(key) returns (address set) {
            a = set;
        } catch {
            revert(unsetErr);
        }
        if (a == address(0)) revert(unsetErr);
    }

    /// @notice Escrow rows are included only when `MIGRATE_ESCROWS=1`, or when a test called `optInEscrows`.
    /// @dev The env var has no default. It must be exactly 0 or 1. Unset, or any other value, reverts.
    function migrateEscrows() public view returns (bool enabled) {
        if (forceEscrowMigration) return true;
        if (!broadcasting() && escrowFlagPinned) return pinnedEscrowFlag == 1;
        try vm.envUint("MIGRATE_ESCROWS") returns (uint256 flag) {
            enabled = decodeMigrateEscrows(true, flag);
        } catch {
            return decodeMigrateEscrows(false, 0);
        }
    }

    /// @notice `present` is false when `MIGRATE_ESCROWS` is unset. `flag` must be 0 or 1.
    function decodeMigrateEscrows(
        bool present,
        uint256 flag
    ) public pure returns (bool enabled) {
        if (!present) revert("MigrateOwnership: MIGRATE_ESCROWS unset");
        if (flag > 1) revert("MigrateOwnership: MIGRATE_ESCROWS must be 0 or 1");
        enabled = flag == 1;
    }

    /// @notice Opt the in-memory script instance into escrow migration. Broadcast still requires `MIGRATE_ESCROWS=1`.
    function optInEscrows() external {
        if (broadcasting()) revert("MigrateOwnership: set MIGRATE_ESCROWS=1");
        forceEscrowMigration = true;
    }

    /// @notice Reject a controller that is not the pinned Safe timelock, before any ownership call and before every
    /// step.
    /// @dev `EXPECTED_TIMELOCK` is required. The deploy record's chain and `TimelockController` CREATE address must
    ///      match, and that create transaction's receipt must show status 1, the same contract, and exactly the four
    ///      role grants from `DeployTimelock`. The Safe must hold `PROPOSER_ROLE` and `CANCELLER_ROLE`, with threshold
    ///      at least 2 and at least that many owners, no zero or duplicate owner, and no owner equal to
    ///      `CORE_TIMELOCK` or `msg.sender`. Its code must not be an EIP-7702 designator. `DEFAULT_ADMIN_ROLE` sits
    ///      on the timelock and not on `CORE_TIMELOCK`, `msg.sender`, or the Safe. `CORE_TIMELOCK` holds no proposer,
    ///      executor, canceller, or admin role. `getMinDelay()` is at least 300 seconds.
    function requireValidTimelock(
        address newTimelock
    ) public {
        requireAllowedChain();
        if (newTimelock.code.length == 0) revert("MigrateOwnership: NEW_TIMELOCK has no code");
        address expected = _expected();
        bytes32 txHash = _requireCreateRecord(newTimelock, expected);
        address safe = _safeAddress();
        _requireSafe(safe);
        _requireDeployReceipt(txHash, newTimelock, expected, safe);
        TimelockController tl = TimelockController(payable(newTimelock));
        if (!tl.hasRole(tl.PROPOSER_ROLE(), safe)) revert("MigrateOwnership: SAFE missing PROPOSER_ROLE");
        if (!tl.hasRole(tl.CANCELLER_ROLE(), safe)) revert("MigrateOwnership: SAFE missing CANCELLER_ROLE");
        if (!tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), newTimelock)) {
            revert("MigrateOwnership: timelock is not self-administered");
        }
        if (tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), CORE_TIMELOCK)) {
            revert("MigrateOwnership: CORE_TIMELOCK holds DEFAULT_ADMIN_ROLE");
        }
        if (tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), msg.sender)) {
            revert("MigrateOwnership: msg.sender holds DEFAULT_ADMIN_ROLE");
        }
        if (tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), safe)) revert("MigrateOwnership: SAFE holds DEFAULT_ADMIN_ROLE");
        if (tl.hasRole(tl.PROPOSER_ROLE(), CORE_TIMELOCK)) {
            revert("MigrateOwnership: CORE_TIMELOCK holds PROPOSER_ROLE");
        }
        if (tl.hasRole(tl.EXECUTOR_ROLE(), CORE_TIMELOCK)) {
            revert("MigrateOwnership: CORE_TIMELOCK holds EXECUTOR_ROLE");
        }
        if (tl.hasRole(tl.CANCELLER_ROLE(), CORE_TIMELOCK)) {
            revert("MigrateOwnership: CORE_TIMELOCK holds CANCELLER_ROLE");
        }
        uint256 delay;
        try tl.getMinDelay() returns (uint256 got) {
            delay = got;
        } catch {
            revert("MigrateOwnership: NEW_TIMELOCK getMinDelay failed");
        }
        if (delay < minDelayFloor()) revert("MigrateOwnership: minDelay below floor");
    }

    function bookEntries() public view returns (string[] memory names, address[] memory targets) {
        string memory json = vm.readFile("deployments/base-sepolia.json");
        names = new string[](BOOK_SLOTS);
        targets = new address[](BOOK_SLOTS);
        for (uint256 i = 0; i < BOOK_SLOTS; i++) {
            names[i] = _slotName(i);
            targets[i] = _readAddr(json, _slotPath(i));
        }
    }

    /// @notice The eight `CORE_TIMELOCK`-owned contracts plus superseded Vault `0xa1a0…CB7`, in book order.
    ///         On chain id 84532 the addresses must match the pin.
    function migrationRows() public view returns (address[] memory rows) {
        (, address[] memory book) = bookEntries();
        rows = new address[](MIGRATION_ROWS);
        rows[0] = book[0];
        rows[1] = book[1];
        rows[2] = book[2];
        rows[3] = book[3];
        rows[4] = book[4];
        rows[5] = book[5];
        rows[6] = book[11];
        rows[7] = book[12];
        rows[8] = book[13];
        if (_pinRows()) _requirePinned(rows);
    }

    /// @notice `owner()` plus `pendingOwner()` when the call succeeds (Ownable2Step). A reverting `pendingOwner` is
    /// immediate `setOwner`.
    function inspect(
        address target
    ) public view returns (bool hasOwner, address owner, bool twoStep, address pending) {
        if (target == address(0) || target.code.length == 0) return (false, address(0), false, address(0));
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || data.length < 32) return (false, address(0), false, address(0));
        owner = abi.decode(data, (address));
        hasOwner = true;
        (bool okPending, bytes memory pendingData) = target.staticcall(abi.encodeWithSignature("pendingOwner()"));
        if (okPending && pendingData.length >= 32) {
            twoStep = true;
            pending = abi.decode(pendingData, (address));
        }
    }

    /// @notice Immutable `governance()` when the contract has that getter. Zero when it does not.
    function governanceOf(
        address target
    ) public view returns (address governance) {
        (bool ok, bytes memory data) = target.staticcall(abi.encodeWithSignature("governance()"));
        if (ok && data.length >= 32) governance = abi.decode(data, (address));
    }

    /// @notice True when `isArbitrator(CORE_TIMELOCK)` returns true. False when the call is absent or false.
    function coreIsArbitrator(
        address target
    ) public view returns (bool seated) {
        (bool ok, bytes memory data) =
            target.staticcall(abi.encodeWithSignature("isArbitrator(address)", CORE_TIMELOCK));
        if (ok && data.length >= 32) seated = abi.decode(data, (bool));
    }

    /// @notice Ownable2Step handoff only. Immediate `setOwner` rows are deferred to `transferImmediate`.
    function transferTwoStep(
        address[] memory targets,
        address newTimelock
    ) public returns (TransferResult memory result) {
        requireValidTimelock(newTimelock);
        uint256 n = targets.length;
        for (uint256 i = 0; i < n; i++) {
            uint8 kind = _transferTwoStepOne(targets[i], newTimelock);
            if (kind == 2) result.twoStepQueued += 1;
            else if (kind == 3) result.pendingThenQueued += 1;
            else result.skipped += 1;
        }
    }

    /// @notice Immediate `setOwner` handoff. Reverts unless every in-scope Ownable2Step row is already on
    /// `newTimelock` with `pendingOwner == 0`.
    function transferImmediate(
        address[] memory targets,
        address newTimelock
    ) public returns (TransferResult memory result) {
        requireValidTimelock(newTimelock);
        requireTwoStepSettled(targets, newTimelock);
        uint256 n = targets.length;
        for (uint256 i = 0; i < n; i++) {
            uint8 kind = _transferImmediateOne(targets[i], newTimelock);
            if (kind == 1) result.immediate += 1;
            else result.skipped += 1;
        }
    }

    /// @notice In-scope Ownable2Step rows must already show `owner() == newTimelock` and `pendingOwner == 0`.
    function requireTwoStepSettled(
        address[] memory targets,
        address newTimelock
    ) public view {
        uint256 n = targets.length;
        for (uint256 i = 0; i < n; i++) {
            if (_escrowHeldByCore(targets[i]) && !migrateEscrows()) continue;
            (bool hasOwner, address owner, bool twoStep, address pending) = inspect(targets[i]);
            if (!twoStep) continue;
            if (!hasOwner || owner != newTimelock || pending != address(0)) {
                revert("MigrateOwnership: Ownable2Step accept has not executed");
            }
        }
    }

    /// @notice Ownable2Step rows that still need `acceptOwnership` from `newTimelock`.
    function collectAccept(
        address[] memory targets,
        address newTimelock
    )
        public
        view
        returns (
            address[] memory batchTargets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt
        )
    {
        uint256 n = targets.length;
        uint256 count;
        for (uint256 i = 0; i < n; i++) {
            if (_needsAccept(targets[i], newTimelock)) count += 1;
        }
        batchTargets = new address[](count);
        values = new uint256[](count);
        payloads = new bytes[](count);
        bytes memory payload = abi.encodeWithSignature("acceptOwnership()");
        uint256 w;
        for (uint256 i = 0; i < n; i++) {
            if (!_needsAccept(targets[i], newTimelock)) continue;
            batchTargets[w] = targets[i];
            values[w] = 0;
            payloads[w] = payload;
            w += 1;
        }
        predecessor = PREDECESSOR;
        salt = ACCEPT_SALT;
    }

    /// @notice Exact nine-row check. Opted-out escrows must still be owned by `CORE_TIMELOCK`. Every other row must
    /// be owned by `newTimelock` with `pendingOwner == 0`. An unexpected owner reverts.
    function postCheck(
        address[] memory targets,
        address newTimelock
    ) public view {
        if (targets.length != MIGRATION_ROWS) revert("MigrateOwnership: expected 9 rows");
        if (_pinRows()) _requirePinned(targets);
        bool includeEscrows = migrateEscrows();
        uint256 n = targets.length;
        for (uint256 i = 0; i < n; i++) {
            (bool hasOwner, address owner, bool twoStep, address pending) = inspect(targets[i]);
            if (!hasOwner) revert("MigrateOwnership: unexpected owner");
            bool escrowRow = _escrowHeldByCore(targets[i]);
            if (escrowRow && !includeEscrows) {
                if (owner != CORE_TIMELOCK) revert("MigrateOwnership: unexpected owner");
                if (pending != address(0)) revert("MigrateOwnership: pendingOwner not cleared");
                continue;
            }
            if (escrowRow && owner != newTimelock) revert("MigrateOwnership: escrow owner is not the timelock");
            if (owner != newTimelock) revert("MigrateOwnership: unexpected owner");
            if (twoStep && pending != address(0)) revert("MigrateOwnership: pendingOwner not cleared");
        }
    }

    function run() external {
        requireAllowedChain();
        address newTimelock = _newTimelock();
        requireValidTimelock(newTimelock);

        string memory step = _step();
        (string[] memory names, address[] memory book) = bookEntries();
        address[] memory rows = migrationRows();
        _logBook(names, book, newTimelock);

        if (_eq(step, "transfer")) {
            bool send = broadcasting();
            if (send) {
                requireBroadcastSender(msg.sender);
                console.log("BROADCAST Spencer-only");
                vm.startBroadcast();
            } else {
                console.log("SIMULATE; no transaction will be sent");
            }
            transferTwoStep(rows, newTimelock);
            if (send) vm.stopBroadcast();
            _printAccept(rows, newTimelock);
        } else if (_eq(step, "immediate")) {
            bool send = broadcasting();
            if (send) {
                requireBroadcastSender(msg.sender);
                console.log("BROADCAST Spencer-only");
                vm.startBroadcast();
            } else {
                console.log("SIMULATE; no transaction will be sent");
            }
            transferImmediate(rows, newTimelock);
            if (send) vm.stopBroadcast();
        } else if (_eq(step, "accept")) {
            console.log("SIMULATE; no transaction will be sent");
            _printAccept(rows, newTimelock);
        } else if (_eq(step, "check")) {
            console.log("SIMULATE; no transaction will be sent");
            postCheck(rows, newTimelock);
            console.log("post-check ok");
        } else {
            revert("MigrateOwnership: MIGRATION_STEP must be transfer, immediate, accept, or check");
        }
    }

    function _transferTwoStepOne(
        address target,
        address newTimelock
    ) internal returns (uint8 kind) {
        if (newTimelock == address(0)) revert("MigrateOwnership: NEW_TIMELOCK unset");
        if (_escrowHeldByCore(target) && !migrateEscrows()) {
            console.log("skip: immutable governance; migrating bricks createEscrow and the setters", target);
            return 0;
        }
        (bool hasOwner, address owner, bool twoStep, address pending) = inspect(target);
        if (!hasOwner) return 0;
        if (!twoStep) {
            if (owner == newTimelock) {
                console.log("skip already migrated", target);
                return 0;
            }
            console.log("defer immediate setOwner until Ownable2Step accept has executed", target);
            return 0;
        }
        _logPrivileges(target);

        if (owner == newTimelock && pending == address(0)) {
            console.log("skip already migrated", target);
            return 0;
        }
        if (twoStep && owner == CORE_TIMELOCK && pending == newTimelock) {
            console.log("skip transfer; accept still pending", target);
            return 0;
        }
        if (pending == CORE_TIMELOCK && owner != CORE_TIMELOCK) {
            console.log("CORE_TIMELOCK is pendingOwner; accept then transferOwnership", target);
            _asCore();
            (bool accepted, bytes memory acceptRet) = target.call(abi.encodeWithSignature("acceptOwnership()"));
            if (!accepted) _bubble(acceptRet, "MigrateOwnership: acceptOwnership failed");
            _asCore();
            (bool queued, bytes memory queueRet) =
                target.call(abi.encodeWithSignature("transferOwnership(address)", newTimelock));
            if (!queued) _bubble(queueRet, "MigrateOwnership: transferOwnership failed");
            return 3;
        }
        if (owner != CORE_TIMELOCK) {
            console.log("skip owner is not CORE_TIMELOCK", target);
            return 0;
        }
        if (pending != address(0)) revert("MigrateOwnership: unexpected pendingOwner");
        _asCore();
        (bool ok, bytes memory ret) = target.call(abi.encodeWithSignature("transferOwnership(address)", newTimelock));
        if (!ok) _bubble(ret, "MigrateOwnership: transferOwnership failed");
        console.log("transferOwnership; timelock must acceptOwnership", target);
        return 2;
    }

    function _transferImmediateOne(
        address target,
        address newTimelock
    ) internal returns (uint8 kind) {
        if (_escrowHeldByCore(target) && !migrateEscrows()) {
            console.log("skip: immutable governance; migrating bricks createEscrow and the setters", target);
            return 0;
        }
        (bool hasOwner, address owner, bool twoStep,) = inspect(target);
        if (!hasOwner || twoStep) return 0;
        _logPrivileges(target);
        if (owner == newTimelock) {
            console.log("skip already migrated", target);
            return 0;
        }
        if (owner != CORE_TIMELOCK) {
            console.log("skip owner is not CORE_TIMELOCK", target);
            return 0;
        }
        console.log("WARNING: immediate setOwner; this handoff has no delay", target);
        _asCore();
        (bool setOk, bytes memory setRet) = target.call(abi.encodeWithSignature("setOwner(address)", newTimelock));
        if (!setOk) _bubble(setRet, "MigrateOwnership: setOwner failed");
        return 1;
    }

    function _needsAccept(
        address target,
        address newTimelock
    ) internal view returns (bool) {
        if (_escrowHeldByCore(target) && !migrateEscrows()) return false;
        (bool hasOwner,, bool twoStep, address pending) = inspect(target);
        // Only rows already pending the new controller. A batch built before `transferOwnership`
        // would revert inside `acceptOwnership`.
        return hasOwner && twoStep && pending == newTimelock;
    }

    /// @dev True when `target`'s `governance()` is `CORE_TIMELOCK`. Those rows are the live and retired escrows.
    function _escrowHeldByCore(
        address target
    ) internal view returns (bool) {
        return governanceOf(target) == CORE_TIMELOCK;
    }

    function _asCore() internal {
        if (!broadcasting()) vm.prank(CORE_TIMELOCK);
    }

    function _logPrivileges(
        address target
    ) internal view {
        address governance = governanceOf(target);
        if (governance == CORE_TIMELOCK) {
            console.log("UNMIGRATABLE immutable governance remains CORE_TIMELOCK", target);
            console.log("after owner moves, createEscrow and dependency setters revert until a new escrow is deployed");
        }
        if (coreIsArbitrator(target)) {
            console.log("CORE_TIMELOCK isArbitrator; seat is not cleared by this script", target);
        }
    }

    function _logBook(
        string[] memory names,
        address[] memory targets,
        address newTimelock
    ) internal view {
        console.log("chainid", block.chainid);
        console.log("NEW_TIMELOCK", newTimelock);
        console.log("CORE_TIMELOCK", CORE_TIMELOCK);
        uint256 n = targets.length;
        for (uint256 i = 0; i < n; i++) {
            (bool hasOwner, address owner, bool twoStep, address pending) = inspect(targets[i]);
            console.log(names[i], targets[i]);
            if (!hasOwner) {
                console.log("  no owner() or no code");
                continue;
            }
            console.log("  owner", owner);
            if (twoStep) {
                console.log("  Ownable2Step pending", pending);
            } else {
                console.log("  immediate setOwner");
            }
            if (owner == CORE_TIMELOCK) console.log("  include: live owner is CORE_TIMELOCK");
            address governance = governanceOf(targets[i]);
            if (governance != address(0)) console.log("  governance", governance);
            if (governance == CORE_TIMELOCK && !migrateEscrows()) {
                console.log(
                    "  skip unless MIGRATE_ESCROWS=1: immutable governance; migrating bricks createEscrow and the setters"
                );
            }
        }
    }

    function _printAccept(
        address[] memory targets,
        address newTimelock
    ) internal view {
        (
            address[] memory batchTargets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt
        ) = collectAccept(targets, newTimelock);
        uint256 delay = TimelockController(payable(newTimelock)).getMinDelay();
        console.log("accept batch length", batchTargets.length);
        console.log("predecessor");
        console.logBytes32(predecessor);
        console.log("salt");
        console.logBytes32(salt);
        console.log("delay", delay);
        uint256 n = batchTargets.length;
        for (uint256 i = 0; i < n; i++) {
            console.log("target", batchTargets[i]);
            console.log("value", values[i]);
            console.log("payload");
            console.logBytes(payloads[i]);
        }
        if (n == 0) {
            console.log("no Ownable2Step accept batch");
            return;
        }
        bytes32 id = TimelockController(payable(newTimelock))
            .hashOperationBatch(batchTargets, values, payloads, predecessor, salt);
        console.log("operationId");
        console.logBytes32(id);
        console.log("scheduleBatch calldata");
        console.logBytes(
            abi.encodeWithSelector(
                TimelockController.scheduleBatch.selector, batchTargets, values, payloads, predecessor, salt, delay
            )
        );
        console.log("executeBatch calldata");
        console.logBytes(
            abi.encodeWithSelector(
                TimelockController.executeBatch.selector, batchTargets, values, payloads, predecessor, salt
            )
        );
        console.log("Safe proposes scheduleBatch. After the delay, executeBatch. This step does not broadcast.");
    }

    function _readAddr(
        string memory json,
        string memory key
    ) internal view returns (address a) {
        try vm.parseJsonAddress(json, key) returns (address parsed) {
            a = parsed;
        } catch {
            a = address(0);
        }
    }

    function _bubble(
        bytes memory ret,
        string memory fallbackErr
    ) internal pure {
        if (ret.length == 0) revert(fallbackErr);
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }

    function _eq(
        string memory a,
        string memory b
    ) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _safeAddress() internal view returns (address safe) {
        if (pinnedSafe != address(0)) return pinnedSafe;
        safe = readAddress("SAFE_ADDRESS", "MigrateOwnership: SAFE_ADDRESS unset");
    }

    function _expected() internal view returns (address expected) {
        if (pinnedExpected != address(0)) return pinnedExpected;
        expected = readAddress("EXPECTED_TIMELOCK", "MigrateOwnership: EXPECTED_TIMELOCK unset");
    }

    function _newTimelock() internal view returns (address newTimelock) {
        if (pinnedNewTimelock != address(0)) return pinnedNewTimelock;
        newTimelock = readAddress("NEW_TIMELOCK", "MigrateOwnership: NEW_TIMELOCK unset");
    }

    function _step() internal view returns (string memory step) {
        if (stepIsPinned) return pinnedStep;
        step = vm.envOr("MIGRATION_STEP", string("transfer"));
    }

    function _pinRows() internal view returns (bool) {
        uint256 id = block.chainid;
        return id == BASE_SEPOLIA_CHAIN_ID;
    }

    function _requirePinned(
        address[] memory rows
    ) internal pure {
        address[9] memory pin = _pinnedNine();
        uint256 n = rows.length;
        for (uint256 i = 0; i < n; i++) {
            if (rows[i] != pin[i]) revert("MigrateOwnership: unexpected row");
        }
    }

    /// @dev Denylist, Vault, Liability, InsuranceFund, DisputePanel, live escrow, superseded Denylist,
    ///      superseded Vault, retired escrow.
    function _pinnedNine() internal pure returns (address[9] memory pin) {
        pin[0] = 0xeE76876bECcFc1B58fC06fF4E654a517d784B224;
        pin[1] = 0x1463D664fA467FBCDA4B05443434494f05e565bc;
        pin[2] = 0x554Caf5a214B8d70D675C09186C5EAE24FEB7307;
        pin[3] = 0x19fc26B36Cb2031062eD90C19db64b3b09753ab8;
        pin[4] = 0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb;
        pin[5] = 0x3d660502D75f1e97b08c110255921b437A3C4C42;
        pin[6] = 0xF0f260967D377E07Bdd7840862508ddB23C012b8;
        pin[7] = 0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7;
        pin[8] = 0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c;
    }

    /// @notice True when `account` code starts with the EIP-7702 designator `0xef0100`.
    function isDelegation(
        address account
    ) public view returns (bool) {
        return _isDelegation(account);
    }

    /// @dev Code length is not enough: an EIP-7702 designator (`0xef0100` plus an address) has code.
    function _requireSafe(
        address safe
    ) internal view {
        if (safe == address(0)) revert("MigrateOwnership: SAFE_ADDRESS unset");
        if (safe == CORE_TIMELOCK) revert("MigrateOwnership: SAFE_ADDRESS is CORE_TIMELOCK");
        if (safe == msg.sender) revert("MigrateOwnership: SAFE_ADDRESS is the deployer");
        if (safe.code.length == 0) revert("MigrateOwnership: SAFE_ADDRESS has no code");
        if (_isDelegation(safe)) revert("MigrateOwnership: SAFE_ADDRESS is an EIP-7702 delegation");
        uint256 threshold = ISafe(safe).getThreshold();
        if (threshold < 2) revert("MigrateOwnership: SAFE threshold is below 2");
        address[] memory owners = ISafe(safe).getOwners();
        if (owners.length < threshold) revert("MigrateOwnership: SAFE owners are below the threshold");
        _requireDistinctOwners(owners);
    }

    /// @dev Owners: no zero address, no duplicates, and none equal to `CORE_TIMELOCK` or the broadcaster.
    function _requireDistinctOwners(
        address[] memory owners
    ) internal view {
        uint256 n = owners.length;
        for (uint256 i = 0; i < n; i++) {
            address owner = owners[i];
            if (owner == address(0)) revert("MigrateOwnership: SAFE owner is the zero address");
            if (owner == CORE_TIMELOCK) revert("MigrateOwnership: SAFE owner is CORE_TIMELOCK");
            if (owner == msg.sender) revert("MigrateOwnership: SAFE owner is the deployer");
            for (uint256 j = 0; j < i; j++) {
                if (owner == owners[j]) revert("MigrateOwnership: SAFE owners are not unique");
            }
        }
    }

    /// @dev File, chain id, and CREATE address. The receipt check is separate so a missing Safe still reverts first.
    function _requireCreateRecord(
        address newTimelock,
        address expected
    ) internal view returns (bytes32 txHash) {
        string memory path = _deployJsonPath();
        if (!vm.exists(path)) revert("MigrateOwnership: deploy record missing");
        string memory json = vm.readFile(path);
        uint256 chainId;
        try vm.parseJsonUint(json, ".chain") returns (uint256 got) {
            chainId = got;
        } catch {
            revert("MigrateOwnership: deploy record chain mismatch");
        }
        if (chainId != block.chainid) revert("MigrateOwnership: deploy record chain mismatch");
        (address deployed, bytes32 hash, bool found) = _timelockCreate(json);
        if (!found || deployed == address(0)) {
            revert("MigrateOwnership: TimelockController CREATE not in deploy record");
        }
        if (deployed != newTimelock || deployed != expected) {
            revert("MigrateOwnership: NEW_TIMELOCK is not the deployed TimelockController");
        }
        if (hash == bytes32(0)) revert("MigrateOwnership: deploy record missing tx hash");
        txHash = hash;
    }

    /// @dev Real script runs call the RPC. Tests override `fetchDeployReceipt`. There is no env bypass.
    function _requireDeployReceipt(
        bytes32 txHash,
        address newTimelock,
        address expected,
        address safe
    ) internal {
        DeployReceipt memory receipt = fetchDeployReceipt(txHash);
        requireDeployReceipt(
            receipt.status, receipt.contractAddress, newTimelock, expected, safe, receipt.roles, receipt.accounts
        );
    }

    /// @notice Status 1, contract address, and exactly four RoleGranted logs from `DeployTimelock`.
    function requireDeployReceipt(
        uint256 status,
        address receiptContract,
        address newTimelock,
        address expected,
        address safe,
        bytes32[] memory roles,
        address[] memory accounts
    ) public pure {
        if (status != 1) revert("MigrateOwnership: deploy transaction failed");
        if (receiptContract != newTimelock || receiptContract != expected) {
            revert("MigrateOwnership: deploy receipt contract mismatch");
        }
        _requireRoleGrants(newTimelock, safe, roles, accounts);
    }

    /// @notice Fetch the create receipt from the active RPC. A null receipt reverts. No env bypass.
    function fetchDeployReceipt(
        bytes32 txHash
    ) public virtual returns (DeployReceipt memory receipt) {
        string memory params = string.concat("[\"", vm.toString(txHash), "\"]");
        string memory json;
        try vm.rpcJson("eth_getTransactionReceipt", params) returns (string memory got) {
            json = got;
        } catch {
            revert("MigrateOwnership: deploy receipt missing");
        }
        if (bytes(json).length == 0 || _eq(json, "null")) revert("MigrateOwnership: deploy receipt missing");
        try vm.parseJsonUint(json, ".status") returns (uint256 status) {
            receipt.status = status;
        } catch {
            revert("MigrateOwnership: deploy transaction failed");
        }
        try vm.parseJsonAddress(json, ".contractAddress") returns (address created) {
            receipt.contractAddress = created;
        } catch {
            receipt.contractAddress = address(0);
        }
        (receipt.roles, receipt.accounts) = _grantsFromReceipt(json, receipt.contractAddress);
    }

    function _requireRoleGrants(
        address timelock,
        address safe,
        bytes32[] memory roles,
        address[] memory accounts
    ) internal pure {
        if (roles.length != accounts.length) revert("MigrateOwnership: unexpected RoleGranted");
        bool admin;
        bool proposer;
        bool canceller;
        bool executor;
        uint256 n = roles.length;
        for (uint256 i; i < n; i++) {
            bytes32 role = roles[i];
            address account = accounts[i];
            if (role == bytes32(0) && account == timelock) {
                if (admin) revert("MigrateOwnership: unexpected RoleGranted");
                admin = true;
            } else if (role == PROPOSER_ROLE && account == safe) {
                if (proposer) revert("MigrateOwnership: unexpected RoleGranted");
                proposer = true;
            } else if (role == CANCELLER_ROLE && account == safe) {
                if (canceller) revert("MigrateOwnership: unexpected RoleGranted");
                canceller = true;
            } else if (role == EXECUTOR_ROLE && (account == address(0) || account == safe)) {
                if (executor) revert("MigrateOwnership: unexpected RoleGranted");
                executor = true;
            } else {
                revert("MigrateOwnership: unexpected RoleGranted");
            }
        }
        if (!admin) revert("MigrateOwnership: missing DEFAULT_ADMIN_ROLE grant");
        if (!proposer) revert("MigrateOwnership: missing PROPOSER_ROLE grant");
        if (!canceller) revert("MigrateOwnership: missing CANCELLER_ROLE grant");
        if (!executor) revert("MigrateOwnership: missing EXECUTOR_ROLE grant");
    }

    function _grantsFromReceipt(
        string memory json,
        address timelock
    ) internal pure returns (bytes32[] memory roles, address[] memory accounts) {
        uint256 n = _countRoleGrants(json, timelock);
        roles = new bytes32[](n);
        accounts = new address[](n);
        uint256 i = 0;
        uint256 k = 0;
        while (k < n) {
            string memory base = string.concat(".logs[", vm.toString(i), "]");
            try vm.parseJsonAddress(json, string.concat(base, ".address")) returns (address emitter) {
                if (emitter == timelock) {
                    try vm.parseJsonBytes32Array(json, string.concat(base, ".topics")) returns (
                        bytes32[] memory topics
                    ) {
                        if (topics.length >= 3 && topics[0] == ROLE_GRANTED_TOPIC) {
                            roles[k] = topics[1];
                            accounts[k] = address(uint160(uint256(topics[2])));
                            k += 1;
                        }
                    } catch { }
                }
            } catch {
                break;
            }
            i += 1;
        }
    }

    function _countRoleGrants(
        string memory json,
        address timelock
    ) internal pure returns (uint256 n) {
        uint256 i = 0;
        while (true) {
            string memory base = string.concat(".logs[", vm.toString(i), "]");
            try vm.parseJsonAddress(json, string.concat(base, ".address")) returns (address emitter) {
                if (emitter == timelock) {
                    try vm.parseJsonBytes32Array(json, string.concat(base, ".topics")) returns (
                        bytes32[] memory topics
                    ) {
                        if (topics.length >= 3 && topics[0] == ROLE_GRANTED_TOPIC) n += 1;
                    } catch { }
                }
            } catch {
                return n;
            }
            i += 1;
        }
    }

    function _deployJsonPath() internal view returns (string memory path) {
        if (!broadcasting() && deployJsonPinned) return pinnedDeployJson;
        try vm.envString("TIMELOCK_DEPLOY_JSON") returns (string memory set) {
            if (bytes(set).length != 0) return set;
        } catch { }
        path = string.concat("broadcast/DeployTimelock.s.sol/", vm.toString(block.chainid), "/run-latest.json");
    }

    function _timelockCreate(
        string memory json
    ) internal pure returns (address deployed, bytes32 txHash, bool found) {
        uint256 i = 0;
        while (true) {
            string memory prefix = string.concat(".transactions[", vm.toString(i), "]");
            try vm.parseJsonString(json, string.concat(prefix, ".transactionType")) returns (string memory txType) {
                try vm.parseJsonString(json, string.concat(prefix, ".contractName")) returns (string memory name) {
                    if (_eq(txType, "CREATE") && _eq(name, "TimelockController")) {
                        deployed = vm.parseJsonAddress(json, string.concat(prefix, ".contractAddress"));
                        try vm.parseJsonBytes32(json, string.concat(prefix, ".hash")) returns (bytes32 hash) {
                            txHash = hash;
                        } catch {
                            revert("MigrateOwnership: deploy record missing tx hash");
                        }
                        return (deployed, txHash, true);
                    }
                } catch { }
            } catch {
                return (address(0), bytes32(0), false);
            }
            i += 1;
        }
    }

    function _isDelegation(
        address account
    ) internal view returns (bool) {
        bytes memory code = account.code;
        return code.length >= 3 && code[0] == bytes1(0xef) && code[1] == bytes1(0x01) && code[2] == bytes1(0x00);
    }

    function _slotName(
        uint256 i
    ) internal pure returns (string memory) {
        if (i == 0) return "Denylist";
        if (i == 1) return "Vault";
        if (i == 2) return "Liability";
        if (i == 3) return "InsuranceFund";
        if (i == 4) return "DisputePanel";
        if (i == 5) return "BotAttestationEscrow";
        if (i == 6) return "BVT";
        if (i == 7) return "BVTStaking";
        if (i == 8) return "BVTFeeRouter";
        if (i == 9) return "BVTTimelock";
        if (i == 10) return "BVTGovernor";
        if (i == 11) return "superseded.Denylist";
        if (i == 12) return "superseded.Vault";
        return "retired.BotAttestationEscrow";
    }

    function _slotPath(
        uint256 i
    ) internal pure returns (string memory) {
        if (i == 0) return ".Denylist.address";
        if (i == 1) return ".Vault.address";
        if (i == 2) return ".Liability.address";
        if (i == 3) return ".InsuranceFund.address";
        if (i == 4) return ".DisputePanel.address";
        if (i == 5) return ".BotAttestationEscrow.address";
        if (i == 6) return ".BVT.address";
        if (i == 7) return ".BVTStaking.address";
        if (i == 8) return ".BVTFeeRouter.address";
        if (i == 9) return ".BVTTimelock.address";
        if (i == 10) return ".BVTGovernor.address";
        if (i == 11) return ".superseded.Denylist.address";
        if (i == 12) return ".superseded.Vault.address";
        return ".retired.BotAttestationEscrow.address";
    }
}
