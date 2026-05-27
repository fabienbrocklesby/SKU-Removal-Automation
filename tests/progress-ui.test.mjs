import assert from "node:assert/strict";
import test from "node:test";

import { formatDuration, progressBar, progressStats } from "../scripts/lib/progress-ui.mjs";

test("formatDuration renders compact wall-clock time", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(65), "01:05");
  assert.equal(formatDuration(3661), "01:01:01");
});

test("progressBar clamps completed work", () => {
  assert.equal(progressBar(50, 100, 10), "[#####-----]");
  assert.equal(progressBar(150, 100, 10), "[##########]");
});

test("progressStats estimates remaining work and ETA", () => {
  const stats = progressStats({ done: 25, total: 100, elapsedSeconds: 10 });

  assert.equal(stats.remaining, 75);
  assert.equal(stats.percent, 25);
  assert.equal(stats.rate, 2.5);
  assert.equal(stats.etaSeconds, 30);
});
