import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ENFORCER_OWNER } from "../admin/cancelFlag.mjs";
import { loadReputationConfig, normalizeVersion, validateEnforcerOwner } from "../reputation/reputationConfig.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const BAD_CHECKSUM = "0x41A023Ce2bd5Aee1e1aDF183b448bFF8F3D1EDd1";
const SEPOLIA = new URL("../../config/reputation/sepolia.json", import.meta.url);

function rawCopy() {
  const raw = JSON.parse(readFileSync(SEPOLIA, "utf8"));
  delete raw.enforcer;
  return raw;
}

function ownerKeyExists(raw) {
  const block = raw.enforcer;
  return Boolean(block && typeof block === "object" && !Array.isArray(block) && Object.hasOwn(block, "owner"));
}

function loadError(pattern) {
  return (err) => {
    assert.equal(err.status, 500);
    assert.equal(err.error, "reputation_config_invalid");
    assert.equal(err.field, "enforcer.owner");
    assert.match(err.message, pattern);
    return true;
  };
}

describe("enforcer.owner", () => {
  it("accepts a checksummed non-zero address and rejects zero, a bad checksum, and a non-address", () => {
    assert.equal(validateEnforcerOwner(ENFORCER_OWNER), ENFORCER_OWNER);
    assert.throws(() => validateEnforcerOwner(ZERO), loadError(/non-zero/));
    assert.throws(() => validateEnforcerOwner(BAD_CHECKSUM), loadError(/checksummed/));
    assert.throws(() => validateEnforcerOwner(ENFORCER_OWNER.toLowerCase()), loadError(/checksummed/));
    assert.throws(() => validateEnforcerOwner("not-an-address"), loadError(/0x address/));
    assert.throws(() => validateEnforcerOwner("0x1234"), loadError(/0x address/));
  });

  it("allows an absent enforcer block and rejects a present owner that is not checksummed and non-zero", () => {
    assert.equal(normalizeVersion(rawCopy()).enforcer.owner, null);

    const explicitNull = rawCopy();
    explicitNull.enforcer = null;
    assert.equal(normalizeVersion(explicitNull).enforcer.owner, null);

    const contactOnly = rawCopy();
    contactOnly.enforcer = { public_contact: "@example" };
    assert.equal(normalizeVersion(contactOnly).enforcer.owner, null);

    const good = rawCopy();
    good.enforcer = { owner: ENFORCER_OWNER, public_contact: "@thecryptostewrd on X" };
    assert.equal(normalizeVersion(good).enforcer.owner, ENFORCER_OWNER);

    const malformed = rawCopy();
    malformed.enforcer = "0x41a023Ce2bd5Aee1e1aDF183b448bFF8F3D1EDd1";
    assert.throws(() => normalizeVersion(malformed), loadError(/enforcer block must be an object/));

    for (const [owner, pattern] of [
      [ZERO, /non-zero/],
      [BAD_CHECKSUM, /checksummed/],
      ["not-an-address", /0x address/],
    ]) {
      const raw = rawCopy();
      raw.enforcer = { owner };
      assert.throws(() => normalizeVersion(raw), loadError(pattern));
    }
  });

  it("keeps ENFORCER_OWNER equal to the owner the config supplies when that key exists", () => {
    const raw = JSON.parse(readFileSync(SEPOLIA, "utf8"));
    const supplied = loadReputationConfig().latest.enforcer.owner;
    if (ownerKeyExists(raw)) {
      assert.equal(supplied, raw.enforcer.owner);
      assert.equal(supplied, ENFORCER_OWNER);
    } else {
      assert.equal(supplied, null);
    }

    const fixture = rawCopy();
    fixture.enforcer = { owner: ENFORCER_OWNER };
    assert.equal(normalizeVersion(fixture).enforcer.owner, ENFORCER_OWNER);
    assert.equal(normalizeVersion(fixture).enforcer.owner, validateEnforcerOwner(ENFORCER_OWNER));
  });
});
