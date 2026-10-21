import { readFileSync } from "node:fs";

const text = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
const match = /^CHAIN_ID\s*=\s*"([^"]*)"/m.exec(text);
if (!match) {
  console.error("CHAIN_ID is missing from wrangler.toml");
  process.exit(1);
}
if (match[1] !== "84532") {
  console.error(`CHAIN_ID is ${match[1]}, expected 84532`);
  process.exit(1);
}
if (/^\s*BASE_SEPOLIA_RPC_URL\s*=/m.test(text)) {
  console.error("BASE_SEPOLIA_RPC_URL must not be set in wrangler.toml");
  process.exit(1);
}
console.log("CHAIN_ID 84532");
