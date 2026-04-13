"use strict";

const crypto = require("node:crypto");

/**
 * Generates a cryptographically random string used as the PKCE code_verifier.
 * @param {number} [length=64] - Length between 43 and 128 (inclusive).
 * @returns {string}
 */
function generateCodeVerifier(length = 64) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const maxValid = 256 - (256 % chars.length); // rejection threshold
  const bytes = crypto.randomBytes(length * 2); // over-provision for rejects
  let verifier = "";
  let i = 0;
  while (verifier.length < length) {
    if (i >= bytes.length) {
      // Very unlikely: refill the buffer
      throw new Error("Insufficient random bytes for code verifier");
    }
    if (bytes[i] < maxValid) {
      verifier += chars[bytes[i] % chars.length];
    }
    i++;
  }
  return verifier;
}

/**
 * Derives the S256 code_challenge from a code_verifier.
 * @param {string} verifier
 * @returns {string} base64url-encoded SHA-256 hash
 */
function generateCodeChallenge(verifier) {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

/**
 * Builds the Spotify authorization URL for the PKCE flow.
 *
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.redirectUri
 * @param {string[]} opts.scopes
 * @param {string} opts.codeChallenge
 * @param {string} opts.state - Random state for CSRF protection
 * @returns {string} Full authorization URL
 */
function buildAuthorizeUrl({ clientId, redirectUri, scopes, codeChallenge, state }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: scopes.join(" "),
    redirect_uri: redirectUri,
    code_challenge_method: "S256",
    code_challenge: codeChallenge,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

/**
 * Exchanges an authorization code for tokens using the PKCE flow.
 *
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.code - Authorization code from the callback
 * @param {string} opts.redirectUri
 * @param {string} opts.codeVerifier
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number, token_type: string}>}
 */
async function exchangeCode({ clientId, code, redirectUri, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Token exchange failed (${res.status}): ${err.error_description || err.error || res.statusText}`
    );
  }
  return res.json();
}

/**
 * Refreshes an access token using a refresh token (PKCE flow — no client_secret needed).
 *
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.refreshToken
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number, token_type: string}>}
 */
async function refreshAccessToken({ clientId, refreshToken }) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Token refresh failed (${res.status}): ${err.error_description || err.error || res.statusText}`
    );
  }
  return res.json();
}

module.exports = {
  generateCodeVerifier,
  generateCodeChallenge,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
};
