"use strict";

/**
 * Spotify Web API client with automatic token refresh, exponential backoff
 * on HTTP 429, and structured error handling.
 */
class SpotifyClient {
  /**
   * @param {object} opts
   * @param {string} opts.accessToken
   * @param {string} opts.refreshToken
   * @param {number} opts.expiresAt - Unix timestamp (ms) when the access token expires
   * @param {string} opts.clientId
   * @param {(tokens: {access_token: string, refresh_token: string, expires_in: number}) => void} opts.onTokenRefresh
   */
  constructor({ accessToken, refreshToken, expiresAt, clientId, onTokenRefresh }) {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.expiresAt = expiresAt;
    this.clientId = clientId;
    this.onTokenRefresh = onTokenRefresh;
    this._refreshPromise = null;
  }

  /**
   * Ensures the access token is still valid, refreshing if needed.
   */
  async _ensureToken() {
    if (Date.now() < this.expiresAt - 60_000) return; // 1-min buffer
    if (this._refreshPromise) {
      await this._refreshPromise;
      return;
    }
    this._refreshPromise = this._doRefresh();
    try {
      await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  async _doRefresh() {
    const { refreshAccessToken } = require("./auth");
    const tokens = await refreshAccessToken({
      clientId: this.clientId,
      refreshToken: this.refreshToken,
    });
    this.accessToken = tokens.access_token;
    if (tokens.refresh_token) this.refreshToken = tokens.refresh_token;
    this.expiresAt = Date.now() + tokens.expires_in * 1000;
    if (this.onTokenRefresh) this.onTokenRefresh(tokens);
  }

  /**
   * Makes an authenticated request with automatic retry on 429.
   * Implements exponential backoff respecting the Retry-After header.
   *
   * @param {string} path - Spotify API path (e.g. "/me")
   * @param {object} [options]
   * @param {string} [options.method="GET"]
   * @param {object} [options.body]
   * @param {URLSearchParams|object} [options.query]
   * @param {number} [options.maxRetries=5]
   * @returns {Promise<any>}
   */
  async request(path, options = {}) {
    const { method = "GET", body, query, maxRetries = 5 } = options;

    await this._ensureToken();

    let url = `https://api.spotify.com/v1${path}`;
    if (query) {
      const params =
        query instanceof URLSearchParams
          ? query
          : new URLSearchParams(Object.entries(query).filter(([, v]) => v != null));
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const headers = { Authorization: `Bearer ${this.accessToken}` };
      const fetchOpts = { method, headers };
      if (body) {
        headers["Content-Type"] = "application/json";
        fetchOpts.body = JSON.stringify(body);
      }

      const res = await fetch(url, fetchOpts);

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get("Retry-After") || "1", 10);
        const backoff = retryAfter * 1000 * Math.pow(2, attempt);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      if (res.status === 204) return null;

      if (!res.ok) {
        const errorBody = await res.json().catch(() => ({}));
        const msg =
          errorBody?.error?.message || errorBody?.error || res.statusText;
        const err = new Error(`Spotify API error ${res.status}: ${msg}`);
        err.status = res.status;
        err.spotifyError = errorBody;
        throw err;
      }

      return res.json();
    }

    throw new Error("Spotify API: max retries exceeded (429)");
  }

  /* ─── Convenience methods matching OpenAPI spec ─── */

  /** GET /me */
  getMe() {
    return this.request("/me");
  }

  /** GET /playlists/{playlist_id} */
  getPlaylist(playlistId, fields) {
    return this.request(`/playlists/${playlistId}`, {
      query: fields ? { fields } : undefined,
    });
  }

  /**
   * GET /playlists/{playlist_id}/items  (non-deprecated endpoint)
   * Pages through all items automatically.
   */
  async getPlaylistItems(playlistId) {
    const items = [];
    let url = `/playlists/${playlistId}/items`;
    // Include `type` so callers can distinguish tracks from podcast episodes
    const FIELDS = "items(track(id,name,uri,artists,album,duration_ms,type)),next";
    let query = { limit: "100", fields: FIELDS };

    while (url) {
      const data = await this.request(url, { query });
      if (data?.items) items.push(...data.items);

      if (data?.next) {
        // next is an absolute URL – extract path + query.
        // Spotify does not echo the `fields` param in the next URL, so
        // we re-apply it manually to keep every page consistently filtered.
        const parsed = new URL(data.next);
        url = parsed.pathname.replace("/v1", "");
        query = { ...Object.fromEntries(parsed.searchParams), fields: FIELDS };
      } else {
        url = null;
      }
    }

    return items;
  }

  /**
   * GET /audio-features  (batch, max 100 ids)
   * @param {string[]} ids
   */
  async getAudioFeaturesBatch(ids) {
    const allFeatures = [];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const data = await this.request("/audio-features", {
        query: { ids: batch.join(",") },
      });
      if (data?.audio_features) allFeatures.push(...data.audio_features);
    }
    return allFeatures;
  }

  /** GET /me/player */
  getPlaybackState() {
    return this.request("/me/player");
  }

  /** POST /me/player/queue?uri={uri} */
  addToQueue(uri) {
    return this.request("/me/player/queue", {
      method: "POST",
      query: { uri },
    });
  }

  /** POST /me/player/next */
  skipToNext() {
    return this.request("/me/player/next", { method: "POST" });
  }

  /** PUT /me/player/play */
  startPlayback(body) {
    return this.request("/me/player/play", { method: "PUT", body });
  }

  /** GET /me/player/recently-played */
  getRecentlyPlayed(limit = 50) {
    return this.request("/me/player/recently-played", {
      query: { limit: String(limit) },
    });
  }
}

module.exports = { SpotifyClient };
