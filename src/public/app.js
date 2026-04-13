/* ── Spotify Auto-Playlist – Frontend ── */
"use strict";

let sessionId = null;
let pollTimer = null;

const loginSection = document.getElementById("login-section");
const mainSection = document.getElementById("main-section");
const loginBtn = document.getElementById("login-btn");
const startBtn = document.getElementById("start-btn");
const stopBtn = document.getElementById("stop-btn");
const playlistInput = document.getElementById("playlist-input");
const welcomeMsg = document.getElementById("welcome-msg");
const nowPlaying = document.getElementById("now-playing");
const currentTrack = document.getElementById("current-track");
const queueSection = document.getElementById("queue-section");
const queueList = document.getElementById("queue-list");
const remainingCount = document.getElementById("remaining-count");
const errorBox = document.getElementById("error-box");

/* ── Helpers ── */

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove("hidden");
  setTimeout(() => errorBox.classList.add("hidden"), 8000);
}

function headers() {
  return { "Content-Type": "application/json", "X-Session-Id": sessionId };
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: headers() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

function extractPlaylistId(input) {
  const trimmed = input.trim();
  // Handle full URLs: https://open.spotify.com/playlist/<id>?...
  const match = trimmed.match(/playlist[/:]([A-Za-z0-9]+)/);
  return match ? match[1] : trimmed;
}

function formatTrack(t) {
  if (!t) return "—";
  const artists = (t.artists || []).map((a) => a.name).join(", ");
  return `${t.name} — ${artists}`;
}

/* ── Init: check URL params for session ── */

(function init() {
  const params = new URLSearchParams(window.location.search);
  const sid = params.get("session");
  const user = params.get("user");

  if (sid) {
    sessionId = sid;
    loginSection.classList.add("hidden");
    mainSection.classList.remove("hidden");
    welcomeMsg.textContent = `Welcome, ${user || "listener"}!`;
    // Clean URL
    window.history.replaceState({}, "", "/");
  }
})();

/* ── Event listeners ── */

loginBtn.addEventListener("click", async () => {
  try {
    const data = await fetch("/auth/login").then((r) => r.json());
    window.location.href = data.url;
  } catch (err) {
    showError("Failed to start login: " + err.message);
  }
});

startBtn.addEventListener("click", async () => {
  const playlistId = extractPlaylistId(playlistInput.value);
  if (!playlistId) {
    showError("Please enter a playlist URL or ID.");
    return;
  }

  startBtn.disabled = true;
  startBtn.textContent = "Starting…";

  try {
    const result = await api("/api/start", {
      method: "POST",
      body: JSON.stringify({ playlistId }),
    });

    nowPlaying.classList.remove("hidden");
    currentTrack.textContent = formatTrack(result.firstTrack);
    queueSection.classList.remove("hidden");
    stopBtn.classList.remove("hidden");

    // Start polling the queue
    pollQueue();
    pollTimer = setInterval(pollQueue, 4000);
  } catch (err) {
    showError(err.message);
  } finally {
    startBtn.disabled = false;
    startBtn.textContent = "Start Smart Shuffle";
  }
});

stopBtn.addEventListener("click", async () => {
  try {
    await api("/api/stop", { method: "POST" });
  } catch {
    // ignore
  }
  clearInterval(pollTimer);
  nowPlaying.classList.add("hidden");
  queueSection.classList.add("hidden");
  stopBtn.classList.add("hidden");
});

async function pollQueue() {
  try {
    const state = await api("/api/queue");

    if (state.currentTrackId) {
      const upcoming = state.upcoming || [];
      const current = upcoming.find(
        (u) => u.track.id === state.currentTrackId
      );
      if (state.queuedNext) {
        currentTrack.textContent = formatTrack(
          state.upcoming.find(
            (u) => u.track?.id === state.currentTrackId
          )?.track || state.queuedNext
        );
      }
    }

    queueList.innerHTML = "";
    for (const item of (state.upcoming || []).slice(0, 10)) {
      const li = document.createElement("li");
      li.textContent = `${formatTrack(item.track)}  (skip prob: ${(
        item.skipProbability * 100
      ).toFixed(1)}%)`;
      queueList.appendChild(li);
    }

    remainingCount.textContent = `${state.remaining} tracks remaining in pool`;
  } catch {
    // non-fatal
  }
}
