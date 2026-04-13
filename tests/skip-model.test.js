"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  SkipModel,
  featureVec,
  cosineSim,
  normalise,
  FEATURE_KEYS,
} = require("../src/skip-model");

const SAMPLE_FEATURES = {
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
};

const SAMPLE_FEATURES_2 = {
  id: "track2",
  danceability: 0.3,
  energy: 0.9,
  loudness: -2,
  speechiness: 0.05,
  acousticness: 0.1,
  instrumentalness: 0.7,
  liveness: 0.4,
  valence: 0.2,
  tempo: 180,
};

describe("skip-model – normalise", () => {
  it("normalises loudness and tempo to approximately [0,1]", () => {
    const n = normalise(SAMPLE_FEATURES);
    assert.ok(n.loudness >= 0 && n.loudness <= 1.1);
    assert.ok(n.tempo >= 0 && n.tempo <= 1.1);
  });

  it("returns null for null input", () => {
    assert.equal(normalise(null), null);
  });
});

describe("skip-model – featureVec", () => {
  it("returns an array of length equal to FEATURE_KEYS", () => {
    const v = featureVec(SAMPLE_FEATURES);
    assert.equal(v.length, FEATURE_KEYS.length);
  });

  it("returns null for null input", () => {
    assert.equal(featureVec(null), null);
  });
});

describe("skip-model – cosineSim", () => {
  it("identical vectors have cosine similarity of 1", () => {
    const v = featureVec(SAMPLE_FEATURES);
    assert.ok(Math.abs(cosineSim(v, v) - 1) < 0.001);
  });

  it("different vectors have similarity < 1", () => {
    const a = featureVec(SAMPLE_FEATURES);
    const b = featureVec(SAMPLE_FEATURES_2);
    assert.ok(cosineSim(a, b) < 1);
  });
});

describe("SkipModel – predictSkip", () => {
  it("returns 0.5-ish for a track with no history and no preference", () => {
    const model = new SkipModel();
    const score = model.predictSkip({ features: SAMPLE_FEATURES, stats: null });
    // With default weights: 0.45*0.5 + 0.40*0.5 + 0.15*0 = 0.425
    assert.ok(score >= 0 && score <= 1);
  });

  it("frequently-skipped tracks get higher skip probability", () => {
    const model = new SkipModel();
    const lowSkip = model.predictSkip({
      features: SAMPLE_FEATURES,
      stats: { playCount: 10, skipCount: 1, avgListenPct: 0.9 },
    });
    const highSkip = model.predictSkip({
      features: SAMPLE_FEATURES,
      stats: { playCount: 10, skipCount: 9, avgListenPct: 0.1 },
    });
    assert.ok(highSkip > lowSkip);
  });

  it("returns a value between 0 and 1", () => {
    const model = new SkipModel();
    for (let i = 0; i < 20; i++) {
      const score = model.predictSkip({
        features: SAMPLE_FEATURES,
        stats: { playCount: i, skipCount: Math.floor(i / 2), avgListenPct: 0.5 },
      });
      assert.ok(score >= 0 && score <= 1, `Score ${score} out of range`);
    }
  });
});

describe("SkipModel – updatePreference", () => {
  it("moves preference vector toward listened tracks", () => {
    const model = new SkipModel();
    model.updatePreference(SAMPLE_FEATURES, false);
    assert.ok(model.preferenceVec !== null);
    assert.equal(model.preferenceVec.length, FEATURE_KEYS.length);
  });

  it("listening then predicting gives lower skip probability for similar tracks", () => {
    const model = new SkipModel();
    // Listen to SAMPLE_FEATURES multiple times to build preference
    for (let i = 0; i < 10; i++) {
      model.updatePreference(SAMPLE_FEATURES, false);
    }
    // Skip SAMPLE_FEATURES_2 multiple times
    for (let i = 0; i < 10; i++) {
      model.updatePreference(SAMPLE_FEATURES_2, true);
    }

    const score1 = model.predictSkip({
      features: SAMPLE_FEATURES,
      stats: null,
    });
    const score2 = model.predictSkip({
      features: SAMPLE_FEATURES_2,
      stats: null,
    });

    // Track similar to listened music should have lower skip probability
    assert.ok(
      score1 < score2,
      `Expected ${score1} < ${score2} for preferred track`
    );
  });
});

describe("SkipModel – tuneWeights", () => {
  it("adjusts weights without crashing", () => {
    const model = new SkipModel();
    model.tuneWeights(0.3, true);
    model.tuneWeights(0.8, false);

    const sum =
      model.weights.historyWeight +
      model.weights.affinityWeight +
      model.weights.noveltyWeight;
    assert.ok(Math.abs(sum - 1) < 0.01, `Weights should sum to 1, got ${sum}`);
  });

  it("keeps weights within valid bounds", () => {
    const model = new SkipModel();
    // Many tune iterations
    for (let i = 0; i < 100; i++) {
      model.tuneWeights(Math.random(), Math.random() > 0.5);
    }
    assert.ok(model.weights.historyWeight >= 0.05);
    assert.ok(model.weights.affinityWeight >= 0.05);
    assert.ok(model.weights.noveltyWeight >= 0.01);
  });
});

describe("SkipModel – warmUp", () => {
  it("initialises preference vector from historical interactions", () => {
    const model = new SkipModel();
    const interactions = [
      { trackId: "t1", wasSkipped: false },
      { trackId: "t2", wasSkipped: true },
    ];
    const featuresMap = new Map([
      ["t1", SAMPLE_FEATURES],
      ["t2", SAMPLE_FEATURES_2],
    ]);

    model.warmUp(interactions, featuresMap);
    assert.ok(model.preferenceVec !== null);
  });
});
