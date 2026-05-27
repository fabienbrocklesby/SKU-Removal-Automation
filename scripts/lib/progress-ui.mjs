import readline from "node:readline";

export class TerminalProgress {
  constructor({ title = "Catalog cleanup", enabled = process.stdout.isTTY && !process.env.NO_TUI } = {}) {
    this.title = title;
    this.enabled = Boolean(enabled && process.stdout.isTTY && !process.env.NO_TUI);
    this.startedAt = Date.now();
    this.stageStartedAt = Date.now();
    this.lineCount = 0;
    this.snapshot = null;
    this.closed = false;

    if (this.enabled) process.stdout.write("\x1b[?25l");
  }

  stage(stage, detail = "") {
    this.stageStartedAt = Date.now();
    this.update({ stage, detail, done: 0, total: null, unit: "items", status: "RUNNING" });
  }

  update({ stage, done = 0, total = null, unit = "items", status = "RUNNING", detail = "" }) {
    this.snapshot = { stage, done: Number(done) || 0, total: numberOrNull(total), unit, status, detail };
    if (this.enabled) this.render();
    else this.logFallback();
  }

  log(message) {
    if (this.enabled) this.clear();
    console.log(message);
    if (this.enabled && this.snapshot) this.render();
  }

  complete(message = "complete") {
    if (this.enabled) {
      this.clear();
      process.stdout.write("\x1b[?25h");
    }
    this.closed = true;
    console.log(message);
  }

  close() {
    if (this.closed) return;
    if (this.enabled) {
      this.clear();
      process.stdout.write("\x1b[?25h");
    }
    this.closed = true;
  }

  render() {
    if (!this.snapshot) return;
    const elapsedSeconds = Math.max(0, (Date.now() - this.stageStartedAt) / 1000);
    const stats = progressStats({
      done: this.snapshot.done,
      total: this.snapshot.total,
      elapsedSeconds
    });
    const totalText = this.snapshot.total === null ? "unknown" : formatNumber(this.snapshot.total);
    const remainingText = stats.remaining === null ? "unknown" : formatNumber(stats.remaining);
    const percentText = stats.percent === null ? "--" : `${stats.percent.toFixed(1)}%`;
    const etaText = stats.etaSeconds === null ? "unknown" : formatDuration(stats.etaSeconds);
    const rateText = stats.rate === null ? "calculating" : `${formatNumber(stats.rate)}/${this.snapshot.unit}/s`;

    this.clear();
    const lines = [
      this.title,
      `Stage: ${this.snapshot.stage} | Status: ${this.snapshot.status}`,
      `${progressBar(this.snapshot.done, this.snapshot.total, 34)} ${percentText}`,
      `Done: ${formatNumber(this.snapshot.done)} ${this.snapshot.unit} | Remaining: ${remainingText} | Total: ${totalText}`,
      `Elapsed: ${formatDuration(elapsedSeconds)} | ETA: ${etaText} | Rate: ${rateText}`,
      this.snapshot.detail ? `Detail: ${this.snapshot.detail}` : ""
    ].filter(Boolean);

    process.stdout.write(`${lines.join("\n")}\n`);
    this.lineCount = lines.length;
  }

  clear() {
    if (!this.lineCount) return;
    readline.moveCursor(process.stdout, 0, -this.lineCount);
    for (let i = 0; i < this.lineCount; i += 1) {
      readline.clearLine(process.stdout, 0);
      if (i < this.lineCount - 1) readline.moveCursor(process.stdout, 0, 1);
    }
    readline.cursorTo(process.stdout, 0);
    this.lineCount = 0;
  }

  logFallback() {
    if (!this.snapshot) return;
    const totalText = this.snapshot.total === null ? "unknown" : formatNumber(this.snapshot.total);
    const detail = this.snapshot.detail ? ` ${this.snapshot.detail}` : "";
    console.log(`[${this.snapshot.stage}] ${this.snapshot.status} ${formatNumber(this.snapshot.done)}/${totalText} ${this.snapshot.unit}${detail}`);
  }
}

export function progressStats({ done, total, elapsedSeconds }) {
  const normalizedDone = Math.max(0, Number(done) || 0);
  const normalizedTotal = numberOrNull(total);
  const normalizedElapsed = Math.max(0, Number(elapsedSeconds) || 0);
  const rate = normalizedElapsed > 0 && normalizedDone > 0 ? normalizedDone / normalizedElapsed : null;
  const remaining = normalizedTotal === null ? null : Math.max(0, normalizedTotal - normalizedDone);
  const etaSeconds = rate && remaining !== null ? remaining / rate : null;
  const percent = normalizedTotal === null || normalizedTotal === 0
    ? null
    : Math.min(100, (normalizedDone / normalizedTotal) * 100);

  return { remaining, percent, rate, etaSeconds };
}

export function progressBar(done, total, width = 30) {
  const normalizedTotal = numberOrNull(total);
  const ratio = normalizedTotal === null || normalizedTotal === 0
    ? 0
    : Math.max(0, Math.min(1, (Number(done) || 0) / normalizedTotal));
  const filled = Math.round(ratio * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(secs)}`;
  return `${pad(minutes)}:${pad(secs)}`;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  if (Number.isInteger(number)) return number.toLocaleString("en-US");
  return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pad(value) {
  return String(value).padStart(2, "0");
}
