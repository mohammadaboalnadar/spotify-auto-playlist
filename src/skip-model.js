"use strict";

/**
 * Skip‑prediction model.
 *
 * For each candidate track the model produces a *skip probability* in [0, 1].
 * Lower is better (less likely to be skipped).
 *
 * The score is a weighted combination of:
 *   1. **Historical skip rate** – how often the user skipped this exact track.
 *   2. **Audio‑feature affinity** – cosine similarity between the candidate's
 *      audio features and a preference vector derived from recent
 *      listens/skips in the current session.
 *   3. **Novelty bonus** – slight boost for tracks with few plays so the model
 *      keeps exploring.
 *
 * Weights are tuned per‑user over time using a simple online gradient step
 * whenever we observe a new skip/listen event.
 */

const FEATURE_KEYS = [
  "danceability",
  "energy",
  "loudness",
  "speechiness",
  "acousticness",
  "instrumentalness",
  "liveness",
  "valence",
  "tempo",
];

/** Normalise loudness (≈ −60..0) and tempo (≈ 0..250) to roughly [0,1]. */
function normalise(features) {
  if (!features) return null;
  return {
    danceability: features.danceability ?? 0,
    energy: features.energy ?? 0,
    loudness: (features.loudness + 60) / 60,
    speechiness: features.speechiness ?? 0,
    acousticness: features.acousticness ?? 0,
    instrumentalness: features.instrumentalness ?? 0,
    liveness: features.liveness ?? 0,
    valence: features.valence ?? 0,
    tempo: (features.tempo ?? 0) / 250,
  };
}

function featureVec(f) {
  const n = normalise(f);
  if (!n) return null;
  return FEATURE_KEYS.map((k) => n[k]);
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function magnitude(v) {
  return Math.sqrt(dot(v, v));
}

function cosineSim(a, b) {
  const d = magnitude(a) * magnitude(b);
  return d === 0 ? 0 : dot(a, b) / d;
}

/** Default model weights. */
const DEFAULT_WEIGHTS = {
  historyWeight: 0.45,
  affinityWeight: 0.40,
  noveltyWeight: 0.15,
  learningRate: 0.05,
};

class SkipModel {
  /**
   * @param {object} [weights] - Override default weights
   */
  constructor(weights) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    /** @type {number[] | null} Preference vector updated during the session */
    this.preferenceVec = null;
    /** How many events contributed to preferenceVec */
    this._prefCount = 0;
  }

  /**
   * Predict the probability of skipping a candidate track.
   *
   * @param {object} opts
   * @param {object|null} opts.features     - Audio features for the candidate
   * @param {{ playCount: number, skipCount: number, avgListenPct: number } | null} opts.stats
   * @returns {number} skipProbability in [0, 1]
   */
  predictSkip({ features, stats }) {
    const { historyWeight, affinityWeight, noveltyWeight } = this.weights;

    // 1. Historical skip rate (default to 0.5 if no history)
    let historyScore = 0.5;
    if (stats && stats.playCount > 0) {
      historyScore = stats.skipCount / stats.playCount;
    }

    // 2. Audio-feature affinity (inverted — high similarity → low skip)
    let affinityScore = 0.5;
    if (this.preferenceVec && features) {
      const vec = featureVec(features);
      if (vec) {
        const sim = cosineSim(this.preferenceVec, vec); // [-1, 1] usually [0,1]
        affinityScore = 1 - (sim + 1) / 2; // map to [0,1] — lower is better
      }
    }

    // 3. Novelty bonus (tracks with fewer plays get a small negative skip boost)
    let noveltyScore = 0.5;
    if (stats) {
      noveltyScore = Math.min(1, stats.playCount / 20); // saturates at 20 plays
    } else {
      noveltyScore = 0; // never played — full novelty bonus
    }

    return (
      historyWeight * historyScore +
      affinityWeight * affinityScore +
      noveltyWeight * noveltyScore
    );
  }

  /**
   * Update the session preference vector after observing an event.
   *
   * If the user *listened* to the track we move the preference vector
   * toward the track's features. If skipped, we move it away.
   *
   * @param {object} features - Audio features of the just-played track
   * @param {boolean} wasSkipped
   */
  updatePreference(features, wasSkipped) {
    const vec = featureVec(features);
    if (!vec) return;

    if (!this.preferenceVec) {
      this.preferenceVec = new Array(FEATURE_KEYS.length).fill(0);
    }

    const direction = wasSkipped ? -1 : 1;
    const lr = this.weights.learningRate;

    for (let i = 0; i < this.preferenceVec.length; i++) {
      this.preferenceVec[i] += direction * lr * vec[i];
    }

    this._prefCount++;
  }

  /**
   * Simple online weight tuning: nudge weights toward directions that would
   * have predicted the observed outcome better.
   *
   * @param {number} predictedSkip - What we predicted
   * @param {boolean} actualSkipped - What actually happened
   */
  tuneWeights(predictedSkip, actualSkipped) {
    const actual = actualSkipped ? 1 : 0;
    const error = actual - predictedSkip;
    const lr = 0.01;

    this.weights.historyWeight += lr * error;
    this.weights.affinityWeight += lr * error;
    this.weights.noveltyWeight -= lr * Math.abs(error);

    // Clamp and re-normalise so they sum to 1
    this.weights.historyWeight = clamp(this.weights.historyWeight, 0.05, 0.9);
    this.weights.affinityWeight = clamp(this.weights.affinityWeight, 0.05, 0.9);
    this.weights.noveltyWeight = clamp(this.weights.noveltyWeight, 0.01, 0.4);

    const sum =
      this.weights.historyWeight +
      this.weights.affinityWeight +
      this.weights.noveltyWeight;
    this.weights.historyWeight /= sum;
    this.weights.affinityWeight /= sum;
    this.weights.noveltyWeight /= sum;

    // Re-clamp after normalization
    this.weights.historyWeight = clamp(this.weights.historyWeight, 0.05, 0.9);
    this.weights.affinityWeight = clamp(this.weights.affinityWeight, 0.05, 0.9);
    this.weights.noveltyWeight = clamp(this.weights.noveltyWeight, 0.01, 0.4);
  }

  /**
   * Initialise the preference vector from historical interactions.
   * Useful at session start to pre-load user preferences.
   *
   * @param {Array<{trackId: string, wasSkipped: boolean}>} interactions
   * @param {Map<string, object>} featuresMap  trackId → audio features
   */
  warmUp(interactions, featuresMap) {
    for (const { trackId, wasSkipped } of interactions) {
      const f = featuresMap.get(trackId);
      if (f) this.updatePreference(f, !!wasSkipped);
    }
  }
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

module.exports = { SkipModel, FEATURE_KEYS, normalise, featureVec, cosineSim };
