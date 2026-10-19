import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { httpsLink, normalizeVersion } from "../reputation/reputationConfig.mjs";

describe("legal notice link", () => {
  it("keeps https and turns every other value into null", () => {
    assert.equal(httpsLink("https://example.com/legal"), "https://example.com/legal");
    assert.equal(httpsLink("http://example.com/legal"), null);
    assert.equal(httpsLink("javascript:alert(1)"), null);
    assert.equal(httpsLink("not a url"), null);
    assert.equal(httpsLink(""), null);
    assert.equal(httpsLink("   "), null);
    assert.equal(httpsLink(null), null);

    const raw = JSON.parse(readFileSync(new URL("../../config/reputation/sepolia.json", import.meta.url), "utf8"));
    raw.effective_from_block = 0;
    raw.disclaimer_links.legal_notice_url = "http://example.com/legal";
    assert.equal(normalizeVersion(raw).disclaimer_links.legal_notice_url, null);
    raw.disclaimer_links.legal_notice_url = "not a url";
    assert.equal(normalizeVersion(raw).disclaimer_links.legal_notice_url, null);
    raw.disclaimer_links.legal_notice_url = "";
    assert.equal(normalizeVersion(raw).disclaimer_links.legal_notice_url, null);
    raw.disclaimer_links.legal_notice_url = "https://example.com/legal";
    assert.equal(normalizeVersion(raw).disclaimer_links.legal_notice_url, "https://example.com/legal");
  });
});
