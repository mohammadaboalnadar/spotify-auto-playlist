"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  generateCodeVerifier,
  generateCodeChallenge,
  buildAuthorizeUrl,
} = require("../src/auth");

describe("auth – PKCE helpers", () => {
  it("generateCodeVerifier returns a string of the requested length", () => {
    const v = generateCodeVerifier(64);
    assert.equal(typeof v, "string");
    assert.equal(v.length, 64);
  });

  it("generateCodeVerifier default length is 64", () => {
    assert.equal(generateCodeVerifier().length, 64);
  });

  it("generateCodeVerifier only contains unreserved URI characters", () => {
    const v = generateCodeVerifier(128);
    assert.match(v, /^[A-Za-z0-9\-._~]+$/);
  });

  it("generateCodeChallenge produces a base64url string", () => {
    const c = generateCodeChallenge("test_verifier");
    assert.equal(typeof c, "string");
    // base64url has no + / = characters
    assert.doesNotMatch(c, /[+/=]/);
  });

  it("generateCodeChallenge is deterministic", () => {
    const a = generateCodeChallenge("same_verifier");
    const b = generateCodeChallenge("same_verifier");
    assert.equal(a, b);
  });

  it("different verifiers produce different challenges", () => {
    const a = generateCodeChallenge("verifier_a");
    const b = generateCodeChallenge("verifier_b");
    assert.notEqual(a, b);
  });

  it("buildAuthorizeUrl includes all required PKCE parameters", () => {
    const url = buildAuthorizeUrl({
      clientId: "test_client",
      redirectUri: "http://127.0.0.1:3000/callback",
      scopes: ["user-read-playback-state", "playlist-read-private"],
      codeChallenge: "test_challenge",
      state: "test_state",
    });

    assert.ok(url.startsWith("https://accounts.spotify.com/authorize"));
    const params = new URL(url).searchParams;
    assert.equal(params.get("response_type"), "code");
    assert.equal(params.get("client_id"), "test_client");
    assert.equal(params.get("redirect_uri"), "http://127.0.0.1:3000/callback");
    assert.equal(
      params.get("scope"),
      "user-read-playback-state playlist-read-private"
    );
    assert.equal(params.get("code_challenge"), "test_challenge");
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.equal(params.get("state"), "test_state");
  });

  it("buildAuthorizeUrl does not include client_secret", () => {
    const url = buildAuthorizeUrl({
      clientId: "test_client",
      redirectUri: "http://127.0.0.1:3000/callback",
      scopes: [],
      codeChallenge: "c",
      state: "s",
    });
    assert.ok(!url.includes("client_secret"));
  });
});
