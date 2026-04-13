"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { SpotifyClient } = require("../src/spotify-client");

describe("SpotifyClient – construction", () => {
  it("stores provided tokens and config", () => {
    const client = new SpotifyClient({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000,
      clientId: "cid",
      onTokenRefresh: () => {},
    });

    assert.equal(client.accessToken, "at");
    assert.equal(client.refreshToken, "rt");
    assert.equal(client.clientId, "cid");
  });
});

describe("SpotifyClient – _ensureToken", () => {
  it("does not refresh when token is still valid", async () => {
    let refreshed = false;
    const client = new SpotifyClient({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000,
      clientId: "cid",
      onTokenRefresh: () => {
        refreshed = true;
      },
    });

    await client._ensureToken();
    assert.equal(refreshed, false);
  });
});

describe("SpotifyClient – request error handling", () => {
  it("throws a descriptive error on non-429 failures", async () => {
    // Mock fetch globally for this test
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Map(),
      json: async () => ({ error: { message: "Insufficient scope" } }),
    });

    const client = new SpotifyClient({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000,
      clientId: "cid",
    });

    try {
      await client.request("/me");
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("403"));
      assert.ok(err.message.includes("Insufficient scope"));
      assert.equal(err.status, 403);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null for 204 responses", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => ({
      ok: true,
      status: 204,
      headers: new Map(),
    });

    const client = new SpotifyClient({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000,
      clientId: "cid",
    });

    try {
      const result = await client.request("/me/player/next", {
        method: "POST",
      });
      assert.equal(result, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries on 429 with exponential backoff", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          ok: false,
          status: 429,
          headers: new Map([["Retry-After", "0"]]),
          json: async () => ({}),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ id: "user123" }),
      };
    };

    const client = new SpotifyClient({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 3600_000,
      clientId: "cid",
    });

    try {
      const result = await client.request("/me");
      assert.equal(result.id, "user123");
      assert.equal(callCount, 3); // 2 retries + 1 success
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
