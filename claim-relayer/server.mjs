import { pathToFileURL } from "node:url";
import { createClaimRelayer } from "./app.mjs";
import { createSepoliaBroadcaster } from "./broadcast.mjs";
import { BOOKED_SEPOLIA_ESCROW, BOOKED_SEPOLIA_ESCROW_START_BLOCK, loadConfig } from "./config.mjs";
import { createAbuseGuard } from "./abuseLimits.mjs";
import { createClaimLog } from "./claimLog.mjs";
import { createRpcEscrowChain, httpRpcRequest } from "./escrowChain.mjs";
import { createFileIntentNonceStore } from "./intentNonceStore.mjs";
import { createKillSwitch } from "./killSwitch.mjs";
import { createNonceStore } from "./nonceStore.mjs";

/**
 * Process entry. The relayer key is passed into the broadcaster only when live
 * submit is allowed. It is not logged. Fixture mode does not read it.
 */
export function startServer(env = process.env) {
  const config = loadConfig(env);
  const killSwitch = createKillSwitch({ initial: config.killSwitchInitial });
  const nonceStore = createNonceStore();
  const claimLog = createClaimLog({ filePath: config.claimLogPath });
  const intentNonces = createFileIntentNonceStore({ filePath: config.intentNoncePath });
  const abuse = createAbuseGuard(config.abuse);
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";
  const chain = createRpcEscrowChain({
    escrowAddress: config.escrowAddress,
    from: config.relayerAddress,
    request: httpRpcRequest(rpcUrl),
  });
  const broadcaster = config.liveSubmit.allowed
    ? createSepoliaBroadcaster({
        rpcUrl,
        privateKey: env.RELAYER_PRIVATE_KEY,
      })
    : null;
  const server = createClaimRelayer({
    config,
    killSwitch,
    nonceStore,
    intentNonces,
    abuse,
    chain,
    claimLog,
    broadcaster,
  });
  const mode = config.liveSubmit.allowed ? "live" : "fixture";
  if (config.escrowRetired) {
    console.error(
      `claim-relayer: configured escrow ${config.escrowAddress} is retired. Submits are disabled. Set ESCROW_ADDRESS to ${config.retiredEscrowCurrent} or clear ESCROW_ADDRESS to use the address book.`,
    );
  }
  server.listen(config.port, config.host, () => {
    console.log(
      `claim-relayer listening on ${config.host}:${config.port} mode=${mode} chainId=${config.chainId} escrowBooked=${config.escrowBooked} escrowStartBlock=${config.escrowStartBlock ?? "unset"} escrowStartBlockSource=${config.escrowStartBlockSource} killSwitch=${killSwitch.isOn()} liveSubmit=${config.liveSubmit.allowed}`,
    );
    if (config.escrowAddress && !config.escrowRetired && config.escrowStartBlockSource === "unset") {
      console.error(
        `claim-relayer: ESCROW_ADDRESS ${config.escrowAddress} is not the booked escrow ${BOOKED_SEPOLIA_ESCROW}. The booked start block ${BOOKED_SEPOLIA_ESCROW_START_BLOCK} was not applied. Set ESCROW_START_BLOCK to a non-negative integer. escrowStartBlock is unset.`,
      );
    }
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    startServer();
  } catch (err) {
    const code = err && err.error;
    const message = err && err.message;
    console.error(code && message && message !== code ? `${code}: ${message}` : code || message || "claim_relayer_config_error");
    process.exit(1);
  }
}
