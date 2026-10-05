// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DisputePanel } from "../contracts/DisputePanel.sol";
import { DeployBotAttestationEscrow } from "../script/DeployBotAttestationEscrow.s.sol";
import { OpsDisputePanelAdd, OpsDisputePanelSeat } from "../script/OpsDisputePanel.s.sol";

contract OpsDisputePanelGuardTest is Test {
    using stdJson for string;

    OpsDisputePanelAdd internal addOp;
    OpsDisputePanelSeat internal seatOp;
    address internal livePanel;
    address internal liveTimelock;
    address internal arb1 = address(0xA11);
    address internal arb2 = address(0xA22);
    address internal arb3 = address(0xA33);

    function setUp() public {
        addOp = new OpsDisputePanelAdd();
        seatOp = new OpsDisputePanelSeat();
        livePanel = addOp.LIVE_DISPUTE_PANEL();
        liveTimelock = addOp.LIVE_TIMELOCK();
    }

    function test_canonicalPanelMatchesDeploymentBook() public view {
        string memory book = vm.readFile("deployments/base-sepolia.json");
        assertEq(book.readAddress(".DisputePanel.address"), livePanel);
        assertEq(book.readAddress(".coreTimelock"), liveTimelock);
        assertEq(book.readAddress(".Denylist.address"), addOp.LIVE_DENYLIST());
        assertEq(book.readAddress(".Vault.address"), addOp.LIVE_VAULT());
        assertEq(book.readUint(".chainId"), addOp.ALLOWED_CHAIN_ID());
        assertEq(seatOp.LIVE_DISPUTE_PANEL(), livePanel);
        assertEq(
            book.readAddress(".BotAttestationEscrow.address"),
            0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d
        );
        assertEq(
            book.readString(".BotAttestationEscrow.deployTx"),
            "0x7ab17bac1f046ad50299e905f6f5fed47455fdebd3e3004094b899c7f801d8aa"
        );
        assertEq(book.readUint(".BotAttestationEscrow.deployBlock"), 47345163);
        assertEq(book.readUint(".BotAttestationEscrow.startBlock"), 47345163);
        assertEq(book.readString(".BotAttestationEscrow.commit"), "444c427");
        assertEq(book.readAddress(".BotAttestationEscrow.deployer"), 0x5D467FA00eC0E92044f779e495a17db66c5964aa);
        assertEq(book.readString(".BotAttestationEscrow.acceptOwnership"), "complete");
        assertEq(book.readAddress(".BotAttestationEscrow.owner"), book.readAddress(".governanceTimelock"));
        assertEq(book.readAddress(".BotAttestationEscrow.pendingOwner"), address(0));
        assertEq(
            book.readString(".BotAttestationEscrow.acceptOwnershipTx"),
            "0xe4286328ff1d177c724888255d3607187e4b4ea68d0f1e66d697e6152367e0e9"
        );
        assertEq(book.readUint(".BotAttestationEscrow.acceptOwnershipBlock"), 47345442);
        assertEq(book.readString(".BotAttestationEscrow.basescan"), "verified");
        assertEq(
            book.readString(".BotAttestationEscrow.basescanUrl"),
            "https://sepolia.basescan.org/address/0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d#code"
        );
        assertEq(
            book.readAddress(".retired.BotAttestationEscrow.address"),
            0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c
        );
        assertEq(
            book.readString(".retired.BotAttestationEscrow.reason"),
            "ESC-M-1 redeploy, retired 2026-09-26"
        );
        assertEq(book.readString(".retired.BotAttestationEscrow.acceptOwnership"), "complete");
        assertEq(book.readAddress(".retired.BotAttestationEscrow.owner"), liveTimelock);
        assertEq(book.readAddress(".retired.BotAttestationEscrow.pendingOwner"), address(0));
        assertEq(
            book.readString(".retired.BotAttestationEscrow.acceptOwnershipTx"),
            "0xd2e982568811c3706eec074d296ef7fa4c54838de714e1a5bfc8afc9fbb73983"
        );
        assertEq(book.readUint(".retired.BotAttestationEscrow.acceptOwnershipBlock"), 47300275);
        assertTrue(_contains(book, '"BVT": {\n    "address": null,\n    "deployTx": ""'));
    }

    function _contains(
        string memory haystack,
        string memory needle
    ) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool match_ = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return true;
        }
        return false;
    }

    function test_liveCoreAddressesPassEscrowGuards() public {
        DeployBotAttestationEscrow deploy = new DeployBotAttestationEscrow();
        address deployer = address(0xD00D);
        assertTrue(deployer != liveTimelock);
        deploy.requireTimelock(deployer, liveTimelock);
        deploy.requireDeps(addOp.LIVE_DENYLIST(), addOp.LIVE_VAULT(), livePanel);
        vm.chainId(84532);
        deploy.requireAllowedChain();
        vm.chainId(1);
        vm.expectRevert(bytes("DeployEscrow: mainnet forbidden"));
        deploy.requireAllowedChain();
    }

    function test_allowsBaseSepoliaOnly() public {
        vm.chainId(84532);
        addOp.requireAllowedChain();
        seatOp.requireAllowedChain();
    }

    function test_refusesMainnet() public {
        vm.chainId(1);
        vm.expectRevert(bytes("OpsLive: mainnet forbidden"));
        addOp.requireAllowedChain();
        vm.expectRevert(bytes("OpsLive: mainnet forbidden"));
        seatOp.requireAllowedChain();
    }

    function test_refusesOtherChains() public {
        vm.chainId(11155111);
        vm.expectRevert(bytes("OpsLive: Base Sepolia (84532) or Anvil (31337) only"));
        addOp.requireAllowedChain();
        vm.chainId(31337);
        addOp.requireAllowedChain();
        seatOp.requireAllowedChain();
    }

    function test_refusesUnknownPanelAndTimelock() public {
        vm.expectRevert(bytes("OpsPanel: DISPUTE_PANEL is not the live Base Sepolia DisputePanel"));
        addOp.assertCanonicalPanel(address(0x1234), liveTimelock);
        vm.expectRevert(bytes("OpsLive: CORE_TIMELOCK is not the live owner"));
        addOp.assertCanonicalPanel(livePanel, address(0x1234));
        addOp.assertCanonicalPanel(livePanel, liveTimelock);
    }

    function test_ownerGuard() public {
        vm.expectRevert(bytes("OpsPanel: DisputePanel.owner is not CORE_TIMELOCK"));
        addOp.assertPanelOwner(address(0x1234), liveTimelock);
        addOp.assertPanelOwner(liveTimelock, liveTimelock);
    }

    function test_requireDistinct() public {
        vm.expectRevert(bytes("OpsPanel: zero arbitrator"));
        addOp.requireDistinct(address(0), arb2, arb3);
        vm.expectRevert(bytes("OpsPanel: duplicate arbitrator"));
        addOp.requireDistinct(arb1, arb1, arb3);
        vm.expectRevert(bytes("OpsPanel: duplicate arbitrator"));
        addOp.requireDistinct(arb1, arb2, arb1);
        addOp.requireDistinct(arb1, arb2, arb3);
    }

    function test_broadcastSignerMustBeTimelock() public view {
        addOp.requireBroadcastSigner(address(0xBEEF), liveTimelock, false);
        addOp.requireBroadcastSigner(liveTimelock, liveTimelock, true);
        assertFalse(addOp.broadcasting());
    }

    function test_broadcastRefusesNonTimelockSigner() public {
        vm.expectRevert(bytes("OpsLive: PRIVATE_KEY is not the live owner; Spencer only"));
        addOp.requireBroadcastSigner(address(0xBEEF), liveTimelock, true);
    }

    function test_readUnsetEnvReverts() public {
        vm.expectRevert(bytes("OpsPanel: DISPUTE_PANEL unset"));
        addOp.readAddress("OPS_PANEL_UNSET_ADDRESS", "OpsPanel: DISPUTE_PANEL unset");
        vm.expectRevert(bytes("OpsPanel: ARBITRATOR unset"));
        addOp.readAddress("OPS_PANEL_UNSET_ARB", "OpsPanel: ARBITRATOR unset");
    }

    function test_applyOneAddRemoveAndIdempotent() public {
        DisputePanel panel = new DisputePanel();
        panel.setOwner(liveTimelock);

        addOp.applyOne(panel, liveTimelock, arb1, true);
        assertTrue(panel.isArbitrator(arb1));
        assertEq(panel.arbitratorCount(), 1);

        addOp.applyOne(panel, liveTimelock, arb1, true);
        assertEq(panel.arbitratorCount(), 1);

        addOp.applyOne(panel, liveTimelock, arb1, false);
        assertFalse(panel.isArbitrator(arb1));
        assertEq(panel.arbitratorCount(), 0);

        addOp.applyOne(panel, liveTimelock, arb1, false);
        assertEq(panel.arbitratorCount(), 0);
    }

    function test_applyOneRejectsZeroAndWrongOwner() public {
        DisputePanel panel = new DisputePanel();
        panel.setOwner(liveTimelock);
        vm.expectRevert(bytes("OpsPanel: zero arbitrator"));
        addOp.applyOne(panel, liveTimelock, address(0), true);

        vm.expectRevert(bytes("not owner"));
        addOp.applyOne(panel, address(0xBEEF), arb1, true);
        assertEq(panel.arbitratorCount(), 0);
    }

    function test_seatOpensDisputeAndRemoveClosesIt() public {
        DisputePanel panel = new DisputePanel();
        panel.setOwner(liveTimelock);

        vm.expectRevert(bytes("panel not seated"));
        panel.openDispute(keccak256("early"), keccak256("subject"), "too soon");

        seatOp.seat(panel, liveTimelock, arb1, arb2, arb3);
        assertEq(panel.arbitratorCount(), 3);
        panel.openDispute(keccak256("seated"), keccak256("subject"), "ok");

        addOp.applyOne(panel, liveTimelock, arb3, false);
        assertEq(panel.arbitratorCount(), 2);
        vm.expectRevert(bytes("panel not seated"));
        panel.openDispute(keccak256("short"), keccak256("subject"), "dropped");
    }

    function test_seatRejectsDuplicatesBeforeWrites() public {
        DisputePanel panel = new DisputePanel();
        panel.setOwner(liveTimelock);
        vm.expectRevert(bytes("OpsPanel: duplicate arbitrator"));
        seatOp.seat(panel, liveTimelock, arb1, arb2, arb1);
        assertEq(panel.arbitratorCount(), 0);
    }
}

/// @notice Reads the live Base Sepolia DisputePanel. No writes, no broadcast.
///         Skips when this process is not already on chain 84532 and
///         `BASE_SEPOLIA_RPC_URL` is unset.
contract DisputePanelLiveReadTest is Test {
    using stdJson for string;

    address internal constant PANEL = 0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb;
    /// @dev Live DisputePanel owner. `pendingOwner()` reverts (immediate `setOwner`).
    address internal constant GOVERNANCE_TIMELOCK = 0xa1abD23Ae5A3aaAfda29345Df64F9Aa45ac6ca33;
    uint256 internal constant BASE_SEPOLIA = 84532;

    OpsDisputePanelAdd internal addOp;
    DisputePanel internal panel;

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
        addOp = new OpsDisputePanelAdd();
        panel = DisputePanel(PANEL);
    }

    function test_forkReadsOwnerAndArbitratorCount() public view {
        assertEq(block.chainid, BASE_SEPOLIA);
        assertGt(PANEL.code.length, 0);
        assertEq(panel.owner(), GOVERNANCE_TIMELOCK);
        uint256 count = panel.arbitratorCount();
        assertEq(count, panel.arbitratorCount());
        assertLt(count, 1024);
        assertEq(panel.PANEL_SIZE(), 3);
    }

    function test_forkLoadPanelMatchesBook() public {
        vm.setEnv("DISPUTE_PANEL", vm.toString(PANEL));
        // Live owner is the governance timelock, so this stays on the calldata path.
        vm.setEnv("NEW_TIMELOCK", vm.toString(GOVERNANCE_TIMELOCK));
        (DisputePanel loaded, address timelock) = addOp.loadPanel();
        assertEq(address(loaded), PANEL);
        assertEq(timelock, GOVERNANCE_TIMELOCK);
        assertEq(loaded.owner(), GOVERNANCE_TIMELOCK);
        assertTrue(addOp.timelockMode(loaded.owner(), timelock));

        address candidate = address(0xBEEF);
        assertFalse(loaded.isArbitrator(candidate));
        uint256 beforeCount = loaded.arbitratorCount();
        addOp.useSalt(keccak256("DisputePanelLiveReadTest.loadPanel"));
        addOp.queueOrApply(loaded, timelock, candidate, true);
        assertFalse(loaded.isArbitrator(candidate));
        assertEq(loaded.arbitratorCount(), beforeCount);
    }
}
