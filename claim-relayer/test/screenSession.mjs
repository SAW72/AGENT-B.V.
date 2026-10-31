import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";

export const SCREEN_DOMAIN = "agent-bv.pages.dev";

export function screenSigner() {
  return privateKeyToAccount(generatePrivateKey());
}

export async function postScreen(request, port, action, signer, accountId, headers = {}, spoof = {}) {
  const issued = await request(port, "POST", "/v1/screen/nonce", {}, headers);
  if (issued.status !== 200) return issued;
  const at = new Date();
  const message = createSiweMessage({
    address: signer.address,
    chainId: 84532,
    domain: SCREEN_DOMAIN,
    nonce: issued.json.nonce,
    uri: `https://${SCREEN_DOMAIN}/v1/screen/${action}`,
    version: "1",
    issuedAt: at,
    expirationTime: new Date(at.getTime() + 5 * 60 * 1000),
    requestId: `${action}:${accountId}`,
    statement: "Prove wallet ownership for this screen action.",
  });
  const signature = await signer.signMessage({ message });
  return request(port, "POST", `/v1/screen/${action}`, {
    message,
    signature,
    accountId: spoof.accountId || accountId,
    wallet: spoof.wallet || signer.address,
    nextWallet: spoof.wallet || signer.address,
  }, {
    ...headers,
    ...(spoof.session ? { "x-screen-session": spoof.session } : {}),
  });
}
