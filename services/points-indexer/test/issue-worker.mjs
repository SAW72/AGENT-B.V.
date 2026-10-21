import { parentPort, workerData } from "node:worker_threads";
import { openIndexer } from "../src/indexer.mjs";

const indexer = openIndexer({ path: workerData.path });
const result = indexer.issueNonce(workerData.request);
indexer.close();
parentPort.postMessage({ ok: result.ok, reason: result.reason, stored: result.stored });
