// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { Vm } from "forge-std/Vm.sol";
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { DeployTimelock } from "../script/DeployTimelock.s.sol";
import { DeployBotAttestationEscrow } from "../script/DeployBotAttestationEscrow.s.sol";
import { MigrateOwnershipToTimelock } from "../script/MigrateOwnershipToTimelock.s.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";
import { Liability } from "../contracts/Liability.sol";
import { InsuranceFund } from "../contracts/InsuranceFund.sol";
import { DisputePanel } from "../contracts/DisputePanel.sol";
import { BotAttestationEscrow } from "../contracts/BotAttestationEscrow.sol";

/// @dev Per-test fixture files. The path includes the test contract and the test selector so parallel runs do not
/// share a file.
abstract contract FixtureFiles is Test {
    uint256 internal fixtureNonce;
    string[] internal fixturePaths;

    modifier dropFixtures() {
        _;
        _dropFixtures();
    }

    function _fixturePath() internal returns (string memory path) {
        path = string.concat(
            "test/fixtures/",
            vm.toString(address(this)),
            "-",
            vm.toString(uint256(uint32(msg.sig))),
            "-",
            vm.toString(fixtureNonce),
            ".json"
        );
        fixtureNonce += 1;
        fixturePaths.push(path);
    }

    function _dropFixtures() internal {
        uint256 n = fixturePaths.length;
        for (uint256 i; i < n; i++) {
            if (vm.exists(fixturePaths[i])) vm.removeFile(fixturePaths[i]);
        }
        delete fixturePaths;
    }

    function _recordJson(
        address timelock,
        uint256 chainId,
        bytes32 txHash
    ) internal pure returns (string memory) {
        return string.concat(
            '{"chain":',
            vm.toString(chainId),
            ',"transactions":[{"hash":"',
            vm.toString(txHash),
            '","transactionType":"CREATE","contractName":"TimelockController","contractAddress":"',
            vm.toString(timelock),
            '"}]}'
        );
    }
}

/// @dev Unit tests cannot ask an RPC for a locally created transaction. This override returns logs captured at
/// deploy time. A broadcast on Base Sepolia still reads the RPC receipt.
contract MigrateOwnershipHarness is MigrateOwnershipToTimelock {
    struct PinnedReceipt {
        bytes32 txHash;
        uint256 status;
        address contractAddress;
        bytes32[] roles;
        address[] accounts;
    }

    PinnedReceipt[] internal pins;

    function deployTxKey(
        address timelock
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("CORE_TIMELOCK_DEPLOY", timelock));
    }

    function pinFromLogs(
        address timelock,
        Vm.Log[] memory logs
    ) external {
        if (broadcasting()) revert("MigrateOwnership: receipt is read from RPC");
        uint256 n;
        uint256 len = logs.length;
        for (uint256 i; i < len; i++) {
            if (_isGrant(logs[i], timelock)) n += 1;
        }
        bytes32[] memory roles = new bytes32[](n);
        address[] memory accounts = new address[](n);
        uint256 k;
        for (uint256 i; i < len; i++) {
            if (_isGrant(logs[i], timelock)) {
                roles[k] = logs[i].topics[1];
                accounts[k] = address(uint160(uint256(logs[i].topics[2])));
                k += 1;
            }
        }
        _pushPin(deployTxKey(timelock), 1, timelock, roles, accounts);
    }

    function fetchDeployReceipt(
        bytes32 txHash
    ) public override returns (DeployReceipt memory receipt) {
        if (broadcasting() && block.chainid == BASE_SEPOLIA_CHAIN_ID) return super.fetchDeployReceipt(txHash);
        uint256 n = pins.length;
        for (uint256 i; i < n; i++) {
            if (pins[i].txHash != txHash) continue;
            receipt.status = pins[i].status;
            receipt.contractAddress = pins[i].contractAddress;
            receipt.roles = pins[i].roles;
            receipt.accounts = pins[i].accounts;
            return receipt;
        }
        return super.fetchDeployReceipt(txHash);
    }

    function _pushPin(
        bytes32 txHash,
        uint256 status,
        address contractAddress,
        bytes32[] memory roles,
        address[] memory accounts
    ) internal {
        PinnedReceipt storage pin = pins.push();
        pin.txHash = txHash;
        pin.status = status;
        pin.contractAddress = contractAddress;
        uint256 n = roles.length;
        for (uint256 i; i < n; i++) {
            pin.roles.push(roles[i]);
            pin.accounts.push(accounts[i]);
        }
    }

    function _isGrant(
        Vm.Log memory entry,
        address timelock
    ) internal pure returns (bool) {
        return entry.emitter == timelock && entry.topics.length >= 3 && entry.topics[0] == ROLE_GRANTED_TOPIC;
    }
}

contract CoreTimelockTest is FixtureFiles {
    DeployTimelock internal deploy;
    MigrateOwnershipHarness internal mig;

    Denylist internal denylist;
    Vault internal vault;
    Liability internal liability;
    InsuranceFund internal insurance;
    DisputePanel internal panel;
    BotAttestationEscrow internal escrow;
    Denylist internal oldDenylist;
    Vault internal oldVault;
    BotAttestationEscrow internal retired;

    function setUp() public {
        deploy = new DeployTimelock();
        mig = new MigrateOwnershipHarness();
        mig.pinMigrateEscrows(0);
    }

    function test_delayIsEnforced() public dropFixtures {
        (TimelockController tl, address safe) = _controller(300, address(0));
        bytes memory payload = abi.encodeCall(TimelockController.updateDelay, (300));
        bytes32 salt = bytes32(uint256(1));
        bytes32 predecessor = bytes32(0);

        vm.prank(safe);
        tl.schedule(address(tl), 0, payload, predecessor, salt, 300);

        bytes32 id = tl.hashOperation(address(tl), 0, payload, predecessor, salt);
        bytes32 ready = bytes32(uint256(1) << 2);
        assertFalse(tl.isOperationReady(id));

        vm.expectRevert(abi.encodeWithSignature("TimelockUnexpectedOperationState(bytes32,bytes32)", id, ready));
        tl.execute(address(tl), 0, payload, predecessor, salt);

        vm.warp(block.timestamp + 300);
        assertTrue(tl.isOperationReady(id));
        tl.execute(address(tl), 0, payload, predecessor, salt);
        assertTrue(tl.isOperationDone(id));
        assertEq(tl.getMinDelay(), 300);
    }

    function test_onlySafeCanProposeAndCancel() public dropFixtures {
        (TimelockController tl, address safe) = _controller(300, address(0));
        address stranger = makeAddr("stranger");
        bytes memory payload = abi.encodeCall(TimelockController.updateDelay, (300));
        bytes32 salt = bytes32(uint256(2));
        bytes32 predecessor = bytes32(0);

        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", stranger, tl.PROPOSER_ROLE())
        );
        tl.schedule(address(tl), 0, payload, predecessor, salt, 300);
        vm.stopPrank();

        vm.prank(safe);
        tl.schedule(address(tl), 0, payload, predecessor, salt, 300);
        bytes32 id = tl.hashOperation(address(tl), 0, payload, predecessor, salt);

        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", stranger, tl.CANCELLER_ROLE())
        );
        tl.cancel(id);
        vm.stopPrank();

        vm.prank(safe);
        tl.cancel(id);
        assertFalse(tl.isOperation(id));

        bytes32 ready = bytes32(uint256(1) << 2);
        vm.expectRevert(abi.encodeWithSignature("TimelockUnexpectedOperationState(bytes32,bytes32)", id, ready));
        tl.execute(address(tl), 0, payload, predecessor, salt);
    }

    function test_safeExecutorRejectsStrangers() public dropFixtures {
        address safe = _etchSafe();
        (TimelockController tl,) = _controllerWith(safe, 300, safe);
        bytes memory payload = abi.encodeCall(TimelockController.updateDelay, (300));
        bytes32 salt = bytes32(uint256(3));
        vm.prank(safe);
        tl.schedule(address(tl), 0, payload, bytes32(0), salt, 300);
        vm.warp(block.timestamp + 300);

        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(
            abi.encodeWithSignature("AccessControlUnauthorizedAccount(address,bytes32)", stranger, tl.EXECUTOR_ROLE())
        );
        tl.execute(address(tl), 0, payload, bytes32(0), salt);
        vm.stopPrank();

        vm.prank(safe);
        tl.execute(address(tl), 0, payload, bytes32(0), salt);
        assertTrue(tl.isOperationDone(tl.hashOperation(address(tl), 0, payload, bytes32(0), salt)));
    }

    function test_adminRoleIsNotHeldByAnEoa() public dropFixtures {
        address eoa = makeAddr("deployer");
        address safe = _etchSafe();
        address other = makeAddr("other");
        vm.prank(eoa);
        TimelockController tl = deploy.deployTimelock(safe, 300, address(0));

        bytes32 admin = tl.DEFAULT_ADMIN_ROLE();
        assertTrue(tl.hasRole(admin, address(tl)));
        assertFalse(tl.hasRole(admin, eoa));
        assertFalse(tl.hasRole(admin, other));
        assertFalse(tl.hasRole(admin, safe));
        assertFalse(tl.hasRole(admin, address(0)));
        assertFalse(tl.hasRole(admin, mig.CORE_TIMELOCK()));
        assertFalse(tl.hasRole(admin, tx.origin));
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), safe));
        assertTrue(tl.hasRole(tl.CANCELLER_ROLE(), safe));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), address(0)));
        assertEq(tl.getMinDelay(), 300);
    }

    function test_safeWithoutCodeReverts() public dropFixtures {
        vm.expectRevert(bytes("DeployTimelock: SAFE_ADDRESS has no code"));
        deploy.deployTimelock(makeAddr("bare"), 300, address(0));
    }

    function test_chainAllowlistAndDelayFloor() public dropFixtures {
        address safe = _etchSafe();

        vm.chainId(84532);
        deploy.requireAllowedChain();
        mig.requireAllowedChain();
        assertEq(deploy.minDelayFloor(), 300);
        assertEq(mig.minDelayFloor(), 300);

        vm.chainId(31337);
        deploy.requireAllowedChain();
        mig.requireAllowedChain();

        vm.chainId(8453);
        vm.expectRevert(bytes("DeployTimelock: chain refused"));
        deploy.requireAllowedChain();
        vm.expectRevert(bytes("MigrateOwnership: chain refused"));
        mig.requireAllowedChain();
        vm.expectRevert(bytes("DeployTimelock: chain refused"));
        deploy.deployTimelock(safe, 300, address(0));
        vm.expectRevert(bytes("DeployTimelock: chain refused"));
        deploy.minDelayFloor();

        vm.chainId(1);
        vm.expectRevert(bytes("DeployTimelock: chain refused"));
        deploy.requireAllowedChain();
        vm.expectRevert(bytes("MigrateOwnership: chain refused"));
        mig.requireAllowedChain();
        vm.expectRevert(bytes("MigrateOwnership: chain refused"));
        mig.minDelayFloor();

        vm.chainId(11155111);
        vm.expectRevert(bytes("DeployTimelock: chain refused"));
        deploy.requireAllowedChain();
        vm.expectRevert(bytes("MigrateOwnership: chain refused"));
        mig.requireAllowedChain();

        vm.chainId(31337);
        assertEq(deploy.minDelayFloor(), 300);
        vm.expectRevert(bytes("DeployTimelock: minDelay below floor"));
        deploy.deployTimelock(safe, 299, address(0));
        vm.recordLogs();
        TimelockController tl = deploy.deployTimelock(safe, 300, address(0));
        mig.pinFromLogs(address(tl), vm.getRecordedLogs());
        assertEq(tl.getMinDelay(), 300);

        _arm(safe, address(tl));
        mig.requireValidTimelock(address(tl));
        vm.chainId(8453);
        vm.expectRevert(bytes("MigrateOwnership: chain refused"));
        mig.requireValidTimelock(address(tl));
        vm.chainId(31337);

        address foundryDefault = deploy.FOUNDRY_DEFAULT_SENDER();
        address simulateSender = deploy.SIMULATE_SENDER();
        address keystore = makeAddr("keystore");
        address core = mig.CORE_TIMELOCK();
        vm.expectRevert(bytes("DeployTimelock: pass --account and --sender"));
        deploy.requireBroadcastSender(foundryDefault);
        vm.expectRevert(bytes("DeployTimelock: pass --account and --sender"));
        deploy.requireBroadcastSender(simulateSender);
        deploy.requireBroadcastSender(keystore);

        vm.expectRevert(bytes("MigrateOwnership: sender must be CORE_TIMELOCK"));
        mig.requireBroadcastSender(keystore);
        mig.requireBroadcastSender(core);

        vm.expectRevert(bytes("DeployTimelock: TIMELOCK_MIN_DELAY unset"));
        deploy.readMinDelay();
    }

    function test_bookParsesDeploymentJson() public view {
        (string[] memory names, address[] memory targets) = mig.bookEntries();
        assertEq(targets.length, 14);
        assertEq(names[0], "Denylist");
        assertEq(targets[0], 0xeE76876bECcFc1B58fC06fF4E654a517d784B224);
        assertEq(targets[1], 0x1463D664fA467FBCDA4B05443434494f05e565bc);
        assertEq(targets[2], 0x554Caf5a214B8d70D675C09186C5EAE24FEB7307);
        assertEq(targets[3], 0x19fc26B36Cb2031062eD90C19db64b3b09753ab8);
        assertEq(targets[4], 0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb);
        assertEq(targets[5], 0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d);
        assertEq(targets[6], address(0));
        assertEq(targets[7], address(0));
        assertEq(targets[8], address(0));
        assertEq(targets[9], address(0));
        assertEq(targets[10], address(0));
        assertEq(names[11], "superseded.Denylist");
        assertEq(targets[11], 0xF0f260967D377E07Bdd7840862508ddB23C012b8);
        assertEq(targets[12], 0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7);
        assertEq(names[13], "retired.BotAttestationEscrow");
        assertEq(targets[13], 0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c);

        address[] memory rows = mig.migrationRows();
        assertEq(rows.length, 9);
        assertEq(rows[0], targets[0]);
        assertEq(rows[4], targets[4]);
        assertEq(rows[5], targets[5]);
        assertEq(rows[6], targets[11]);
        assertEq(rows[7], targets[12]);
        assertEq(rows[8], targets[13]);
    }

    function test_scriptedFlowLandsOwnershipOnTimelock() public dropFixtures {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        (TimelockController tl, address safe) = _controller(300, address(0));
        _arm(safe, address(tl));

        MigrateOwnershipToTimelock.TransferResult memory first = mig.transferTwoStep(targets, address(tl));
        assertEq(first.immediate, 0);
        assertEq(first.twoStepQueued, 3);
        assertEq(first.pendingThenQueued, 1);
        assertEq(first.skipped, 5);

        assertEq(liability.owner(), core);
        assertEq(insurance.owner(), core);
        assertEq(panel.owner(), core);
        assertEq(denylist.owner(), core);
        assertEq(denylist.pendingOwner(), address(tl));
        assertEq(oldVault.owner(), core);
        assertEq(oldVault.pendingOwner(), address(tl));
        assertEq(escrow.owner(), core);
        assertEq(escrow.pendingOwner(), address(0));
        assertEq(retired.owner(), core);
        assertEq(retired.pendingOwner(), address(0));
        assertEq(escrow.governance(), core);
        assertEq(retired.governance(), core);

        vm.expectRevert(bytes("MigrateOwnership: Ownable2Step accept has not executed"));
        mig.transferImmediate(targets, address(tl));
        assertEq(liability.owner(), core);
        assertEq(insurance.owner(), core);
        assertEq(panel.owner(), core);

        vm.expectRevert(bytes("MigrateOwnership: unexpected owner"));
        mig.postCheck(targets, address(tl));

        (
            address[] memory batchTargets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt
        ) = mig.collectAccept(targets, address(tl));
        assertEq(batchTargets.length, 4);
        assertEq(predecessor, bytes32(0));
        assertEq(salt, mig.ACCEPT_SALT());
        assertEq(bytes4(payloads[0]), bytes4(keccak256("acceptOwnership()")));

        vm.prank(safe);
        tl.scheduleBatch(batchTargets, values, payloads, predecessor, salt, 300);

        bytes32 id = tl.hashOperationBatch(batchTargets, values, payloads, predecessor, salt);
        bytes32 ready = bytes32(uint256(1) << 2);
        vm.expectRevert(abi.encodeWithSignature("TimelockUnexpectedOperationState(bytes32,bytes32)", id, ready));
        tl.executeBatch(batchTargets, values, payloads, predecessor, salt);

        vm.warp(block.timestamp + 300);
        tl.executeBatch(batchTargets, values, payloads, predecessor, salt);

        assertEq(denylist.owner(), address(tl));
        assertEq(liability.owner(), core);
        vm.expectRevert(bytes("MigrateOwnership: unexpected owner"));
        mig.postCheck(targets, address(tl));

        MigrateOwnershipToTimelock.TransferResult memory moved = mig.transferImmediate(targets, address(tl));
        assertEq(moved.immediate, 3);
        assertEq(moved.twoStepQueued, 0);
        assertEq(moved.pendingThenQueued, 0);
        assertEq(moved.skipped, 6);

        mig.postCheck(targets, address(tl));
        assertEq(denylist.owner(), address(tl));
        assertEq(denylist.pendingOwner(), address(0));
        assertEq(vault.owner(), address(tl));
        assertEq(vault.pendingOwner(), address(0));
        assertEq(oldDenylist.owner(), address(tl));
        assertEq(oldVault.owner(), address(tl));
        assertEq(oldVault.pendingOwner(), address(0));
        assertEq(liability.owner(), address(tl));
        assertEq(insurance.owner(), address(tl));
        assertEq(panel.owner(), address(tl));
        assertEq(escrow.owner(), core);
        assertEq(escrow.pendingOwner(), address(0));
        assertEq(retired.owner(), core);
        assertEq(retired.pendingOwner(), address(0));
        assertEq(escrow.governance(), core);
        assertEq(retired.governance(), core);

        MigrateOwnershipToTimelock.TransferResult memory againTwo = mig.transferTwoStep(targets, address(tl));
        assertEq(againTwo.immediate, 0);
        assertEq(againTwo.twoStepQueued, 0);
        assertEq(againTwo.pendingThenQueued, 0);
        assertEq(againTwo.skipped, targets.length);
        MigrateOwnershipToTimelock.TransferResult memory againNow = mig.transferImmediate(targets, address(tl));
        assertEq(againNow.immediate, 0);
        assertEq(againNow.skipped, targets.length);
        assertEq(denylist.owner(), address(tl));
        assertEq(liability.owner(), address(tl));
    }

    function test_migrationIsIdempotent() public dropFixtures {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        (TimelockController tl, address safe) = _controller(300, address(0));
        _arm(safe, address(tl));

        mig.transferTwoStep(targets, address(tl));
        assertEq(escrow.owner(), core);
        assertEq(retired.owner(), core);
        assertEq(liability.owner(), core);
        address[] memory owners = new address[](targets.length);
        address[] memory pendings = new address[](targets.length);
        for (uint256 i = 0; i < targets.length; i++) {
            (, owners[i],, pendings[i]) = mig.inspect(targets[i]);
        }

        MigrateOwnershipToTimelock.TransferResult memory again = mig.transferTwoStep(targets, address(tl));
        assertEq(again.immediate, 0);
        assertEq(again.twoStepQueued, 0);
        assertEq(again.pendingThenQueued, 0);
        assertEq(again.skipped, targets.length);
        assertEq(liability.owner(), core);
        for (uint256 i = 0; i < targets.length; i++) {
            (, address owner,, address pending) = mig.inspect(targets[i]);
            assertEq(owner, owners[i]);
            assertEq(pending, pendings[i]);
        }
        assertEq(escrow.owner(), core);
        assertEq(retired.owner(), core);
    }

    function test_escrowOptInMigratesAndPostCheckRequiresIt() public dropFixtures {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        (TimelockController tl, address safe) = _controller(300, address(0));
        _arm(safe, address(tl));

        mig.transferTwoStep(targets, address(tl));
        _acceptAll(tl, safe, targets);
        mig.transferImmediate(targets, address(tl));
        mig.postCheck(targets, address(tl));
        assertEq(escrow.owner(), core);
        assertEq(retired.owner(), core);
        assertEq(liability.owner(), address(tl));

        mig.optInEscrows();
        assertTrue(mig.migrateEscrows());
        vm.expectRevert(bytes("MigrateOwnership: escrow owner is not the timelock"));
        mig.postCheck(targets, address(tl));

        MigrateOwnershipToTimelock.TransferResult memory queued = mig.transferTwoStep(targets, address(tl));
        assertEq(queued.immediate, 0);
        assertEq(queued.twoStepQueued, 2);
        assertEq(queued.pendingThenQueued, 0);
        assertEq(escrow.owner(), core);
        assertEq(escrow.pendingOwner(), address(tl));
        assertEq(retired.pendingOwner(), address(tl));
        vm.expectRevert(bytes("MigrateOwnership: Ownable2Step accept has not executed"));
        mig.transferImmediate(targets, address(tl));
        assertEq(liability.owner(), address(tl));
        vm.expectRevert(bytes("MigrateOwnership: escrow owner is not the timelock"));
        mig.postCheck(targets, address(tl));

        MigrateOwnershipToTimelock.TransferResult memory again = mig.transferTwoStep(targets, address(tl));
        assertEq(again.twoStepQueued, 0);
        assertEq(again.skipped, targets.length);
        assertEq(escrow.pendingOwner(), address(tl));

        _acceptAll(tl, safe, targets);
        mig.postCheck(targets, address(tl));
        assertEq(escrow.owner(), address(tl));
        assertEq(escrow.pendingOwner(), address(0));
        assertEq(retired.owner(), address(tl));
        assertEq(retired.pendingOwner(), address(0));
        assertEq(escrow.governance(), core);

        vm.expectRevert(BotAttestationEscrow.FundingBeforeGovernance.selector);
        escrow.createEscrow(keccak256("id"), address(0xBEEF), keccak256("payer"), keccak256("payee"), 1 days);

        MigrateOwnershipToTimelock.TransferResult memory done = mig.transferTwoStep(targets, address(tl));
        assertEq(done.skipped, targets.length);
        assertEq(escrow.owner(), address(tl));
    }

    function test_badTimelockRevertsBeforeHandoff() public dropFixtures {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        address safe = _etchSafe();
        (TimelockController pinned,) = _controllerWith(safe, 300, address(0));
        vm.expectRevert(bytes("MigrateOwnership: EXPECTED_TIMELOCK unset"));
        mig.requireValidTimelock(address(pinned));
        mig.useExpected(address(pinned));
        _pinDeployRecord(address(pinned));
        vm.expectRevert(bytes("MigrateOwnership: SAFE_ADDRESS unset"));
        mig.requireValidTimelock(address(pinned));

        address[] memory executors = new address[](1);

        address[] memory wrong = new address[](1);
        wrong[0] = makeAddr("otherProposer");
        TimelockController wrongProposer = _captureNew(300, wrong, executors, address(0));
        _arm(safe, address(wrongProposer));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.transferTwoStep(targets, address(wrongProposer));
        _assertUnchanged(targets, core);

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        TimelockController adminEoa = _captureNew(300, proposers, executors, address(this));
        _arm(safe, address(adminEoa));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.transferTwoStep(targets, address(adminEoa));
        _assertUnchanged(targets, core);

        TimelockController coreAdmin = _captureNew(300, proposers, executors, core);
        _arm(safe, address(coreAdmin));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.transferTwoStep(targets, address(coreAdmin));
        _assertUnchanged(targets, core);

        TimelockController safeAdmin = _captureNew(300, proposers, executors, safe);
        _arm(safe, address(safeAdmin));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.transferTwoStep(targets, address(safeAdmin));
        _assertUnchanged(targets, core);

        TimelockController zeroDelay = _captureNew(0, proposers, executors, address(0));
        _arm(safe, address(zeroDelay));
        vm.expectRevert(bytes("MigrateOwnership: minDelay below floor"));
        mig.transferTwoStep(targets, address(zeroDelay));
        _assertUnchanged(targets, core);

        TimelockController stripped = _captureNew(300, proposers, executors, address(this));
        stripped.revokeRole(stripped.DEFAULT_ADMIN_ROLE(), address(stripped));
        _arm(safe, address(stripped));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.transferTwoStep(targets, address(stripped));
        _assertUnchanged(targets, core);

        TimelockController noCancel = _captureNew(300, proposers, executors, address(this));
        noCancel.revokeRole(noCancel.CANCELLER_ROLE(), safe);
        noCancel.revokeRole(noCancel.DEFAULT_ADMIN_ROLE(), address(this));
        _arm(safe, address(noCancel));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.transferTwoStep(targets, address(noCancel));
        _assertUnchanged(targets, core);

        _arm(safe, address(pinned));
        mig.useExpected(address(wrongProposer));
        vm.expectRevert(bytes("MigrateOwnership: NEW_TIMELOCK is not the deployed TimelockController"));
        mig.transferTwoStep(targets, address(pinned));
        _assertUnchanged(targets, core);

        mig.useSafe(safe);
        mig.useExpected(address(wrongProposer));
        mig.pinNewTimelock(address(wrongProposer));
        mig.pinStep("accept");
        _pinDeployRecord(address(wrongProposer));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.run();
        _assertUnchanged(targets, core);

        mig.pinNewTimelock(address(pinned));
        mig.pinStep("check");
        vm.expectRevert(bytes("MigrateOwnership: NEW_TIMELOCK is not the deployed TimelockController"));
        mig.run();
        _assertUnchanged(targets, core);
    }

    function test_thresholdOneRevertsBeforeDeployOrHandoff() public dropFixtures {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        address oneOfOne = address(new SafeThresholdStub(1, 1));

        vm.expectRevert(bytes("DeployTimelock: SAFE threshold is below 2"));
        deploy.deployTimelock(oneOfOne, 300, address(0));

        address[] memory proposers = new address[](1);
        proposers[0] = oneOfOne;
        address[] memory executors = new address[](1);
        TimelockController tl = _captureNew(300, proposers, executors, address(0));
        _arm(oneOfOne, address(tl));
        vm.expectRevert(bytes("MigrateOwnership: SAFE threshold is below 2"));
        mig.transferTwoStep(targets, address(tl));
        _assertUnchanged(targets, core);

        address safe = _etchSafe();
        vm.expectRevert(bytes("DeployTimelock: minDelay below floor"));
        deploy.deployTimelock(safe, 0, address(0));
    }

    function test_coreTimelockRolesAreRejected() public dropFixtures {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        address safe = _etchSafe();
        address[] memory executors = new address[](1);
        address[] memory proposers = new address[](1);
        proposers[0] = safe;

        address[] memory withCore = new address[](2);
        withCore[0] = safe;
        withCore[1] = core;
        TimelockController coreProposer = _captureNew(300, withCore, executors, address(0));
        _arm(safe, address(coreProposer));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.transferTwoStep(targets, address(coreProposer));
        _assertUnchanged(targets, core);

        address[] memory coreExec = new address[](1);
        coreExec[0] = core;
        TimelockController coreExecutor = _captureNew(300, proposers, coreExec, address(0));
        _arm(safe, address(coreExecutor));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.transferTwoStep(targets, address(coreExecutor));
        _assertUnchanged(targets, core);

        TimelockController coreCanceller = _captureNew(300, proposers, executors, address(this));
        coreCanceller.grantRole(coreCanceller.CANCELLER_ROLE(), core);
        coreCanceller.revokeRole(coreCanceller.DEFAULT_ADMIN_ROLE(), address(this));
        _arm(safe, address(coreCanceller));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.transferTwoStep(targets, address(coreCanceller));
        _assertUnchanged(targets, core);

        TimelockController coreAdmin = _captureNew(300, proposers, executors, core);
        _arm(safe, address(coreAdmin));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.transferTwoStep(targets, address(coreAdmin));
        _assertUnchanged(targets, core);

        vm.expectRevert(bytes("DeployTimelock: CORE_TIMELOCK holds EXECUTOR_ROLE"));
        deploy.deployTimelock(safe, 300, core);
        _assertUnchanged(targets, core);
    }

    function test_eip7702DesignatorIsRejected() public dropFixtures {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        address safe = _etchSafe();
        (TimelockController tl,) = _controllerWith(safe, 300, address(0));

        address designated = makeAddr("delegate");
        address eoa = makeAddr("eoa7702");
        vm.etch(eoa, abi.encodePacked(hex"ef0100", bytes20(designated)));

        vm.expectRevert(bytes("DeployTimelock: SAFE_ADDRESS is an EIP-7702 delegation"));
        deploy.deployTimelock(eoa, 300, address(0));

        _arm(eoa, address(tl));
        vm.expectRevert(bytes("MigrateOwnership: SAFE_ADDRESS is an EIP-7702 delegation"));
        mig.transferTwoStep(targets, address(tl));
        _assertUnchanged(targets, core);
    }

    function test_safeIdentityAndOwnerCount() public dropFixtures {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        address safe = _etchSafe();
        (TimelockController tl,) = _controllerWith(safe, 300, address(0));

        vm.expectRevert(bytes("DeployTimelock: SAFE_ADDRESS is CORE_TIMELOCK"));
        deploy.deployTimelock(core, 300, address(0));

        _arm(core, address(tl));
        vm.expectRevert(bytes("MigrateOwnership: SAFE_ADDRESS is CORE_TIMELOCK"));
        mig.transferTwoStep(targets, address(tl));
        _assertUnchanged(targets, core);

        vm.startPrank(safe);
        vm.expectRevert(bytes("DeployTimelock: SAFE_ADDRESS is the deployer"));
        deploy.deployTimelock(safe, 300, address(0));
        vm.stopPrank();

        _arm(safe, address(tl));
        vm.startPrank(safe);
        vm.expectRevert(bytes("MigrateOwnership: SAFE_ADDRESS is the deployer"));
        mig.transferTwoStep(targets, address(tl));
        vm.stopPrank();
        _assertUnchanged(targets, core);

        address short = address(new SafeThresholdStub(2, 1));
        vm.expectRevert(bytes("DeployTimelock: SAFE owners are below the threshold"));
        deploy.deployTimelock(short, 300, address(0));

        address[] memory proposers = new address[](1);
        proposers[0] = short;
        address[] memory executors = new address[](1);
        TimelockController shortTl = _captureNew(300, proposers, executors, address(0));
        _arm(short, address(shortTl));
        vm.expectRevert(bytes("MigrateOwnership: SAFE owners are below the threshold"));
        mig.transferTwoStep(targets, address(shortTl));
        _assertUnchanged(targets, core);
    }

    function test_safeOwnerQualityReverts() public dropFixtures {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        address good = _etchSafe();
        (TimelockController tl,) = _controllerWith(good, 300, address(0));
        _arm(good, address(tl));

        address a = address(uint160(0xA010));
        address b = address(uint160(0xA011));

        address dupSafe = _ownersStub(_pair(a, a));
        vm.expectRevert(bytes("DeployTimelock: SAFE owners are not unique"));
        deploy.deployTimelock(dupSafe, 300, address(0));
        mig.useSafe(dupSafe);
        vm.expectRevert(bytes("MigrateOwnership: SAFE owners are not unique"));
        mig.transferTwoStep(targets, address(tl));
        _assertUnchanged(targets, core);

        address zeroSafe = _ownersStub(_pair(address(0), b));
        vm.expectRevert(bytes("DeployTimelock: SAFE owner is the zero address"));
        deploy.deployTimelock(zeroSafe, 300, address(0));
        mig.useSafe(zeroSafe);
        vm.expectRevert(bytes("MigrateOwnership: SAFE owner is the zero address"));
        mig.transferTwoStep(targets, address(tl));
        _assertUnchanged(targets, core);

        address coreSafe = _ownersStub(_pair(core, b));
        vm.expectRevert(bytes("DeployTimelock: SAFE owner is CORE_TIMELOCK"));
        deploy.deployTimelock(coreSafe, 300, address(0));
        mig.useSafe(coreSafe);
        vm.expectRevert(bytes("MigrateOwnership: SAFE owner is CORE_TIMELOCK"));
        mig.transferTwoStep(targets, address(tl));
        _assertUnchanged(targets, core);

        address deployerSafe = _ownersStub(_pair(address(this), b));
        vm.expectRevert(bytes("DeployTimelock: SAFE owner is the deployer"));
        deploy.deployTimelock(deployerSafe, 300, address(0));
        mig.useSafe(deployerSafe);
        vm.expectRevert(bytes("MigrateOwnership: SAFE owner is the deployer"));
        mig.transferTwoStep(targets, address(tl));
        _assertUnchanged(targets, core);
    }

    function test_deployRecordMustMatch() public dropFixtures {
        address safe = _etchSafe();
        (TimelockController tl,) = _controllerWith(safe, 300, address(0));
        _arm(safe, address(tl));
        mig.requireValidTimelock(address(tl));

        address other = makeAddr("otherRecord");
        string memory mismatch = _fixturePath();
        vm.writeFile(mismatch, _recordJson(other, block.chainid, bytes32(uint256(7))));
        mig.useDeployJson(mismatch);
        vm.expectRevert(bytes("MigrateOwnership: NEW_TIMELOCK is not the deployed TimelockController"));
        mig.requireValidTimelock(address(tl));

        mig.useDeployJson("test/fixtures/missing-deploy-record.json");
        vm.expectRevert(bytes("MigrateOwnership: deploy record missing"));
        mig.requireValidTimelock(address(tl));
    }

    function test_migrateEscrowsUnsetReverts() public dropFixtures {
        vm.expectRevert(bytes("MigrateOwnership: MIGRATE_ESCROWS unset"));
        mig.decodeMigrateEscrows(false, 0);
    }

    function test_deployReceiptFourGrantsPass() public view {
        address safe = address(uint160(0xA11));
        address timelock = address(uint160(0xB11));
        (bytes32[] memory roles, address[] memory accounts) = _fourGrants(timelock, safe, address(0));
        mig.requireDeployReceipt(1, timelock, timelock, timelock, safe, roles, accounts);
    }

    function test_deployReceiptExtraAdminReverts() public dropFixtures {
        address safe = address(uint160(0xA11));
        address timelock = address(uint160(0xB11));
        (bytes32[] memory roles, address[] memory accounts) = _fourGrants(timelock, safe, address(0));
        bytes32[] memory extraRoles = new bytes32[](5);
        address[] memory extraAccounts = new address[](5);
        for (uint256 i; i < 4; i++) {
            extraRoles[i] = roles[i];
            extraAccounts[i] = accounts[i];
        }
        extraRoles[4] = bytes32(0);
        extraAccounts[4] = address(uint160(0xC11));
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        mig.requireDeployReceipt(1, timelock, timelock, timelock, safe, extraRoles, extraAccounts);
    }

    function test_deployReceiptMissingCancellerReverts() public dropFixtures {
        address safe = address(uint160(0xA11));
        address timelock = address(uint160(0xB11));
        bytes32[] memory roles = new bytes32[](3);
        address[] memory accounts = new address[](3);
        roles[0] = bytes32(0);
        accounts[0] = timelock;
        roles[1] = mig.PROPOSER_ROLE();
        accounts[1] = safe;
        roles[2] = mig.EXECUTOR_ROLE();
        accounts[2] = address(0);
        vm.expectRevert(bytes("MigrateOwnership: missing CANCELLER_ROLE grant"));
        mig.requireDeployReceipt(1, timelock, timelock, timelock, safe, roles, accounts);
    }

    function test_deployReceiptFailedStatusReverts() public dropFixtures {
        address safe = address(uint160(0xA11));
        address timelock = address(uint160(0xB11));
        (bytes32[] memory roles, address[] memory accounts) = _fourGrants(timelock, safe, address(0));
        vm.expectRevert(bytes("MigrateOwnership: deploy transaction failed"));
        mig.requireDeployReceipt(0, timelock, timelock, timelock, safe, roles, accounts);
    }

    function test_deployReceiptWrongContractReverts() public dropFixtures {
        address safe = address(uint160(0xA11));
        address timelock = address(uint160(0xB11));
        (bytes32[] memory roles, address[] memory accounts) = _fourGrants(timelock, safe, address(0));
        vm.expectRevert(bytes("MigrateOwnership: deploy receipt contract mismatch"));
        mig.requireDeployReceipt(1, address(uint160(0xD11)), timelock, timelock, safe, roles, accounts);
    }

    function test_migrateEscrowsTwoReverts() public dropFixtures {
        vm.expectRevert(bytes("MigrateOwnership: MIGRATE_ESCROWS must be 0 or 1"));
        mig.decodeMigrateEscrows(true, 2);
    }

    function test_postCheckRejectsUnexpectedRows() public dropFixtures {
        address core = mig.CORE_TIMELOCK();
        address[] memory targets = _seed(core);
        (TimelockController tl, address safe) = _controller(300, address(0));
        _arm(safe, address(tl));

        address[] memory eight = new address[](8);
        vm.expectRevert(bytes("MigrateOwnership: expected 9 rows"));
        mig.postCheck(eight, address(tl));

        vm.expectRevert(bytes("MigrateOwnership: unexpected owner"));
        mig.postCheck(targets, address(tl));

        targets[0] = address(new Denylist());
        vm.expectRevert(bytes("MigrateOwnership: unexpected owner"));
        mig.postCheck(targets, address(tl));

        vm.chainId(84532);
        vm.expectRevert(bytes("MigrateOwnership: unexpected row"));
        mig.postCheck(targets, address(tl));
        address[] memory rows = mig.migrationRows();
        assertEq(rows.length, 9);
        assertEq(rows[7], 0xa1a067D2F58Ae54d4bb5Ec06d893B29E23A45CB7);
    }

    function test_escrowDeployRejectsCoreGovernance() public {
        DeployBotAttestationEscrow escrowDeploy = new DeployBotAttestationEscrow();
        (Denylist deny, Vault v, DisputePanel dispute) = _freshDeps();
        address core = escrowDeploy.LIVE_TIMELOCK();
        vm.expectRevert(bytes("DeployEscrow: NEW_TIMELOCK is pre-migration CORE"));
        escrowDeploy.deploy(address(deny), address(v), address(dispute), core);
    }

    function test_escrowDeployAcceptsValidTimelock() public dropFixtures {
        DeployBotAttestationEscrow escrowDeploy = new DeployBotAttestationEscrow();
        escrowDeploy.useTimelockCheck(mig);
        (TimelockController tl, address safe) = _controller(300, address(0));
        _arm(safe, address(tl));
        // The book names governanceTimelock. Deploy accepts NEW_TIMELOCK only when it is that address.
        _pinGovernanceBook(escrowDeploy, address(tl));
        (address booked, bool set) = escrowDeploy.readBookGovernance();
        assertTrue(set);
        assertEq(booked, address(tl));

        (Denylist deny, Vault v, DisputePanel dispute) = _freshDeps();
        BotAttestationEscrow created = escrowDeploy.deploy(address(deny), address(v), address(dispute), address(tl));
        assertEq(created.governance(), address(tl));
        assertEq(created.pendingOwner(), address(tl));
        assertEq(created.owner(), address(escrowDeploy));
        assertTrue(address(tl) != escrowDeploy.LIVE_TIMELOCK());
        assertEq(address(created.denylist()), address(deny));
        assertEq(address(created.vault()), address(v));
        assertEq(address(created.disputePanel()), address(dispute));
        _assertAcceptCall(escrowDeploy, address(created), tl);

        Denylist swapped = new Denylist();
        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        created.setDenylist(address(swapped));
        vm.prank(address(tl));
        created.acceptOwnership();
        assertEq(created.owner(), address(tl));
        assertEq(created.pendingOwner(), address(0));
        vm.prank(address(tl));
        created.setDenylist(address(swapped));
        assertEq(address(created.denylist()), address(swapped));
    }

    function test_runBroadcastCreatesFromDeployer() public dropFixtures {
        DeployBotAttestationEscrow escrowDeploy = new DeployBotAttestationEscrow();
        escrowDeploy.useTimelockCheck(mig);
        (TimelockController tl, address safe) = _controller(300, address(0));
        _arm(safe, address(tl));
        // The book names governanceTimelock. Broadcast accepts NEW_TIMELOCK only when it is that address.
        _pinGovernanceBook(escrowDeploy, address(tl));

        address deployer = makeAddr("escrowBroadcaster");
        vm.deal(deployer, 1 ether);
        uint256 nonce = vm.getNonce(deployer);
        escrowDeploy.useRunInputs(
            address(tl), escrowDeploy.LIVE_DENYLIST(), escrowDeploy.LIVE_VAULT(), escrowDeploy.LIVE_DISPUTE_PANEL()
        );
        escrowDeploy.runBroadcast(deployer);

        address createdAddr = _acceptTarget(escrowDeploy);
        assertEq(createdAddr, vm.computeCreateAddress(deployer, nonce));
        BotAttestationEscrow created = BotAttestationEscrow(createdAddr);
        assertEq(created.owner(), deployer);
        assertTrue(created.owner() != address(escrowDeploy));
        assertEq(created.governance(), address(tl));
        assertEq(created.pendingOwner(), address(tl));
        _assertAcceptCall(escrowDeploy, createdAddr, tl);
    }

    function test_escrowDeployRejectsCodelessGovernance() public {
        DeployBotAttestationEscrow escrowDeploy = new DeployBotAttestationEscrow();
        (Denylist deny, Vault v, DisputePanel dispute) = _freshDeps();
        vm.expectRevert(bytes("MigrateOwnership: NEW_TIMELOCK has no code"));
        escrowDeploy.deploy(address(deny), address(v), address(dispute), address(0xBEEF));
    }

    function test_escrowDeployRejectsNonTimelockContract() public {
        DeployBotAttestationEscrow escrowDeploy = new DeployBotAttestationEscrow();
        (Denylist deny, Vault v, DisputePanel dispute) = _freshDeps();
        vm.expectRevert(bytes("MigrateOwnership: NEW_TIMELOCK getMinDelay failed"));
        escrowDeploy.deploy(address(deny), address(v), address(dispute), address(deny));
    }

    function test_escrowDeployRejectsExpectedMismatch() public dropFixtures {
        DeployBotAttestationEscrow escrowDeploy = new DeployBotAttestationEscrow();
        escrowDeploy.useTimelockCheck(mig);
        (TimelockController tl, address safe) = _controller(300, address(0));
        _arm(safe, address(tl));
        mig.useExpected(address(0xBEEF));

        (Denylist deny, Vault v, DisputePanel dispute) = _freshDeps();
        vm.expectRevert(bytes("MigrateOwnership: NEW_TIMELOCK is not the deployed TimelockController"));
        escrowDeploy.deploy(address(deny), address(v), address(dispute), address(tl));
    }

    function test_escrowDeployRejectsBadRoleRecord() public dropFixtures {
        DeployBotAttestationEscrow escrowDeploy = new DeployBotAttestationEscrow();
        escrowDeploy.useTimelockCheck(mig);
        address safe = _etchSafe();
        address[] memory proposers = new address[](1);
        proposers[0] = makeAddr("otherProposer");
        address[] memory executors = new address[](1);
        vm.recordLogs();
        TimelockController bad = new TimelockController(300, proposers, executors, address(0));
        mig.pinFromLogs(address(bad), vm.getRecordedLogs());
        mig.useSafe(safe);
        mig.useExpected(address(bad));
        _pinDeployRecord(address(bad));

        (Denylist deny, Vault v, DisputePanel dispute) = _freshDeps();
        vm.expectRevert(bytes("MigrateOwnership: unexpected RoleGranted"));
        escrowDeploy.deploy(address(deny), address(v), address(dispute), address(bad));
    }

    function test_escrowDeployRejectsBookMismatch() public dropFixtures {
        DeployBotAttestationEscrow escrowDeploy = new DeployBotAttestationEscrow();
        escrowDeploy.useTimelockCheck(mig);
        (TimelockController tl, address safe) = _controller(300, address(0));
        _arm(safe, address(tl));
        string memory path = _fixturePath();
        vm.writeFile(path, string.concat('{"governanceTimelock":"', vm.toString(address(uint160(0xBEEF))), '"}'));
        escrowDeploy.useBook(path);

        (Denylist deny, Vault v, DisputePanel dispute) = _freshDeps();
        vm.expectRevert(bytes("DeployEscrow: NEW_TIMELOCK is not governanceTimelock"));
        escrowDeploy.deploy(address(deny), address(v), address(dispute), address(tl));
    }

    function _acceptTarget(
        DeployBotAttestationEscrow escrowDeploy
    ) internal view returns (address target) {
        (target,,,,,,,,) = escrowDeploy.lastAcceptCall();
    }

    function _assertAcceptCall(
        DeployBotAttestationEscrow escrowDeploy,
        address created,
        TimelockController tl
    ) internal view {
        (
            address target,
            bytes memory data,
            uint256 value,
            bytes32 predecessor,
            bytes32 salt,
            uint256 delay,
            bytes memory scheduleCalldata,
            bytes memory executeCalldata,
            bytes32 operationId
        ) = escrowDeploy.lastAcceptCall();
        bytes memory acceptData = abi.encodeWithSelector(bytes4(keccak256("acceptOwnership()")));
        assertEq(target, created);
        assertEq(data, acceptData);
        assertEq(value, 0);
        assertEq(predecessor, bytes32(0));
        assertEq(delay, tl.getMinDelay());
        assertEq(operationId, tl.hashOperation(created, 0, acceptData, bytes32(0), salt));
        assertEq(bytes4(scheduleCalldata), TimelockController.schedule.selector);
        assertEq(bytes4(executeCalldata), TimelockController.execute.selector);
    }

    function _freshDeps() internal returns (Denylist deny, Vault v, DisputePanel dispute) {
        deny = new Denylist();
        v = new Vault(address(deny));
        dispute = new DisputePanel();
    }

    function _arm(
        address safe,
        address timelock
    ) internal {
        mig.useSafe(safe);
        mig.useExpected(timelock);
        _pinDeployRecord(timelock);
    }

    /// @dev Fixture book whose `governanceTimelock` is the controller under test.
    ///      `deployments/base-sepolia.json` already names the live controller, so an unpinned
    ///      book rejects any other `NEW_TIMELOCK`.
    function _pinGovernanceBook(
        DeployBotAttestationEscrow escrowDeploy,
        address timelock
    ) internal {
        string memory path = _fixturePath();
        vm.writeFile(path, string.concat('{"governanceTimelock":"', vm.toString(timelock), '"}'));
        escrowDeploy.useBook(path);
    }

    function _pinDeployRecord(
        address timelock
    ) internal {
        string memory path = _fixturePath();
        vm.writeFile(path, _recordJson(timelock, block.chainid, mig.deployTxKey(timelock)));
        mig.useDeployJson(path);
    }

    function _fourGrants(
        address timelock,
        address safe,
        address executor
    ) internal view returns (bytes32[] memory roles, address[] memory accounts) {
        roles = new bytes32[](4);
        accounts = new address[](4);
        roles[0] = bytes32(0);
        accounts[0] = timelock;
        roles[1] = mig.PROPOSER_ROLE();
        accounts[1] = safe;
        roles[2] = mig.CANCELLER_ROLE();
        accounts[2] = safe;
        roles[3] = mig.EXECUTOR_ROLE();
        accounts[3] = executor;
    }

    function _captureNew(
        uint256 delay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) internal returns (TimelockController tl) {
        vm.recordLogs();
        tl = new TimelockController(delay, proposers, executors, admin);
        mig.pinFromLogs(address(tl), vm.getRecordedLogs());
    }

    function _pair(
        address x,
        address y
    ) internal pure returns (address[] memory owners) {
        owners = new address[](2);
        owners[0] = x;
        owners[1] = y;
    }

    function _ownersStub(
        address[] memory owners
    ) internal returns (address safe) {
        SafeThresholdStub stub = new SafeThresholdStub(2, 2);
        stub.setOwners(owners);
        safe = address(stub);
    }

    function _acceptAll(
        TimelockController tl,
        address safe,
        address[] memory targets
    ) internal {
        (
            address[] memory batchTargets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt
        ) = mig.collectAccept(targets, address(tl));
        uint256 delay = tl.getMinDelay();
        vm.prank(safe);
        tl.scheduleBatch(batchTargets, values, payloads, predecessor, salt, delay);
        vm.warp(block.timestamp + delay);
        tl.executeBatch(batchTargets, values, payloads, predecessor, salt);
    }

    function _assertUnchanged(
        address[] memory targets,
        address core
    ) internal view {
        for (uint256 i = 0; i < targets.length; i++) {
            (bool hasOwner, address owner, bool twoStep, address pending) = mig.inspect(targets[i]);
            assertTrue(hasOwner);
            if (targets[i] == address(oldVault)) {
                assertEq(owner, address(this));
                assertTrue(twoStep);
                assertEq(pending, core);
            } else {
                assertEq(owner, core);
                if (twoStep) assertEq(pending, address(0));
            }
        }
    }

    function _seed(
        address core
    ) internal returns (address[] memory targets) {
        denylist = new Denylist();
        vault = new Vault(address(denylist));
        liability = new Liability(address(0));
        insurance = new InsuranceFund(address(liability));
        liability.bindInsurance(address(insurance));
        panel = new DisputePanel();
        escrow = new BotAttestationEscrow(address(denylist), address(vault), address(panel), core);
        oldDenylist = new Denylist();
        oldVault = new Vault(address(oldDenylist));
        retired = new BotAttestationEscrow(address(denylist), address(vault), address(panel), core);

        denylist.transferOwnership(core);
        vault.transferOwnership(core);
        escrow.transferOwnership(core);
        oldDenylist.transferOwnership(core);
        retired.transferOwnership(core);
        oldVault.transferOwnership(core);

        vm.startPrank(core);
        denylist.acceptOwnership();
        vault.acceptOwnership();
        escrow.acceptOwnership();
        oldDenylist.acceptOwnership();
        retired.acceptOwnership();
        vm.stopPrank();

        liability.setOwner(core);
        insurance.setOwner(core);
        panel.setOwner(core);

        targets = new address[](9);
        targets[0] = address(denylist);
        targets[1] = address(vault);
        targets[2] = address(liability);
        targets[3] = address(insurance);
        targets[4] = address(panel);
        targets[5] = address(escrow);
        targets[6] = address(oldDenylist);
        targets[7] = address(oldVault);
        targets[8] = address(retired);
    }

    function _etchSafe() internal returns (address safe) {
        safe = address(new SafeThresholdStub(2, 2));
    }

    function _controller(
        uint256 delay,
        address executor
    ) internal returns (TimelockController tl, address safe) {
        safe = _etchSafe();
        (tl,) = _controllerWith(safe, delay, executor);
    }

    function _controllerWith(
        address safe,
        uint256 delay,
        address executor
    ) internal returns (TimelockController tl, address safeOut) {
        address eoa = makeAddr("deployerEoa");
        vm.recordLogs();
        vm.prank(eoa);
        tl = deploy.deployTimelock(safe, delay, executor);
        mig.pinFromLogs(address(tl), vm.getRecordedLogs());
        safeOut = safe;
    }
}

/// @dev Stand-in for an existing Safe. The scripts call `getThreshold()` and `getOwners()`.
contract SafeThresholdStub {
    uint256 internal immutable _threshold;
    address[] internal _owners;

    constructor(
        uint256 threshold_,
        uint256 owners_
    ) {
        _threshold = threshold_;
        for (uint256 i; i < owners_; i++) {
            _owners.push(address(uint160(0xA000 + i)));
        }
    }

    function setOwners(
        address[] calldata next
    ) external {
        while (_owners.length != 0) {
            _owners.pop();
        }
        for (uint256 i; i < next.length; i++) {
            _owners.push(next[i]);
        }
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getOwners() external view returns (address[] memory owners) {
        owners = _owners;
    }
}

/// @notice Live Base Sepolia classification. Skips with no fork and no `BASE_SEPOLIA_RPC_URL`.
contract CoreTimelockForkTest is FixtureFiles {
    address internal constant CORE = 0x10CC9474b45625ADfd05C209f2518023484878D9;
    /// @dev Live owner of the book rows this fork reads. Same address as `governanceTimelock`.
    address internal constant GOVERNANCE_TIMELOCK = 0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33;
    uint256 internal constant BASE_SEPOLIA = 84532;

    MigrateOwnershipToTimelock internal mig;
    DeployTimelock internal deploy;

    function setUp() public {
        if (block.chainid != BASE_SEPOLIA) {
            string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
            if (bytes(rpc).length == 0) {
                vm.skip(true, "set BASE_SEPOLIA_RPC_URL or pass --fork-url for Base Sepolia (84532)");
                return;
            }
            vm.createSelectFork(rpc);
        }
        if (block.chainid != BASE_SEPOLIA) {
            vm.skip(true, "fork is not Base Sepolia (84532)");
            return;
        }
        mig = new MigrateOwnershipToTimelock();
        mig.pinMigrateEscrows(0);
        deploy = new DeployTimelock();
    }

    function test_forkRejectsWrongTimelock() public dropFixtures {
        address safe = address(new SafeThresholdStub(2, 2));
        TimelockController tl = deploy.deployTimelock(safe, 300, address(0));
        string memory path = _fixturePath();
        vm.writeFile(path, _recordJson(address(tl), block.chainid, bytes32(uint256(4))));
        mig.useDeployJson(path);
        mig.useSafe(safe);
        mig.useExpected(makeAddr("wrongTimelock"));
        mig.pinNewTimelock(address(tl));
        mig.pinStep("check");
        vm.expectRevert(bytes("MigrateOwnership: NEW_TIMELOCK is not the deployed TimelockController"));
        mig.run();
    }

    function test_forkRejectsRecordChain() public dropFixtures {
        address safe = address(new SafeThresholdStub(2, 2));
        TimelockController tl = deploy.deployTimelock(safe, 300, address(0));
        string memory path = _fixturePath();
        vm.writeFile(path, _recordJson(address(tl), 1, bytes32(uint256(5))));
        mig.useDeployJson(path);
        mig.useSafe(safe);
        mig.useExpected(address(tl));
        mig.pinNewTimelock(address(tl));
        mig.pinStep("check");
        vm.expectRevert(bytes("MigrateOwnership: deploy record chain mismatch"));
        mig.run();
    }

    function test_forkRejectsExtraAdminWithoutReceipt() public dropFixtures {
        address safe = address(new SafeThresholdStub(2, 2));
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        TimelockController tl = new TimelockController(300, proposers, executors, address(this));
        string memory path = _fixturePath();
        vm.writeFile(path, _recordJson(address(tl), block.chainid, bytes32(uint256(6))));
        mig.useDeployJson(path);
        mig.useSafe(safe);
        mig.useExpected(address(tl));
        mig.pinNewTimelock(address(tl));
        mig.pinStep("check");
        vm.expectRevert(bytes("MigrateOwnership: deploy receipt missing"));
        mig.run();
    }

    function test_forkClassifiesBookOwners() public view {
        assertEq(block.chainid, BASE_SEPOLIA);
        assertEq(CORE.code.length, 23);
        (bool delayOk,) = CORE.staticcall(abi.encodeWithSignature("getMinDelay()"));
        assertFalse(delayOk);

        (, address[] memory targets) = mig.bookEntries();
        address[9] memory owned = [
            targets[0], targets[1], targets[2], targets[3], targets[4], targets[5], targets[11], targets[13], address(0)
        ];
        for (uint256 i = 0; i < 8; i++) {
            (bool hasOwner, address owner, bool twoStep, address pending) = mig.inspect(owned[i]);
            assertTrue(hasOwner);
            assertEq(owner, GOVERNANCE_TIMELOCK);
            assertEq(pending, address(0));
            if (i == 2 || i == 3 || i == 4) assertFalse(twoStep);
            else assertTrue(twoStep);
        }

        (bool oldHas, address oldOwner, bool oldTwo, address oldPending) = mig.inspect(targets[12]);
        assertTrue(oldHas);
        assertTrue(oldTwo);
        assertEq(oldOwner, GOVERNANCE_TIMELOCK);
        assertEq(oldPending, address(0));

        assertEq(mig.governanceOf(targets[5]), CORE);
        assertEq(mig.governanceOf(targets[13]), CORE);
        assertFalse(mig.coreIsArbitrator(targets[4]));
        for (uint256 i = 6; i <= 10; i++) {
            assertEq(targets[i], address(0));
        }
    }
}
