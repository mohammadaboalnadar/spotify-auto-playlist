"use strict";

const Database = require("better-sqlite3");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_DB_DIR = path.join(__dirname, "..", "data");

/**
 * Persistent SQLite store for user listening behaviour.
 *
 * Tables:
 *  - track_features: audio features keyed by track id
 *  - interactions: per-play records (skip or listen)
 */
class BehaviorDatabase {
  /**
   * @param {string} userId  Spotify user id (used as file name)
   * @param {string} [dbDir] Directory to store SQLite files
   */
  constructor(userId, dbDir = DEFAULT_DB_DIR) {
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, `${userId}.sqlite`);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this._migrate();
  }

  _migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS track_features (
        track_id      TEXT PRIMARY KEY,
        danceability  REAL,
        energy        REAL,
        loudness      REAL,
        speechiness   REAL,
        acousticness  REAL,
        instrumentalness REAL,
        liveness      REAL,
        valence       REAL,
        tempo         REAL
      );

      CREATE TABLE IF NOT EXISTS interactions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id      TEXT NOT NULL,
        played_at     TEXT NOT NULL DEFAULT (datetime('now')),
        was_skipped   INTEGER NOT NULL DEFAULT 0,
        listen_pct    REAL NOT NULL DEFAULT 0,
        session_id    TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_interactions_track
        ON interactions(track_id);
      CREATE INDEX IF NOT EXISTS idx_interactions_session
        ON interactions(session_id);
    `);
  }

  /**
   * Upsert audio features for a batch of tracks.
   * @param {Array<{id: string} & Record<string, number>>} featuresList
   */
  upsertFeatures(featuresList) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO track_features
        (track_id, danceability, energy, loudness, speechiness,
         acousticness, instrumentalness, liveness, valence, tempo)
      VALUES
        (@id, @danceability, @energy, @loudness, @speechiness,
         @acousticness, @instrumentalness, @liveness, @valence, @tempo)
    `);
    const tx = this.db.transaction((list) => {
      for (const f of list) {
        if (!f) continue;
        stmt.run({
          id: f.id,
          danceability: f.danceability ?? 0,
          energy: f.energy ?? 0,
          loudness: f.loudness ?? 0,
          speechiness: f.speechiness ?? 0,
          acousticness: f.acousticness ?? 0,
          instrumentalness: f.instrumentalness ?? 0,
          liveness: f.liveness ?? 0,
          valence: f.valence ?? 0,
          tempo: f.tempo ?? 0,
        });
      }
    });
    tx(featuresList);
  }

  /**
   * Record an interaction (play or skip).
   * @param {object} opts
   * @param {string} opts.trackId
   * @param {boolean} opts.wasSkipped
   * @param {number} opts.listenPct  0–1 fraction of track listened
   * @param {string} opts.sessionId
   */
  recordInteraction({ trackId, wasSkipped, listenPct, sessionId }) {
    this.db.prepare(`
      INSERT INTO interactions (track_id, was_skipped, listen_pct, session_id)
      VALUES (?, ?, ?, ?)
    `).run(trackId, wasSkipped ? 1 : 0, listenPct, sessionId);
  }

  /**
   * Get aggregated stats for a track.
   * @param {string} trackId
   * @returns {{ playCount: number, skipCount: number, avgListenPct: number } | null}
   */
  getTrackStats(trackId) {
    return this.db.prepare(`
      SELECT
        COUNT(*)                             AS playCount,
        SUM(was_skipped)                     AS skipCount,
        AVG(listen_pct)                      AS avgListenPct
      FROM interactions
      WHERE track_id = ?
    `).get(trackId) || null;
  }

  /**
   * Get all track stats as a map.
   * @returns {Map<string, {playCount: number, skipCount: number, avgListenPct: number}>}
   */
  getAllTrackStats() {
    const rows = this.db.prepare(`
      SELECT
        track_id                             AS trackId,
        COUNT(*)                             AS playCount,
        SUM(was_skipped)                     AS skipCount,
        AVG(listen_pct)                      AS avgListenPct
      FROM interactions
      GROUP BY track_id
    `).all();
    const map = new Map();
    for (const r of rows) map.set(r.trackId, r);
    return map;
  }

  /**
   * Get audio features for given track ids.
   * @param {string[]} ids
   * @returns {Map<string, object>}
   */
  getFeatures(ids) {
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT * FROM track_features WHERE track_id IN (${placeholders})`
    ).all(...ids);
    const map = new Map();
    for (const r of rows) map.set(r.track_id, r);
    return map;
  }

  /**
   * Returns the most recent interactions in the current session.
   * @param {string} sessionId
   * @param {number} [limit=20]
   */
  getSessionInteractions(sessionId, limit = 20) {
    return this.db.prepare(`
      SELECT track_id AS trackId, was_skipped AS wasSkipped, listen_pct AS listenPct
      FROM interactions
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(sessionId, limit);
  }

  close() {
    this.db.close();
  }
}

module.exports = { BehaviorDatabase };
