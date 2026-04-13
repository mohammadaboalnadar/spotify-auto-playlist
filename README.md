# Spotify Auto-Playlist

A dynamic shuffle queue for Spotify that learns your listening behaviour to minimise skips. Feed it a playlist and it builds a smart queue — tracks you're most likely to enjoy play first, and the model adapts in real time as you skip or listen.

## Features

- **Authorization Code with PKCE** — secure OAuth without exposing secrets
- **Skip-prediction model** — combines historical skip rate, audio-feature affinity, and novelty to score every candidate track
- **Persistent learning** — a per-user SQLite database stores interactions across sessions so the model improves over time
- **Session adaptation** — after one or two skips the preference vector shifts and the upcoming queue re-orders itself
- **Exponential back-off** — respects Spotify's `Retry-After` header on HTTP 429 responses
- **Proper error handling** — Spotify API errors surface as readable messages

## Prerequisites

| Requirement | Notes |
|---|---|
| [Node.js](https://nodejs.org/) ≥ 22.5 | Uses the built-in `node:sqlite` module — no native compilation required |
| A **Spotify Premium** account | Playback control requires Premium |
| A registered [Spotify App](https://developer.spotify.com/dashboard) | Set the redirect URI to `http://127.0.0.1:3000/callback` |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/mohammadaboalnadar/spotify-auto-playlist.git
cd spotify-auto-playlist

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
#    Edit .env and set SPOTIFY_CLIENT_ID to your app's client ID.

# 4. Run
npm start
#    Open http://127.0.0.1:3000 in your browser.
```

## How It Works

1. **Log in** — the app redirects you through Spotify's PKCE flow (no client secret needed).
2. **Paste a playlist URL** and click **Start Smart Shuffle**.
3. The server fetches playlist items via `GET /playlists/{id}/items` and their audio features.
4. The **SkipModel** scores each track:
   - *Historical skip rate* — how often you've skipped this exact track.
   - *Audio-feature affinity* — cosine similarity between the track and a preference vector built from your recent listens/skips.
   - *Novelty bonus* — a small boost for tracks you haven't heard often, to keep exploring.
5. The track with the **lowest skip probability** is played first, and the next-best is pre-queued.
6. A poller watches your playback state. When a track finishes or is skipped, the interaction is recorded, the model updates, and a new track is queued.
7. All interactions are stored in a local SQLite database (`data/<userId>.sqlite`) so the model carries learning across sessions.

## Project Structure

```
src/
  auth.js            PKCE auth helpers (verifier, challenge, token exchange/refresh)
  spotify-client.js  Spotify Web API client with token refresh & exponential backoff
  database.js        SQLite persistence for audio features & user interactions
  skip-model.js      Skip-probability prediction & online weight tuning
  queue-manager.js   Dynamic queue: scoring, playback polling, event handling
  server.js          Express server tying auth, API, and queue together
  public/            Frontend (HTML, CSS, JS)
tests/               Node.js built-in test runner
```

## Running Tests

```bash
npm test
```

## Scopes Requested

Only the minimum scopes needed:

| Scope | Reason |
|---|---|
| `user-read-playback-state` | Monitor current track / detect skips |
| `user-modify-playback-state` | Start playback & add to queue |
| `user-read-recently-played` | Warm up the model at session start |
| `playlist-read-private` | Read the user's private playlists |
| `playlist-read-collaborative` | Read collaborative playlists |

## Attribution

Music content is provided by [Spotify](https://www.spotify.com). This application is not affiliated with or endorsed by Spotify AB.