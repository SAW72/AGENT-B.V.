import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hkdfSha256, hmacSha256Hex, sha256Utf8 } from "../sha256.mjs";

function join(parts) {
  return parts.join("");
}

function bytesFrom(parts) {
  const hex = join(parts);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function repeatByte(byte, length) {
  return new Uint8Array(length).fill(byte);
}

describe("sha256 and HMAC known answers", () => {
  it("matches NIST SHA-256 vectors", () => {
    assert.equal(sha256Utf8(""), join([
      "e3b0c442", "98fc1c14", "9afbf4c8", "996fb924", "27ae41e4", "649b934c", "a495991b", "7852b855",
    ]));
    assert.equal(sha256Utf8("abc"), join([
      "ba7816bf", "8f01cfea", "414140de", "5dae2223", "b00361a3", "96177a9c", "b410ff61", "f20015ad",
    ]));
    assert.equal(
      sha256Utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
      join(["248d6a61", "d20638b8", "e5c02693", "0c3e6039", "a33ce459", "64ff2167", "f6ecedd4", "19db06c1"]),
    );
  });

  it("matches RFC 4231 HMAC-SHA-256 vectors", () => {
    const text = new TextEncoder();
    assert.equal(hmacSha256Hex(repeatByte(0x0b, 20), text.encode("Hi There")), join([
      "b0344c61", "d8db3853", "5ca8afce", "af0bf12b", "881dc200", "c9833da7", "26e9376c", "2e32cff7",
    ]));
    assert.equal(hmacSha256Hex(text.encode("Jefe"), text.encode("what do ya want for nothing?")), join([
      "5bdcc146", "bf60754e", "6a042426", "089575c7", "5a003f08", "9d273983", "9dec58b9", "64ec3843",
    ]));
    assert.equal(hmacSha256Hex(repeatByte(0xaa, 20), repeatByte(0xdd, 50)), join([
      "773ea91e", "36800e46", "854db8eb", "d09181a7", "2959098b", "3ef8c122", "d9635514", "ced565fe",
    ]));
  });

  it("matches the RFC 5869 HKDF-SHA-256 vector", () => {
    const okm = hkdfSha256(
      repeatByte(0x0b, 22),
      bytesFrom(["00010203", "04050607", "08090a0b", "0c"]),
      bytesFrom(["f0f1f2f3", "f4f5f6f7", "f8f9"]),
      42,
    );
    const hex = [...okm].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    assert.equal(hex, join([
      "3cb25f25", "faacd57a", "90434f64", "d0362f2a", "2d2d0a90", "cf1a5a4c",
      "5db02d56", "ecc4c5bf", "34007208", "d5b88718", "5865",
    ]));
  });
});
