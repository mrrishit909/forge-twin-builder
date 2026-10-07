// Predictive maintenance: vibration against a baseline learned while the machine is known healthy (its first `learnS` running
// seconds), as a robust z-score (median / MAD), smoothed with an EWMA. An alarm needs the smoothed score above `threshold`.
export interface Detector { learnS: number; alpha: number; threshold: number }
export const DEFAULT_DETECTOR: Detector = { learnS: 600, alpha: 0.02, threshold: 4 };

/** Streaming form: push one 1 Hz sample at a time (what the browser and the API run on live telemetry). */
export class VibrationMonitor {
  private base: number[] = [];
  med = 0; mad = 1; score = 0; ready = false; alarmAt: number | null = null;
  private d: Detector;
  constructor(d: Detector = DEFAULT_DETECTOR) { this.d = d; }
  push(t: number, vibration: number, running: boolean) {
    if (!running) return this.score;
    if (!this.ready) {
      this.base.push(vibration);
      if (this.base.length >= this.d.learnS) {
        const sorted = [...this.base].sort((a, b) => a - b);
        this.med = sorted[sorted.length >> 1];
        const dev = this.base.map((x) => Math.abs(x - this.med)).sort((a, b) => a - b);
        this.mad = Math.max(1e-6, 1.4826 * dev[dev.length >> 1]);
        this.ready = true;
      }
      return 0;
    }
    this.score = this.d.alpha * ((vibration - this.med) / this.mad) + (1 - this.d.alpha) * this.score;
    if (this.alarmAt === null && this.score > this.d.threshold) this.alarmAt = t;
    return this.score;
  }
}

export function vibrationAlarm(samples: { t: number; vibration: number; running: boolean }[], d: Detector = DEFAULT_DETECTOR) {
  const m = new VibrationMonitor(d);
  const scores: number[] = [];
  for (const s of samples) { scores.push(m.push(s.t, s.vibration, s.running)); if (m.alarmAt !== null) break; }
  return { alarmAt: m.alarmAt, scores, baseline: { median: m.med, mad: m.mad } };
}
