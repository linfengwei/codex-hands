// Synthesizes the promo soundtrack: 15 s, 120 BPM, C - G - Am - F, with sound effects on the picture's cues.
// Everything is generated here (no samples), so the audio has no outside rights.
// Usage: node docs/promo/music.mjs out.wav
import { writeFileSync } from "node:fs";

const RATE = 44100;
const SECONDS = 15;
const N = RATE * SECONDS;
const BEAT = 0.5;
const DROP = 2.5; // kick and bass start here, just before the name appears
const L = new Float32Array(N);
const R = new Float32Array(N);

let seed = 7;
const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 31) - 1;

// Adds a sound: fn(t) returns a sample for t seconds after start; pan -1 (left) .. 1 (right).
function add(start, dur, fn, pan = 0, bus = null) {
  const s0 = Math.max(0, Math.round(start * RATE));
  const s1 = Math.min(N, Math.round((start + dur) * RATE));
  const gl = Math.cos(((pan + 1) * Math.PI) / 4);
  const gr = Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = s0; i < s1; i++) {
    const v = fn((i - s0) / RATE) * (bus ? bus(i / RATE) : 1);
    L[i] += v * gl;
    R[i] += v * gr;
  }
}

// Ducks pads, bass and arpeggio after each kick, for the pumping feel.
const pump = (t) => (t < DROP ? 1 : 1 - 0.55 * Math.exp(-(((t - DROP) % BEAT) * 9)));
const lowpass = (cut) => {
  const a = 1 - Math.exp((-2 * Math.PI * cut) / RATE);
  let y = 0;
  return (x) => (y += a * (x - y));
};
const saw = (ph) => 2 * (ph - Math.floor(ph + 0.5));

const CHORDS = [
  { tones: [261.63, 329.63, 392.0], bass: 65.41 }, // C
  { tones: [196.0, 246.94, 293.66], bass: 98.0 }, // G
  { tones: [220.0, 261.63, 329.63], bass: 110.0 }, // Am
  { tones: [174.61, 220.0, 261.63], bass: 87.31 }, // F
];
const chordAt = (t) => CHORDS[Math.floor(t / (4 * BEAT)) % 4];

// pad: soft detuned triads, one per bar
for (let bar = 0; bar * 4 * BEAT < SECONDS; bar++) {
  const t0 = bar * 4 * BEAT;
  for (const f of chordAt(t0).tones) {
    for (const d of [-0.004, 0.004]) {
      add(t0, 4 * BEAT + 0.3, (t) => Math.sin(2 * Math.PI * f * (1 + d) * t) * 0.016 * Math.min(1, t / 0.25) * Math.min(1, (4 * BEAT + 0.3 - t) / 0.3), d * 150, pump);
    }
  }
}

// arpeggio: 16th-note plucks an octave up
const ARP = [0, 1, 2, 1, 2, 0, 1, 2];
for (let k = 0; k * BEAT / 4 < SECONDS; k++) {
  const t0 = (k * BEAT) / 4;
  const f = chordAt(t0).tones[ARP[k % 8]] * 2 * (k % 8 === 7 ? 2 : 1);
  const lp = lowpass(5200);
  add(t0, 0.2, (t) => lp(saw(f * t)) * 0.13 * Math.exp(-t * 14), Math.sin(k * 0.7) * 0.4, pump);
}

// hats on the off 8ths, all the way through
for (let k = 0; k * BEAT / 2 < SECONDS; k++) {
  if (k % 2 === 0) continue;
  let p = 0;
  add((k * BEAT) / 2, 0.06, (t) => { const x = noise(); const y = x - p; p = x; return y * 0.11 * Math.exp(-t * 60); }, k % 4 === 1 ? -0.3 : 0.3);
}

// kick and bass from the drop
for (let t0 = DROP; t0 < SECONDS; t0 += BEAT) {
  let ph = 0;
  add(t0, 0.35, (t) => { ph += (50 + 110 * Math.exp(-t * 35)) / RATE; return Math.sin(2 * Math.PI * ph) * 0.55 * Math.exp(-t * 8); });
}
for (let t0 = DROP; t0 < SECONDS; t0 += BEAT / 2) {
  const f = chordAt(t0).bass;
  const lp = lowpass(420);
  add(t0, BEAT / 2, (t) => lp(saw(f * t) + 0.5 * saw(f * 1.005 * t)) * 0.16 * Math.min(1, t / 0.01) * Math.exp(-t * 6), 0, pump);
}

// claps on beats 2 and 4 once the demo starts
for (let t0 = 4.5 + BEAT; t0 < SECONDS; t0 += 2 * BEAT) {
  const lp = lowpass(3000);
  let p = 0;
  add(t0, 0.18, (t) => { const x = noise(); const y = lp(x - p); p = x; const burst = t < 0.03 ? (Math.floor(t / 0.01) % 2 ? 0.4 : 1) : 1; return y * 0.5 * burst * Math.exp(-t * 22); });
}

// ---- sound effects on the picture's cues ----
const riser = (t0, dur) => {
  let y = 0;
  add(t0, dur, (t) => {
    const a = 1 - Math.exp((-2 * Math.PI * (200 + 7000 * (t / dur) ** 2)) / RATE);
    y += a * (noise() - y);
    return y * 0.3 * (t / dur) ** 1.5;
  });
};
const impact = (t0, amp) => {
  add(t0, 1.2, (t) => Math.sin(2 * Math.PI * (42 + 30 * Math.exp(-t * 6)) * t) * amp * Math.exp(-t * 3));
  let p = 0;
  add(t0, 1.3, (t) => { const x = noise(); const y = x - p; p = x; return y * amp * 0.18 * Math.exp(-t * 3.2); }, 0.2);
};
const whoosh = (t0) => { const lp = lowpass(1800); add(t0, 0.4, (t) => lp(noise()) * 0.22 * Math.sin((Math.PI * t) / 0.4), -0.2); };
const blip = (t0, f, amp, dur = 0.05) => add(t0, dur, (t) => Math.sin(2 * Math.PI * f * t) * amp * Math.exp(-t * (6 / dur)));
const chime = (t0, f) => add(t0, 0.5, (t) => (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * 0.09 * Math.exp(-t * 7), 0.3);

riser(1.5, 1.0);
impact(DROP, 0.5);
for (let t = 0.1; t < 1.45; t += 0.08) blip(t, 1950 + noise() * 150, 0.025, 0.02); // words appearing
blip(3.3, 900, 0.12, 0.08); // plug snaps in
blip(3.36, 1350, 0.1, 0.1);
whoosh(4.55);
for (let t = 5.05; t < 6.52; t += 0.05) { const lp = lowpass(5000); add(t, 0.012, (u) => lp(noise()) * 0.06 * Math.exp(-u * 300), 0.4); } // typing
add(6.5, 0.6, (t) => Math.sin(2 * Math.PI * (500 + 1600 * (t / 0.6)) * t) * 0.045 * Math.sin((Math.PI * t) / 0.6), -0.3); // scan sweep
for (const t of [6.7, 6.8, 6.9]) blip(t, 2400, 0.04, 0.03); // detection boxes
blip(7.6, 2200, 0.16, 0.025); // click
blip(7.62, 1100, 0.1, 0.04);
blip(8.05, 700, 0.08, 0.12); // clip lands
chime(9.15, 1318.5); // done
chime(9.27, 1975.5);
whoosh(10.0);
add(10.75, 0.12, (t) => Math.sin(2 * Math.PI * (300 + 500 * (t / 0.12)) * t) * 0.12 * Math.exp(-t * 20)); // dialog pops
blip(11.55, 2200, 0.16, 0.025); // click
chime(11.62, 1567.98);
blip(11.85, 1200, 0.05, 0.06); // Esc
riser(12.1, 0.7);
impact(12.85, 0.45);
for (const f of [261.63, 329.63, 392.0, 523.25]) add(12.85, 2.15, (t) => Math.sin(2 * Math.PI * f * t) * 0.035 * Math.exp(-t * 0.8)); // end chord

// master: soft clip, normalize, fade in and out, 16-bit stereo WAV
let peak = 0;
for (let i = 0; i < N; i++) {
  L[i] = Math.tanh(L[i] * 1.4);
  R[i] = Math.tanh(R[i] * 1.4);
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const out = Buffer.alloc(44 + N * 4);
out.write("RIFF", 0); out.writeUInt32LE(36 + N * 4, 4); out.write("WAVE", 8); out.write("fmt ", 12);
out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(RATE, 24);
out.writeUInt32LE(RATE * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const t = i / RATE;
  const fade = Math.min(1, t / 0.01, (SECONDS - t) / 1.0);
  const g = (0.89 / peak) * fade;
  out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * g)) * 32767), 44 + i * 4);
  out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * g)) * 32767), 46 + i * 4);
}
writeFileSync(process.argv[2] ?? "music.wav", out);
