"use strict";

const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");

const {
  generateCodeVerifier,
  generateCodeChallenge,
  buildAuthorizeUrl,
  exchangeCode,
} = require("./auth");
const { SpotifyClient } = require("./spotify-client");
const { BehaviorDatabase } = require("./database");
const { SkipModel } = require("./skip-model");
const { QueueManager } = require("./queue-manager");

/* ── Configuration ── */

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REDIRECT_URI =
  process.env.REDIRECT_URI || "http://127.0.0.1:3000/callback";
const PORT = parseInt(process.env.PORT || "3000", 10);

// Minimum scopes required for the features we use
const SCOPES = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-recently-played",
  "playlist-read-private",
  "playlist-read-collaborative",
];

if (!CLIENT_ID) {
  console.error(
    "Missing SPOTIFY_CLIENT_ID. Copy .env.example to .env and fill in your client ID."
  );
  process.exit(1);
}

/* ── App bootstrap ── */

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/**
 * Minimal in-memory session store.
 * In production this should be backed by a persistent store.
 * @type {Map<string, object>}
 */
const sessions = new Map();

function getSession(req) {
  const sid = req.headers["x-session-id"];
  return sid ? sessions.get(sid) : undefined;
}

/* ── Auth routes ── */

/**
 * GET /auth/login
 * Generates PKCE params, stores them, and returns the Spotify auth URL.
 */
app.get("/auth/login", (_req, res) => {
  const state = crypto.randomUUID();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // Store PKCE params keyed by state so the callback can look them up
  sessions.set(`pkce:${state}`, { codeVerifier });

  const url = buildAuthorizeUrl({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    codeChallenge,
    state,
  });

  res.json({ url, state });
});

/**
 * GET /callback?code=...&state=...
 * Exchanges the authorization code for tokens and creates a session.
 */
app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).send(`Authorization error: ${error}`);
  }

  const pkce = sessions.get(`pkce:${state}`);
  if (!pkce) {
    return res.status(400).send("Invalid or expired state parameter.");
  }
  sessions.delete(`pkce:${state}`);

  try {
    const tokens = await exchangeCode({
      clientId: CLIENT_ID,
      code,
      redirectUri: REDIRECT_URI,
      codeVerifier: pkce.codeVerifier,
    });

    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + tokens.expires_in * 1000;

    const client = new SpotifyClient({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      clientId: CLIENT_ID,
      onTokenRefresh: (t) => {
        const s = sessions.get(sessionId);
        if (s) {
          s.accessToken = t.access_token;
          if (t.refresh_token) s.refreshToken = t.refresh_token;
          s.expiresAt = Date.now() + t.expires_in * 1000;
        }
      },
    });

    const me = await client.getMe();

    sessions.set(sessionId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt,
      userId: me.id,
      displayName: me.display_name,
      client,
    });

    // Redirect to frontend with session info
    res.redirect(`/?session=${sessionId}&user=${encodeURIComponent(me.display_name || me.id)}`);
  } catch (err) {
    console.error("Callback error:", err);
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

/* ── API routes (require authenticated session) ── */

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: "Not authenticated. Please log in." });
  }
  req.session = session;
  next();
}

/** GET /api/me */
app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    userId: req.session.userId,
    displayName: req.session.displayName,
  });
});

/** POST /api/start  { playlistId } — start smart shuffle */
app.post("/api/start", requireAuth, async (req, res) => {
  const { playlistId } = req.body;
  if (!playlistId) {
    return res.status(400).json({ error: "playlistId is required." });
  }

  try {
    const db = new BehaviorDatabase(req.session.userId);
    const model = new SkipModel();
    const qm = new QueueManager({
      spotifyClient: req.session.client,
      db,
      model,
    });

    const result = await qm.start(playlistId);

    // Store QueueManager on session so we can query / stop it
    req.session.queueManager = qm;
    req.session.db = db;

    res.json(result);
  } catch (err) {
    console.error("Start error:", err);
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** GET /api/queue — current queue state */
app.get("/api/queue", requireAuth, (req, res) => {
  const qm = req.session.queueManager;
  if (!qm) {
    return res.status(400).json({ error: "No active session. Start playback first." });
  }
  res.json(qm.getState());
});

/** POST /api/stop — stop the smart shuffle */
app.post("/api/stop", requireAuth, (req, res) => {
  const qm = req.session.queueManager;
  if (qm) {
    qm.stop();
    req.session.queueManager = null;
  }
  if (req.session.db) {
    req.session.db.close();
    req.session.db = null;
  }
  res.json({ stopped: true });
});

/* ── Start server ── */

if (require.main === module) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Spotify Auto-Playlist running at http://127.0.0.1:${PORT}`);
  });
}

module.exports = { app };
