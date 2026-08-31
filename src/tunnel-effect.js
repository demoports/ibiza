/*
 * Nonstop Ibiza x9 tunnel / feedback effect.
 *
 * This is a direct JavaScript translation of demo.exe's FUN_0040abc0
 * (constructor) and FUN_0040ac30 (frame renderer).  In particular, it keeps
 * the original 512 x 512 feedback surface, 8.8 texture coordinates, 8192
 * entry fixed-point trigonometry tables, four-tap interpolation whose weights
 * intentionally add to less than 256, and the sixteen-frame source bleed-in.
 * No Canvas filters or compositing approximations are used.
 *
 * Integration:
 *
 *   const effect = new TunnelEffect({
 *     sourceRGBA,  // x9, 512 x 512 RGBA
 *     initialRGBA  // framebuffer at activation, 512 x 384 RGBA
 *   });
 *   effect.render(context2D, absoluteDemoSeconds);    // draws 512 x 384
 *
 * `sourceRGBA` and `initialRGBA` may be ImageData objects, their `.data`
 * arrays, or RGBA Uint8Array/Uint8ClampedArray values.  The source is
 * 512 * 512 pixels and the activation frame is 512 * 384.  For the released
 * JPEG, decode with createImageBitmap(...,
 * { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }) before reading
 * pixels: Hermes used the JPEG samples and did not apply its embedded ICC
 * profile.
 *
 * Calls may seek in either direction.  The original effect is recursive, so
 * render() advances a fixed render clock and retains sparse feedback
 * checkpoints.  `reset()` drops those checkpoints.  `renderFrame()` exposes
 * one exact low-level call for capture-cadence calibration.  The released
 * capture advances this effect about three times per 30 Hz video frame; the
 * deterministic clock therefore defaults to 90 Hz.
 *
 * Recovered code: 0040abc0..0040ac20 and 0040ac30..0040b5a7.
 * Released data/x9.jpg SHA-256:
 * 61bf25801d0e8aa967a088294719a6d862b02b3f3282d4a5c4093cdf42bdb788
 *
 * Calibration on the supplied 30 Hz reference capture resolves three effect
 * iterations between displayed frames (90 Hz).  On an Apple-silicon Chrome
 * run, an iteration takes about 1.7 ms after warm-up; a cold deterministic
 * seek to 105.0 s (116 iterations) takes about 0.21 s and advancing from there
 * to 114.0 s (810 more) takes about 1.4 s.  Continuous playback does not pay
 * the cold-seek cost.
 */

const TEXTURE_SIZE = 512;
const OUTPUT_WIDTH = 512;
const OUTPUT_HEIGHT = 384;
const TEXTURE_PIXELS = TEXTURE_SIZE * TEXTURE_SIZE;
const OUTPUT_PIXELS = OUTPUT_WIDTH * OUTPUT_HEIGHT;
const TEXTURE_MIDDLE = 64 * TEXTURE_SIZE;
const TRIG_SIZE = 8192;
const TRIG_MASK = TRIG_SIZE - 1;

// This is the binary64 value stored at demo.exe:00439b60.  It is subtly
// different from 2 * Math.PI / 8192; using the latter changes cardinal table
// entries (the original sin[2048], for example, is 8191 rather than 8192).
const TRIG_STEP = 0.000766990234375;
const TRIG_SCALE = 8192;

const SIN = new Int32Array(TRIG_SIZE);
const COS = new Int32Array(TRIG_SIZE);
for (let index = 0; index < TRIG_SIZE; index++) {
  const angle = index * TRIG_STEP;
  SIN[index] = Math.trunc(Math.sin(angle) * TRIG_SCALE);
  COS[index] = Math.trunc(Math.cos(angle) * TRIG_SCALE);
}

const sin = phase => SIN[phase & TRIG_MASK];
const cos = phase => COS[phase & TRIG_MASK];

// All values are the exact binary64 constants recovered from 00439a60..
// 00439b58.  They happen to be integral, but keeping their roles explicit
// makes the otherwise opaque x87 expressions auditable against the binary.
const HORIZONTAL_PHASE_RATE = Object.freeze([
  -235416, 436532, -132343, 531212,
  -135416, 536532, -432343, 731212
]);
const VERTICAL_PHASE_RATE = Object.freeze([
  254324, -245421, 126531, -231214,
  -635416, 336532, -232343, 131212
]);

const DEFAULT_FRAME_RATE = 90;
// These clocks are deliberately separate. BASS links the scheduler object
// first; the unlocked host loop performs its first recursive pass later;
// that pass nevertheless samples the nominal 103.875 PTC timestamp. In the
// 30 Hz capture frame 103.707 is still the captured terrain and 103.741 has
// already accumulated feedback passes, bounding the recovered first pass.
const DEFAULT_FIRST_PASS_VISUAL_TIME = 103.715;
const DEFAULT_FIRST_SAMPLE_TIME = 103.875;
const DEFAULT_CHECKPOINT_INTERVAL = 120;

function rgbaBytes(source, expectedLength, label) {
  const bytes = source && source.data ? source.data : source;
  if (!(bytes instanceof Uint8Array) && !(bytes instanceof Uint8ClampedArray)) {
    throw new TypeError(`TunnelEffect ${label} must be ImageData or an RGBA Uint8Array`);
  }
  if (bytes.length !== expectedLength) {
    throw new RangeError(`TunnelEffect ${label} has the wrong RGBA byte length`);
  }
  return bytes;
}

function packRGBA(source, pixels, label) {
  const bytes = rgbaBytes(source, pixels * 4, label);
  const packed = new Uint32Array(pixels);
  for (let pixel = 0, offset = 0; pixel < pixels; pixel++, offset += 4) {
    packed[pixel] = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
  }
  return packed;
}

function makeImageData(context) {
  if (typeof ImageData === 'function') return new ImageData(OUTPUT_WIDTH, OUTPUT_HEIGHT);
  if (context && typeof context.createImageData === 'function') {
    return context.createImageData(OUTPUT_WIDTH, OUTPUT_HEIGHT);
  }
  // Useful to deterministic headless tests which consume `.data` without a
  // browser.  A real CanvasRenderingContext2D is still required to draw it.
  return {
    width: OUTPUT_WIDTH,
    height: OUTPUT_HEIGHT,
    data: new Uint8ClampedArray(OUTPUT_PIXELS * 4)
  };
}

export class TunnelEffect {
  constructor({
    sourceRGBA,
    initialRGBA = null,
    frameRate = DEFAULT_FRAME_RATE,
    firstPassVisualTime = DEFAULT_FIRST_PASS_VISUAL_TIME,
    firstSampleTime = DEFAULT_FIRST_SAMPLE_TIME,
    checkpointInterval = DEFAULT_CHECKPOINT_INTERVAL,
    // Optional sub-frame adjustment to the PTC time passed to FUN_0040ac30.
    // This changes only sampled times, never the recovered renderer itself.
    renderPhase = 0
  } = {}) {
    if (!(frameRate > 0) || !Number.isFinite(frameRate)) {
      throw new RangeError('frameRate must be a finite positive number');
    }
    if (!Number.isFinite(firstPassVisualTime) ||
        !Number.isFinite(firstSampleTime) || !Number.isFinite(renderPhase)) {
      throw new RangeError('feedback integration clocks must be finite');
    }
    if (!Number.isInteger(checkpointInterval) || checkpointInterval < 1) {
      throw new RangeError('checkpointInterval must be a positive integer');
    }

    this.source = packRGBA(sourceRGBA, TEXTURE_PIXELS, 'sourceRGBA');
    this.initialFrame = initialRGBA === null
      ? null
      : packRGBA(initialRGBA, OUTPUT_PIXELS, 'initialRGBA');
    this.frameRate = frameRate;
    this.firstPassVisualTime = firstPassVisualTime;
    this.firstSampleTime = firstSampleTime;
    this.renderPhase = renderPhase;
    this.checkpointInterval = checkpointInterval;
    this.horizontal = new Int32Array(OUTPUT_WIDTH * 2);
    this.vertical = new Int32Array(OUTPUT_HEIGHT * 2);
    this.sampled = new Uint32Array(OUTPUT_PIXELS);
    this.frame = new Uint32Array(OUTPUT_PIXELS);
    this.imageData = null;
    this.checkpoints = new Map();
    this.reset();
  }

  reset() {
    // FUN_0040ac30's one-time block clears the top/bottom 64 rows, then copies
    // the current 512 x 384 framebuffer into rows 64..447.  On activation that
    // is the last heightfield frame, not x9.  x9 enters via the small source
    // bleed in mixAndCommit().
    this.feedback = new Uint32Array(TEXTURE_PIXELS);
    if (this.initialFrame) this.feedback.set(this.initialFrame, TEXTURE_MIDDLE);
    this.fadeCounter = 0;
    this.nextFrame = 0;
    this.checkpoints.clear();
    this.initialized = this.initialFrame !== null;
    if (this.initialized) this.saveCheckpoint(0);
  }

  initialize(initialRGBA) {
    this.initialFrame = packRGBA(initialRGBA, OUTPUT_PIXELS, 'initialRGBA');
    this.reset();
  }

  saveCheckpoint(nextFrame = this.nextFrame) {
    this.checkpoints.set(nextFrame, {
      nextFrame,
      fadeCounter: this.fadeCounter,
      feedback: this.feedback.slice(),
      frame: this.frame.slice()
    });
  }

  restoreFor(targetFrame) {
    let selected = 0;
    for (const frame of this.checkpoints.keys()) {
      if (frame <= targetFrame && frame >= selected) selected = frame;
    }
    const checkpoint = this.checkpoints.get(selected);
    this.feedback.set(checkpoint.feedback);
    this.frame.set(checkpoint.frame);
    this.fadeCounter = checkpoint.fadeCounter;
    this.nextFrame = checkpoint.nextFrame;
  }

  frameTime(frameIndex) {
    return this.firstSampleTime + this.renderPhase + frameIndex / this.frameRate;
  }

  render(context, absoluteSeconds) {
    // In a continuous integration the framebuffer is already on the target
    // canvas, so omitting initialRGBA is safe: capture it on the first call.
    // Deterministic direct seeking should pass initialRGBA explicitly.
    if (!this.initialized) {
      if (!context || typeof context.getImageData !== 'function') {
        throw new Error('TunnelEffect needs initialRGBA or a readable 512 x 384 context');
      }
      this.initialize(context.getImageData(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT));
    }
    const targetFrame = Math.floor(
      (absoluteSeconds - this.firstPassVisualTime) * this.frameRate + 1e-7);
    if (targetFrame < 0) {
      // Present the activation frame without replacing the recursive frame.
      // A later request for nextFrame - 1 can then reuse the correct result.
      this.draw(context, this.initialFrame);
      return this.imageData;
    }
    if (targetFrame < this.nextFrame - 1) this.restoreFor(targetFrame);

    while (this.nextFrame <= targetFrame) {
      this.renderFrame(this.frameTime(this.nextFrame));
      this.nextFrame++;
      if (this.nextFrame % this.checkpointInterval === 0 &&
          !this.checkpoints.has(this.nextFrame)) {
        this.saveCheckpoint();
      }
    }

    this.draw(context);
    return this.imageData;
  }

  // One literal invocation of FUN_0040ac30.  This is intentionally public so
  // capture analysis can feed the actual render timestamps without imposing a
  // fixed cadence.  It advances the recursive surface exactly once.
  renderFrame(absoluteSeconds) {
    if (!Number.isFinite(absoluteSeconds)) throw new RangeError('render time must be finite');
    this.buildMaps(absoluteSeconds);
    this.sampleFeedback();
    this.mixAndCommit();
    return this.frame;
  }

  buildMaps(time) {
    const s464 = sin(Math.trunc(time * 464));
    const s264 = sin(Math.trunc(time * 264));
    const s364 = sin(Math.trunc(time * 364));
    const s164 = sin(Math.trunc(time * 164));
    const perspective = 8192 - ((s464 + s264 + s364 + s164 + 8192) >> 6);

    const centerSine = sin(Math.trunc(time * 216));
    const centerCosine = cos(Math.trunc(time * 316));
    const horizontalOrigin = (centerSine >> 2) - 4096;
    const verticalOrigin = (centerCosine >> 2) - 3072;
    const horizontalCenter = centerSine << 2;
    const verticalCenter = centerCosine << 2;

    const envelope = (sin(Math.trunc(time * 235)) +
      sin(Math.trunc(time * 314)) +
      sin(Math.trunc(time * 1159)) +
      sin(Math.trunc(time * 2120)) + 32768) >> 8;

    // 0040ade1..0040aed6.  The last oscillator deliberately reuses the phase
    // for 234, exactly as the register lifetime in the executable does.
    const delta = new Int32Array(8);
    delta[0] = (Math.imul(sin(Math.trunc(time * 132)), envelope)) >> 1;
    delta[1] = (Math.imul(sin(Math.trunc(time * 224)), envelope)) >> 1;
    delta[2] = (Math.imul(sin(Math.trunc(time * 342)), envelope)) >> 1;
    delta[3] = (Math.imul(sin(Math.trunc(time * 454)), envelope)) >> 1;
    const repeated = (Math.imul(sin(Math.trunc(time * 234)), envelope)) >> 1;
    delta[4] = repeated;
    delta[5] = (Math.imul(sin(Math.trunc(time * 543)), envelope)) >> 1;
    delta[6] = (Math.imul(sin(Math.trunc(time * 122)), envelope)) >> 1;
    delta[7] = repeated;

    this.buildAxis(
      this.horizontal, OUTPUT_WIDTH, time, horizontalOrigin, perspective,
      delta, HORIZONTAL_PHASE_RATE, horizontalCenter, true);
    this.buildAxis(
      this.vertical, OUTPUT_HEIGHT, time, verticalOrigin, perspective,
      delta, VERTICAL_PHASE_RATE, verticalCenter, false);
  }

  buildAxis(output, count, time, origin, perspective, delta, rates, center, horizontal) {
    const phase = new Int32Array(8);
    for (let index = 0; index < 8; index++) {
      // The integer product is shifted before x87 adds/subtracts time * rate.
      // Math.trunc is the MSVC __ftol routine's round-toward-zero behavior.
      const base = Math.imul(delta[index], origin) >> 4;
      phase[index] = Math.trunc(base + time * rates[index]);
    }

    let line = Math.imul(origin, perspective);
    const lineStep = perspective << 4;
    for (let coordinate = 0, offset = 0; coordinate < count; coordinate++, offset += 2) {
      const first = (sin(phase[5] >> 13) + sin(phase[4] >> 13) +
        sin(phase[1] >> 13) + sin(phase[0] >> 13)) >> 6;
      const second = (sin(phase[7] >> 13) + sin(phase[6] >> 13) +
        sin(phase[3] >> 13) + sin(phase[2] >> 13)) >> 6;

      if (horizontal) {
        output[offset] = first + (line >> 9) - center + 65408;
        output[offset + 1] = second;
      } else {
        output[offset] = second;
        output[offset + 1] = first + (line >> 9) - center + 65408;
      }

      line = (line + lineStep) | 0;
      for (let index = 0; index < 8; index++) {
        phase[index] = (phase[index] + delta[index]) | 0;
      }
    }
  }

  sampleFeedback() {
    const texture = this.feedback;
    const horizontal = this.horizontal;
    const vertical = this.vertical;
    const sampled = this.sampled;
    let destination = 0;

    for (let y = 0, verticalOffset = 0; y < OUTPUT_HEIGHT; y++, verticalOffset += 2) {
      const verticalX = vertical[verticalOffset];
      const verticalY = vertical[verticalOffset + 1];
      for (let x = 0, horizontalOffset = 0; x < OUTPUT_WIDTH; x++, horizontalOffset += 2) {
        const fixedX = (verticalX + horizontal[horizontalOffset]) | 0;
        const fixedY = (verticalY + horizontal[horizontalOffset + 1]) | 0;
        const fractionX = fixedX & 255;
        const fractionY = fixedY & 255;
        const index = ((fixedX >> 8) + (fixedY >> 8) * TEXTURE_SIZE) & (TEXTURE_PIXELS - 1);

        const inverseX = 255 - fractionX;
        const inverseY = 255 - fractionY;
        const w00 = Math.imul(inverseY, inverseX) >> 8;
        const w10 = Math.imul(inverseY, fractionX) >> 8;
        const w01 = Math.imul(fractionY, inverseX) >> 8;
        const w11 = Math.imul(fractionY, fractionX) >> 8;
        const p00 = texture[index];
        const p10 = texture[(index + 1) & (TEXTURE_PIXELS - 1)];
        const p01 = texture[(index + TEXTURE_SIZE) & (TEXTURE_PIXELS - 1)];
        const p11 = texture[(index + TEXTURE_SIZE + 1) & (TEXTURE_PIXELS - 1)];

        const red = (Math.imul(p00 >>> 16, w00) + Math.imul(p10 >>> 16, w10) +
          Math.imul(p01 >>> 16, w01) + Math.imul(p11 >>> 16, w11)) >> 8;
        const green = (Math.imul((p00 >>> 8) & 255, w00) + Math.imul((p10 >>> 8) & 255, w10) +
          Math.imul((p01 >>> 8) & 255, w01) + Math.imul((p11 >>> 8) & 255, w11)) >> 8;
        const blue = (Math.imul(p00 & 255, w00) + Math.imul(p10 & 255, w10) +
          Math.imul(p01 & 255, w01) + Math.imul(p11 & 255, w11)) >> 8;
        sampled[destination++] = (red << 16) | (green << 8) | blue;
      }
    }
  }

  mixAndCommit() {
    // The executable reads the old counter, increments it for the next frame,
    // and caps it at 16.  Therefore frame zero is pure recursive output.
    const sourceWeight = this.fadeCounter;
    if (this.fadeCounter < 16) this.fadeCounter++;
    const effectWeight = 255 - sourceWeight;
    const source = this.source;
    const sampled = this.sampled;
    const frame = this.frame;
    const feedback = this.feedback;

    for (let pixel = 0; pixel < OUTPUT_PIXELS; pixel++) {
      const original = source[pixel + TEXTURE_MIDDLE];
      const distorted = sampled[pixel];
      const red = (Math.imul(original >>> 16, sourceWeight) +
        Math.imul(distorted >>> 16, effectWeight)) >> 8;
      const green = (Math.imul((original >>> 8) & 255, sourceWeight) +
        Math.imul((distorted >>> 8) & 255, effectWeight)) >> 8;
      const blue = (Math.imul(original & 255, sourceWeight) +
        Math.imul(distorted & 255, effectWeight)) >> 8;
      const color = (red << 16) | (green << 8) | blue;
      frame[pixel] = color;
      feedback[pixel + TEXTURE_MIDDLE] = color;
    }
  }

  draw(context, frame = this.frame) {
    if (!this.imageData) this.imageData = makeImageData(context);
    const bytes = this.imageData.data;
    for (let pixel = 0, offset = 0; pixel < OUTPUT_PIXELS; pixel++, offset += 4) {
      const color = frame[pixel];
      bytes[offset] = color >>> 16;
      bytes[offset + 1] = (color >>> 8) & 255;
      bytes[offset + 2] = color & 255;
      bytes[offset + 3] = 255;
    }
    if (context && typeof context.putImageData === 'function') {
      context.putImageData(this.imageData, 0, 0);
    }
  }

}
