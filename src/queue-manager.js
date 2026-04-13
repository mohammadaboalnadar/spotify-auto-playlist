"use strict";

const crypto = require("node:crypto");

/**
 * Manages the dynamic playback queue.
 *
 * Responsibilities:
 *  - Accept a pool of candidate tracks (from a playlist).
 *  - Score each track using the SkipModel.
 *  - Maintain a short look-ahead queue (≤ QUEUE_DEPTH) on Spotify.
 *  - React to skip/listen events by re-scoring and updating the queue.
 */
class QueueManager {
  /**
   * @param {object} opts
   * @param {import('./spotify-client').SpotifyClient} opts.spotifyClient
   * @param {import('./database').BehaviorDatabase} opts.db
   * @param {import('./skip-model').SkipModel} opts.model
   */
  constructor({ spotifyClient, db, model }) {
    this.spotify = spotifyClient;
    this.db = db;
    this.model = model;
    /** @type {Array<{track: object, features: object|null}>} candidate pool */
    this.pool = [];
    /** @type {Set<string>} track IDs already queued or played */
    this.played = new Set();
    this.sessionId = crypto.randomUUID();
    this._pollTimer = null;
    this._lastTrackId = null;
    this._lastTrackDurationMs = 0;
    this._lastProgressMs = 0;
    this._queuedNext = null;
  }

  /**
   * Load a playlist, fetch audio features, warm up the model, and start.
   * @param {string} playlistId
   */
  async start(playlistId) {
    // 1. Fetch playlist items (uses /playlists/{id}/items — non-deprecated)
    const items = await this.spotify.getPlaylistItems(playlistId);
    const tracks = items
      .map((i) => i.track)
      // Exclude null tracks (removed/unavailable), local files (no id), and
      // podcast episodes (type === "episode") which cannot be played via the
      // playback API the same way as regular tracks.
      .filter((t) => t && t.id && t.type !== "episode");

    // 2. Fetch audio features (best-effort).
    //    The /audio-features endpoint was deprecated by Spotify in November 2024.
    //    Apps without extended quota mode receive a 403, so we degrade gracefully
    //    and fall back to default scores rather than aborting the session.
    const ids = tracks.map((t) => t.id);
    let features = [];
    try {
      features = await this.spotify.getAudioFeaturesBatch(ids);
    } catch (err) {
      console.warn("Audio features unavailable, scoring will use defaults:", err.message);
    }
    this.db.upsertFeatures(features);
    const featMap = new Map(features.filter(Boolean).map((f) => [f.id, f]));

    // 3. Build pool
    this.pool = tracks.map((t) => ({
      track: t,
      features: featMap.get(t.id) || null,
    }));

    // 4. Warm up model from DB history
    const allStats = this.db.getAllTrackStats();
    const recentInteractions = this.db
      .getSessionInteractions(this.sessionId, 0)
      .length === 0
      ? [...allStats.entries()].slice(-50).map(([trackId, s]) => ({
          trackId,
          wasSkipped: s.skipCount > s.playCount / 2,
        }))
      : this.db.getSessionInteractions(this.sessionId, 50);

    this.model.warmUp(recentInteractions, featMap);

    // 5. Pick the best first track and start playback
    const first = this._pickNext();
    if (!first) throw new Error("No tracks available in the playlist.");

    await this.spotify.startPlayback({ uris: [first.track.uri] });
    this.played.add(first.track.id);
    this._lastTrackId = first.track.id;
    this._lastTrackDurationMs = first.track.duration_ms || 0;

    // 6. Pre-queue the next track
    await this._enqueueNext();

    // 7. Start polling for playback changes
    this._startPolling();

    return {
      sessionId: this.sessionId,
      trackCount: this.pool.length,
      firstTrack: first.track,
    };
  }

  /**
   * Pick the candidate with the lowest predicted skip probability.
   */
  _pickNext() {
    const allStats = this.db.getAllTrackStats();
    let best = null;
    let bestScore = Infinity;

    for (const candidate of this.pool) {
      if (this.played.has(candidate.track.id)) continue;

      const stats = allStats.get(candidate.track.id) || null;
      const score = this.model.predictSkip({
        features: candidate.features,
        stats,
      });

      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return best;
  }

  async _enqueueNext() {
    const next = this._pickNext();
    if (!next) return null;

    await this.spotify.addToQueue(next.track.uri);
    this._queuedNext = next;
    return next;
  }

  /**
   * Called when we detect the track has changed (either by skip or completion).
   * @param {string} newTrackId
   * @param {boolean} wasSkipped
   */
  async _onTrackChange(newTrackId, wasSkipped) {
    const prevId = this._lastTrackId;
    if (prevId) {
      // Record interaction
      this.db.recordInteraction({
        trackId: prevId,
        wasSkipped,
        listenPct: this._lastTrackDurationMs > 0
          ? Math.min(1, this._lastProgressMs / this._lastTrackDurationMs)
          : (wasSkipped ? 0.1 : 1),
        sessionId: this.sessionId,
      });

      // Update model
      const featMap = this.db.getFeatures([prevId]);
      const feat = featMap.get(prevId);
      if (feat) {
        const stats = this.db.getTrackStats(prevId);
        const predicted = this.model.predictSkip({ features: feat, stats });
        this.model.updatePreference(feat, wasSkipped);
        this.model.tuneWeights(predicted, wasSkipped);
      }
    }

    this.played.add(newTrackId);
    this._lastTrackId = newTrackId;
    this._lastTrackDurationMs = 0;
    this._lastProgressMs = 0;

    // Queue next track
    await this._enqueueNext();
  }

  _startPolling(intervalMs = 3000) {
    this._pollTimer = setInterval(async () => {
      try {
        const state = await this.spotify.getPlaybackState();
        if (!state || !state.item) return;

        const currentId = state.item.id;
        const progressMs = state.progress_ms || 0;

        if (currentId && currentId !== this._lastTrackId) {
          // Track changed — figure out if previous was a skip
          // Use stored duration of the *previous* track, not the new one
          const wasSkipped =
            this._lastProgressMs > 0 &&
            this._lastTrackDurationMs > 0 &&
            this._lastProgressMs < this._lastTrackDurationMs * 0.5;
          await this._onTrackChange(currentId, wasSkipped);
        } else {
          this._lastProgressMs = progressMs;
          if (state.item.duration_ms) {
            this._lastTrackDurationMs = state.item.duration_ms;
          }
        }
      } catch {
        // Polling errors are non-fatal; will retry next interval
      }
    }, intervalMs);
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Returns a snapshot of the current queue state for the UI.
   */
  getState() {
    const allStats = this.db.getAllTrackStats();
    const scored = this.pool
      .filter((c) => !this.played.has(c.track.id))
      .map((c) => {
        const stats = allStats.get(c.track.id) || null;
        return {
          track: c.track,
          skipProbability: this.model.predictSkip({
            features: c.features,
            stats,
          }),
        };
      })
      .sort((a, b) => a.skipProbability - b.skipProbability);

    return {
      sessionId: this.sessionId,
      currentTrackId: this._lastTrackId,
      queuedNext: this._queuedNext?.track || null,
      upcoming: scored.slice(0, 10),
      played: [...this.played],
      remaining: scored.length,
    };
  }
}

module.exports = { QueueManager };
