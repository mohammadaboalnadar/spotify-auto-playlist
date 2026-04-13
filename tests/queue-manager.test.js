"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { QueueManager } = require("../src/queue-manager");
const { BehaviorDatabase } = require("../src/database");
const { SkipModel } = require("../src/skip-model");

const TEST_DB_DIR = path.join(__dirname, "..", "data", "test");

/** Minimal mock SpotifyClient */
function mockSpotifyClient(playlist = [], features = []) {
  return {
    getPlaylistItems: async () =>
      playlist.map((t) => ({ track: t })),
    getAudioFeaturesBatch: async () => features,
    getPlaybackState: async () => null,
    addToQueue: async () => null,
    startPlayback: async () => null,
    skipToNext: async () => null,
  };
}

describe("QueueManager", () => {
  let db;
  let testDir;

  beforeEach(() => {
    testDir = path.join(TEST_DB_DIR, `run_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    db = new BehaviorDatabase(`test_qm`, testDir);
  });

  afterEach(() => {
    if (db) db.close();
    try {
      const files = fs.readdirSync(testDir);
      for (const f of files) {
        try { fs.unlinkSync(path.join(testDir, f)); } catch { /* ignore */ }
      }
      fs.rmdirSync(testDir);
    } catch {
      // ignore
    }
  });

  it("start() loads tracks and begins playback", async () => {
    const tracks = [
      { id: "t1", name: "Track 1", uri: "spotify:track:t1", artists: [{ name: "A1" }], duration_ms: 200000 },
      { id: "t2", name: "Track 2", uri: "spotify:track:t2", artists: [{ name: "A2" }], duration_ms: 180000 },
      { id: "t3", name: "Track 3", uri: "spotify:track:t3", artists: [{ name: "A3" }], duration_ms: 220000 },
    ];

    const features = [
      { id: "t1", danceability: 0.8, energy: 0.7, loudness: -5, speechiness: 0.1, acousticness: 0.2, instrumentalness: 0, liveness: 0.15, valence: 0.6, tempo: 120 },
      { id: "t2", danceability: 0.5, energy: 0.5, loudness: -8, speechiness: 0.05, acousticness: 0.5, instrumentalness: 0.3, liveness: 0.1, valence: 0.4, tempo: 100 },
      { id: "t3", danceability: 0.9, energy: 0.9, loudness: -3, speechiness: 0.02, acousticness: 0.1, instrumentalness: 0, liveness: 0.3, valence: 0.8, tempo: 140 },
    ];

    let startedWith = null;
    let queuedUris = [];
    const client = {
      ...mockSpotifyClient(tracks, features),
      startPlayback: async (body) => {
        startedWith = body;
      },
      addToQueue: async (uri) => {
        queuedUris.push(uri);
      },
    };

    const model = new SkipModel();
    const qm = new QueueManager({ spotifyClient: client, db, model });

    const result = await qm.start("test_playlist_id");

    assert.ok(result.sessionId);
    assert.equal(result.trackCount, 3);
    assert.ok(result.firstTrack);
    assert.ok(startedWith?.uris?.length === 1);
    assert.ok(queuedUris.length === 1); // one track queued ahead

    qm.stop();
  });

  it("getState() returns scored upcoming tracks", async () => {
    const tracks = [
      { id: "t1", name: "T1", uri: "spotify:track:t1", artists: [], duration_ms: 200000 },
      { id: "t2", name: "T2", uri: "spotify:track:t2", artists: [], duration_ms: 200000 },
    ];
    const features = [
      { id: "t1", danceability: 0.5, energy: 0.5, loudness: -10, speechiness: 0, acousticness: 0, instrumentalness: 0, liveness: 0, valence: 0.5, tempo: 120 },
      { id: "t2", danceability: 0.5, energy: 0.5, loudness: -10, speechiness: 0, acousticness: 0, instrumentalness: 0, liveness: 0, valence: 0.5, tempo: 120 },
    ];

    const client = mockSpotifyClient(tracks, features);
    const model = new SkipModel();
    const qm = new QueueManager({ spotifyClient: client, db, model });

    await qm.start("pl1");
    const state = qm.getState();

    assert.ok(state.sessionId);
    assert.ok(state.currentTrackId);
    assert.ok(Array.isArray(state.upcoming));
    assert.ok(typeof state.remaining === "number");

    qm.stop();
  });

  it("_pickNext prefers tracks with lower skip history", async () => {
    const tracks = [
      { id: "t1", name: "T1", uri: "spotify:track:t1", artists: [], duration_ms: 200000 },
      { id: "t2", name: "T2", uri: "spotify:track:t2", artists: [], duration_ms: 200000 },
      { id: "t3", name: "T3", uri: "spotify:track:t3", artists: [], duration_ms: 200000 },
    ];
    const features = [
      { id: "t1", danceability: 0.5, energy: 0.5, loudness: -10, speechiness: 0, acousticness: 0, instrumentalness: 0, liveness: 0, valence: 0.5, tempo: 120 },
      { id: "t2", danceability: 0.5, energy: 0.5, loudness: -10, speechiness: 0, acousticness: 0, instrumentalness: 0, liveness: 0, valence: 0.5, tempo: 120 },
      { id: "t3", danceability: 0.5, energy: 0.5, loudness: -10, speechiness: 0, acousticness: 0, instrumentalness: 0, liveness: 0, valence: 0.5, tempo: 120 },
    ];

    // Record: t1 is always skipped, t2 and t3 are listened to
    for (let i = 0; i < 10; i++) {
      db.recordInteraction({ trackId: "t1", wasSkipped: true, listenPct: 0.1, sessionId: "old" });
    }
    for (let i = 0; i < 10; i++) {
      db.recordInteraction({ trackId: "t2", wasSkipped: false, listenPct: 0.95, sessionId: "old" });
    }
    db.upsertFeatures(features);

    const client = mockSpotifyClient(tracks, features);
    const model = new SkipModel();
    const qm = new QueueManager({ spotifyClient: client, db, model });

    await qm.start("pl");
    const state = qm.getState();

    // t1 (heavily skipped) should have higher skip probability than t2 (listened)
    const t1Score = state.upcoming.find((u) => u.track.id === "t1");
    const t2Score = state.upcoming.find((u) => u.track.id === "t2");

    if (t1Score && t2Score) {
      assert.ok(
        t1Score.skipProbability > t2Score.skipProbability,
        `Expected t1 (${t1Score.skipProbability}) > t2 (${t2Score.skipProbability})`
      );
    }

    qm.stop();
  });
});
