// Refuse to run the agent with anything but a function-call key that is
// scoped to the policy contract and limited to `request_payment`.

/**
 * @param {object} accessKey RPC `view_access_key` result ({ permission, nonce, ... })
 * @param {string} policyId expected receiver_id
 */
export function assertFunctionCallOnly(accessKey, policyId) {
  const perm = accessKey?.permission;
  if (perm === 'FullAccess' || perm?.FullAccess !== undefined) {
    throw new Error('refusing to run: the agent key is a full-access key');
  }
  const fc = perm?.FunctionCall;
  if (!fc) throw new Error('refusing to run: unknown access key permission');
  if (fc.receiver_id !== policyId) {
    throw new Error(`refusing to run: key is scoped to ${fc.receiver_id}, expected ${policyId}`);
  }
  const methods = fc.method_names || [];
  if (methods.length !== 1 || methods[0] !== 'request_payment') {
    throw new Error('refusing to run: key must be limited to request_payment only');
  }
  return fc;
}
