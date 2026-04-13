"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { BehaviorDatabase } = require("../src/database");

const TEST_DB_DIR = path.join(__dirname, "..", "data", "test");

describe("BehaviorDatabase", () => {
  let db;
  let testDir;

  beforeEach(() => {
    testDir = path.join(TEST_DB_DIR, `run_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    db = new BehaviorDatabase(`test_user`, testDir);
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

  it("creates the database and tables successfully", () => {
    // If constructor didn't throw, tables were created
    const tables = db.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all()
      .map((r) => r.name);

    assert.ok(tables.includes("track_features"));
    assert.ok(tables.includes("interactions"));
  });

  it("upsertFeatures stores and retrieves audio features", () => {
    const features = [
      {
        id: "track1",
        danceability: 0.8,
        energy: 0.7,
        loudness: -5,
        speechiness: 0.1,
        acousticness: 0.2,
        instrumentalness: 0.0,
        liveness: 0.15,
        valence: 0.6,
        tempo: 120,
      },
    ];

    db.upsertFeatures(features);
    const result = db.getFeatures(["track1"]);

    assert.equal(result.size, 1);
    const f = result.get("track1");
    assert.equal(f.danceability, 0.8);
    assert.equal(f.energy, 0.7);
    assert.equal(f.tempo, 120);
  });

  it("upsertFeatures handles null entries gracefully", () => {
    db.upsertFeatures([null, { id: "t1", danceability: 0.5, energy: 0.5, loudness: -10, speechiness: 0, acousticness: 0, instrumentalness: 0, liveness: 0, valence: 0.5, tempo: 100 }]);
    const result = db.getFeatures(["t1"]);
    assert.equal(result.size, 1);
  });

  it("recordInteraction and getTrackStats work correctly", () => {
    db.recordInteraction({
      trackId: "t1",
      wasSkipped: false,
      listenPct: 0.95,
      sessionId: "s1",
    });
    db.recordInteraction({
      trackId: "t1",
      wasSkipped: true,
      listenPct: 0.1,
      sessionId: "s1",
    });
    db.recordInteraction({
      trackId: "t1",
      wasSkipped: false,
      listenPct: 1.0,
      sessionId: "s1",
    });

    const stats = db.getTrackStats("t1");
    assert.equal(stats.playCount, 3);
    assert.equal(stats.skipCount, 1);
    assert.ok(stats.avgListenPct > 0.6);
  });

  it("getAllTrackStats returns stats for all tracks", () => {
    db.recordInteraction({ trackId: "a", wasSkipped: false, listenPct: 1, sessionId: "s" });
    db.recordInteraction({ trackId: "b", wasSkipped: true, listenPct: 0.1, sessionId: "s" });

    const all = db.getAllTrackStats();
    assert.equal(all.size, 2);
    assert.ok(all.has("a"));
    assert.ok(all.has("b"));
  });

  it("getSessionInteractions returns interactions for the given session", () => {
    db.recordInteraction({ trackId: "t1", wasSkipped: false, listenPct: 1, sessionId: "s1" });
    db.recordInteraction({ trackId: "t2", wasSkipped: true, listenPct: 0.2, sessionId: "s1" });
    db.recordInteraction({ trackId: "t3", wasSkipped: false, listenPct: 0.8, sessionId: "s2" });

    const s1 = db.getSessionInteractions("s1");
    assert.equal(s1.length, 2);

    const s2 = db.getSessionInteractions("s2");
    assert.equal(s2.length, 1);
  });

  it("getFeatures returns empty map for empty array", () => {
    const result = db.getFeatures([]);
    assert.equal(result.size, 0);
  });
});
