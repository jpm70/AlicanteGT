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

    this.ctx = ctx;
    this.masterGain = masterGain;
    this.oscPrimary = oscPrimary;
    this.oscHarmonic = oscHarmonic;
    this.engineFilter = engineFilter;
    this.engineGain = engineGain;
    this.screechFilter = screechFilter;
    this.screechGain = screechGain;
  }

  public update(rpm: number, speedKmh: number, driftIntensity: number, throttle: boolean): void {
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

    const screechLevel = driftIntensity * Math.min(1, speedKmh / 45) * 0.24;
    this.screechGain.gain.setTargetAtTime(screechLevel, now, 0.05);
    this.screechFilter.frequency.setTargetAtTime(1180 + Math.min(speedKmh, 140) * 4.5, now, 0.06);
  }

  public dispose(): void {
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}
