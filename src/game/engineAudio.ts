/**
 * 100% Procedural Web Audio V8 sports car engine & tire-screech synthesizer.
 * Zero external audio files; gracefully unlocks on user gesture.
 */
export class EngineAudioSynth {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private oscPrimary: OscillatorNode | null = null;
  private oscHarmonic: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private screechGain: GainNode | null = null;
  private screechFilter: BiquadFilterNode | null = null;
  private rollGain: GainNode | null = null;
  private rollFilter: BiquadFilterNode | null = null;
  private scrapeGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = false;

  public setEnabled(next: boolean): void {
    this.enabled = next;
    if (next) {
      this.ensureInitialized();
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      if (this.masterGain && this.ctx) {
        this.masterGain.gain.setTargetAtTime(0.24, this.ctx.currentTime, 0.08);
      }
    } else if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(0.0, this.ctx.currentTime, 0.06);
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  private ensureInitialized(): void {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(ctx.destination);

    // Dual-oscillator sports exhaust tone
    const engineFilter = ctx.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 320;
    engineFilter.Q.value = 2.4;

    const engineGain = ctx.createGain();
    engineGain.gain.value = 0.22;

    const oscPrimary = ctx.createOscillator();
    oscPrimary.type = 'sawtooth';
    oscPrimary.frequency.value = 62;

    const oscHarmonic = ctx.createOscillator();
    oscHarmonic.type = 'triangle';
    oscHarmonic.frequency.value = 124;

    const harmonicGain = ctx.createGain();
    harmonicGain.gain.value = 0.55;

    oscPrimary.connect(engineFilter);
    oscHarmonic.connect(harmonicGain);
    harmonicGain.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(masterGain);

    oscPrimary.start();
    oscHarmonic.start();

    // Procedural noise buffer for tire drift screech
    const bufferSize = ctx.sampleRate * 2;
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = noiseBuffer;
    noiseSource.loop = true;

    const screechFilter = ctx.createBiquadFilter();
    screechFilter.type = 'bandpass';
    screechFilter.frequency.value = 1350;
    screechFilter.Q.value = 7.5;

    const screechGain = ctx.createGain();
    screechGain.gain.value = 0;

    noiseSource.connect(screechFilter);
    screechFilter.connect(screechGain);
    screechGain.connect(masterGain);
    noiseSource.start();

    // Rodadura: ruido grave que sube con la velocidad (asfalto y neumáticos)
    const rollSrc = ctx.createBufferSource();
    rollSrc.buffer = noiseBuffer; rollSrc.loop = true;
    const rollFilter = ctx.createBiquadFilter();
    rollFilter.type = 'lowpass'; rollFilter.frequency.value = 300; rollFilter.Q.value = 0.7;
    const rollGain = ctx.createGain(); rollGain.gain.value = 0;
    rollSrc.connect(rollFilter); rollFilter.connect(rollGain); rollGain.connect(masterGain); rollSrc.start();

    // Roce de chapa contra bordillos y paredes
    const scrapeSrc = ctx.createBufferSource();
    scrapeSrc.buffer = noiseBuffer; scrapeSrc.loop = true; scrapeSrc.playbackRate.value = 0.8;
    const scrapeFilter = ctx.createBiquadFilter();
    scrapeFilter.type = 'bandpass'; scrapeFilter.frequency.value = 2600; scrapeFilter.Q.value = 1.4;
    const scrapeGain = ctx.createGain(); scrapeGain.gain.value = 0;
    scrapeSrc.connect(scrapeFilter); scrapeFilter.connect(scrapeGain); scrapeGain.connect(masterGain); scrapeSrc.start();

    this.noise = noiseBuffer;
    this.rollGain = rollGain; this.rollFilter = rollFilter; this.scrapeGain = scrapeGain;
    this.ctx = ctx;
    this.masterGain = masterGain;
    this.oscPrimary = oscPrimary;
    this.oscHarmonic = oscHarmonic;
    this.engineFilter = engineFilter;
    this.engineGain = engineGain;
    this.screechFilter = screechFilter;
    this.screechGain = screechGain;
  }

  public update(rpm: number, speedKmh: number, driftIntensity: number, throttle: boolean, extra?: { latAccel: number; braking: number; damage: number }): void {
    if (!this.enabled || !this.ctx || !this.oscPrimary || !this.oscHarmonic || !this.engineFilter || !this.engineGain || !this.screechGain || !this.screechFilter) {
      return;
    }
    const now = this.ctx.currentTime;
    const clampedRpm = Math.max(0.12, Math.min(1.0, rpm));
    const baseFreq = 52 + clampedRpm * 165 + Math.min(speedKmh, 200) * 0.18;

    this.oscPrimary.frequency.setTargetAtTime(baseFreq, now, 0.045);
    this.oscHarmonic.frequency.setTargetAtTime(baseFreq * 1.98, now, 0.045);

    const cutoff = 260 + clampedRpm * 1450 + (throttle ? 340 : 0);
    this.engineFilter.frequency.setTargetAtTime(cutoff, now, 0.06);
    this.engineGain.gain.setTargetAtTime(0.18 + clampedRpm * 0.22 + (throttle ? 0.08 : 0), now, 0.06);

    // chirrido: derrape, curva al límite del agarre y frenada a fondo a velocidad
    const lat = extra ? Math.abs(extra.latAccel) : 0;
    const cornering = Math.max(0, Math.min(1, (lat - 11) / 9)) * Math.min(1, speedKmh / 40);
    const lockup = extra ? Math.max(0, extra.braking - 0.7) / 0.3 * Math.max(0, Math.min(1, (speedKmh - 45) / 70)) : 0;
    const screechLevel = Math.max(driftIntensity * Math.min(1, speedKmh / 45) * 0.24, cornering * 0.2, lockup * 0.16);
    this.screechGain.gain.setTargetAtTime(screechLevel, now, 0.05);
    this.screechFilter.frequency.setTargetAtTime(1180 + Math.min(speedKmh, 140) * 4.5 + cornering * 260, now, 0.06);
    if (this.rollGain && this.rollFilter) {
      const sp = Math.min(speedKmh / 130, 1);
      this.rollGain.gain.setTargetAtTime(sp * sp * 0.09 + sp * 0.015, now, 0.1);
      this.rollFilter.frequency.setTargetAtTime(220 + sp * 900, now, 0.1);
    }
    // motor tocado: desafina y falla
    const dmg = extra?.damage ?? 0;
    if (dmg > 0.35) {
      this.oscHarmonic.detune.setTargetAtTime((Math.random() - 0.5) * 520 * dmg, now, 0.03);
      if (Math.random() < 0.06 * dmg) this.engineGain.gain.setTargetAtTime(0.05, now, 0.01);
    } else this.oscHarmonic.detune.setTargetAtTime(0, now, 0.1);
  }

  /** Golpe: chasquido de chapa y un golpe sordo; `strength` en [0..1]. */
  public impact(strength: number): void {
    if (!this.enabled || !this.ctx || !this.masterGain || !this.noise) return;
    const ctx = this.ctx, now = ctx.currentTime, k = Math.max(0.15, Math.min(1, strength));
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(2600, now); f.frequency.exponentialRampToValueAtTime(220, now + 0.4);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.5 * k, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    src.connect(f); f.connect(g); g.connect(this.masterGain);
    src.start(now, Math.random()); src.stop(now + 0.5);
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(110, now); o.frequency.exponentialRampToValueAtTime(38, now + 0.28);
    const og = ctx.createGain(); og.gain.setValueAtTime(0.6 * k, now); og.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
    o.connect(og); og.connect(this.masterGain); o.start(now); o.stop(now + 0.35);
  }

  /** Roce continuo (bordillo, pared): nivel en [0..1]; 0 lo apaga. */
  public scrape(level: number): void {
    if (!this.enabled || !this.ctx || !this.scrapeGain) return;
    this.scrapeGain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.16, this.ctx.currentTime, 0.04);
  }

  public dispose(): void {
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
