// Exact software-renderer port of the opening scene in demo.exe.
//
// Recovered entry points:
//   00405680 / 00405760  8,000 gradient-following particles
//   00401650 / 004016d0  x14 -> x15 eased background blend
//   00403270 / 004032d0  opening black reveal
//   00406d50 / 00406de0  seeded grayscale-noise overlay
//
// The original renderer advances once per completed, uncapped main-loop pass.
// The release capture consequently has a variable update rate.  This class
// keeps that stateful behaviour while making arbitrary timeline seeks
// deterministic through an explicit cumulative-update trace.

const WIDTH = 512;
const HEIGHT = 384;
const PIXELS = WIDTH * HEIGHT;
const PARTICLES = 8000;
const CHECKPOINT_INTERVAL = 120;

const BACKGROUND_MORPH = 15.0;       // order 0, row 40
const NOISE_IN = 18.75;              // order 0, row 50
const PARTICLE_FIELD_CHANGE = 20.625; // order 0, row 55
const SCENE_END = 23.1;              // order 1, row 0
const PARTICLE_MODE_OUT = 25.9;      // order 1, row 56
const PARTICLE_REMOVAL = 30.7;       // order 2, row 56

// Cumulative FUN_00405760 invocations in the released reference run.  The
// executable itself has no fixed cadence; these anchors are fitted against
// the released captured frames and interpolation reconstructs the intervening
// uncapped main-loop passes.  `updates: 1` means frame zero has rendered.
const DEFAULT_UPDATE_TRACE = Object.freeze([
  Object.freeze({ time: 0, updates: 1 }),
  Object.freeze({ time: 5, updates: 200 }),
  Object.freeze({ time: 10, updates: 383 }),
  Object.freeze({ time: 12.5, updates: 469 }),
  Object.freeze({ time: 15, updates: 551 }),
  Object.freeze({ time: NOISE_IN, updates: 676 }),
  Object.freeze({ time: PARTICLE_FIELD_CHANGE, updates: 735 }),
  Object.freeze({ time: 22.5, updates: 780 }),
  Object.freeze({ time: SCENE_END, updates: 799 }),
  Object.freeze({ time: PARTICLE_MODE_OUT, updates: 855 }),
  Object.freeze({ time: PARTICLE_REMOVAL, updates: 1031 })
]);

// BASS 0.8's BASS_ChannelGetLevel does not return a 16-bit PCM peak.  Its
// unpacked 0x10019860 implementation requests sampleRate >> 6 frames, scans
// the signed high byte of each 16-bit stereo sample, and returns 0..128 per
// channel.  The demo adds those two bytes and clamps the result to 255 before
// FUN_00405760 uses the clamped level for particle displacement.  This is the
// worklet's canonical level trace at the capture-fitted host-update times.
const PARTICLE_LEVELS_BASE64 =
  'AAAAAAICAgICAgICAgMCBAMEBAIEBAQEAwUGBAQEBgQICAkHBwgGBwYGBggICgoGCAgKCAgHBgUICQsNCAsPDAsLCwoMEQwNDQkKBwkJCQcIDQ0NCg8ODQsNCREQEg0XDxALDREKCw8OFRkVHhEVExUVExMZGxUVFhkUFw8TFxMbIRsWGBIRFBsXChEPHycZFygfIBgZHiEgHR0uHSYjJhkgHxwdLRklIhkfISMrJysjNCctIB0zHh0SHRkYISMiHx8bGSEoKiA3KR0cHyAaJyclWyErJiUpJjAgHjsqJC0sKDIsOzI4KS4oFyQWGxshMFQiLiUbKiQTHRUbFyQbHSUiHyUfHyMiJiEhHRkhGh0ZKBwaGR4jJzQzJRYdGxcZJkcoGB0TGhsYIh4dGxojFh8ZHRsfGR0cGxsdHRcbFRsZHBkdFhYaFyszHicWGCgcJyQkKiI2GSQbJTAeIikrHys2ICAiJEEkJiogHygsRCMmKTIbJiIbHicYGiAcLyAgMSUfJicfMCswKSklHiEfKUlGNCQoICQ2Lh8sLCQvJiEbEBUTKh4cExgcExlLHTAdHx4VEzYmHB8ZMDMlLh8eIjAgIyYhKyUqRTEuNTMhKjMsJSwjIh8jLC0rKispNScjHSUhPBsgIRsXGRccKC0iJSwuKSQhSTktKDMxKBgpJysqIh4tJiYsHSMeKTA9OzkhGBoRGRsdMTc3GyQdFQ0bFhshJx0pMDYbTDEsKxkUEBYSFhcfIx47NBsnJxshIxwoJSw0LC40KCgsHy8wGxwdFRklKh8jJikmJR8lJyMoNCAdIR0pICEkJiElHiofExwYHyIeJiUbGiEeHx8gJCYvJiIeIhkdHRkjIychIyQXHCEnJB0gHCIfHyckIiUlIi4qKSQqLCYwKEA6R0QwK0A6LS47NDM8NDg5MDAxJC4jI0hXJz4xKTgsKTUrIiMnRjVEMS4nKCYbGRsgIikiJUYzMTUoKB4ZGx8jIjksRDMzKSEYGiEgIi0zPjI/KSYcFSQiJCY6QzQyJhwXISkcSDgwNykmGxshKR5BRDMpKxsjNzlDKRsjPTIyJxkgdl1IJiIkQzAlFyInSz8dICQ+PigXGxwwdU8yJTsoPBsaGykoPBoeNCsfOSUbMickKR8bjVhKRi8wLCcdHxM1LSMlSDUqLCMrPzgoGy44JCMeGBUZRCs7RCIrGxsWHCA6MSooLicZGBgeGzsxMiseIhZ2dHZKPzAoHx0ZEx4YFSk9KSYbEA8VFhMmIZFeUEAuKhoWIRsYOyMWFBEQEiMiISoxIxYSERYbGhwXFDIsFhMVER4cGBMTj1hOQikqIBkWEg0zHRwSHRkUGhEOCi8ZFRoXExkRDAkNNBwZFBQ=';
const BASE64_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeLevelTrace(encoded) {
  const output = new Uint8Array(1031);
  let accumulator = 0;
  let bits = 0;
  let cursor = 0;
  for (const character of encoded) {
    if (character === '=') break;
    const value = BASE64_DIGITS.indexOf(character);
    if (value < 0) continue;
    accumulator = accumulator * 64 + value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[cursor++] = (accumulator >> bits) & 255;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (cursor !== output.length) throw new Error('Invalid opening particle level trace');
  return output;
}

const DEFAULT_LEVEL_TRACE = decodeLevelTrace(PARTICLE_LEVELS_BASE64);

// FUN_00405680 is constructed part-way through the loading sequence.  The
// loading renderer has already made 1,751,040 calls to the process-wide RNG,
// advancing its executable initial state (0x0001fe24) to 0x12a808f8.  The
// constructor then consumes 16,000 calls for its 8,000 particles.  Loading
// resumes afterward and advances the shared generator to 0x84925259 before
// music playback/rendering begins.
const PARTICLE_CONSTRUCTOR_SEED = 0x12a808f8;
const PARTICLE_RUNTIME_SEED = 0x84925259;
const PARTICLE_MOTION_SEED = 0x0012c865;
const NOISE_SEED = 0x00d567e5;
const UINT32_SCALE = 1 / 0xffffffff;
const TRIG_STEP = 0.000766990234375;

const COS = new Int32Array(8192);
for (let index = 0; index < COS.length; index++) {
  // The executable builds this table with x87 FPU operations and truncates it.
  COS[index] = Math.trunc(Math.cos(index * TRIG_STEP) * 8192);
}

function rotl32(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function normalizeUpdateTrace(source) {
  const trace = (source ?? DEFAULT_UPDATE_TRACE).map(anchor => ({
    time: Number(anchor.time),
    updates: Math.trunc(anchor.updates)
  }));
  if (trace.length < 2 || trace[0].time !== 0 || trace[0].updates < 1) {
    throw new RangeError('updateTrace must start at time 0 with at least one update');
  }
  for (let index = 0; index < trace.length; index++) {
    const anchor = trace[index];
    if (!Number.isFinite(anchor.time) || !Number.isSafeInteger(anchor.updates)) {
      throw new TypeError('updateTrace anchors require finite time and integer updates');
    }
    if (index && (anchor.time <= trace[index - 1].time ||
        anchor.updates <= trace[index - 1].updates)) {
      throw new RangeError('updateTrace time and updates must increase strictly');
    }
  }
  return trace;
}

function interpolateUpdates(trace, time) {
  if (time < 0) return 0;
  let upper = 1;
  while (upper < trace.length && time > trace[upper].time) upper++;
  if (upper >= trace.length) upper = trace.length - 1;
  const first = trace[upper - 1];
  const second = trace[upper];
  const amount = (time - first.time) / (second.time - first.time);
  return first.updates + (second.updates - first.updates) * amount;
}

function interpolateTime(trace, updates) {
  let upper = 1;
  while (upper < trace.length && updates > trace[upper].updates) upper++;
  if (upper >= trace.length) upper = trace.length - 1;
  const first = trace[upper - 1];
  const second = trace[upper];
  const amount = (updates - first.updates) / (second.updates - first.updates);
  return first.time + (second.time - first.time) * amount;
}

// FUN_0040b6d0: the process-wide generator used while allocating particles.
function nextPositionRandom(state, range) {
  const next = (rotl32((state + 157) >>> 0, 11) ^ 157) >>> 0;
  return { state: next, value: Math.trunc(next * UINT32_SCALE * range) };
}

// FUN_00405610: the opening effect's private, low-16-bit generator.
function nextMotionRandom(state, range) {
  const next = (rotl32((state + 157) >>> 0, 11) ^ 157) >>> 0;
  return { state: next, value: Math.trunc((next & 0xffff) * range / 0xffff) };
}

// FUN_00406de0 deliberately uses a different ordering of the same primitives.
function nextNoiseState(state) {
  return (rotl32((state ^ 157) >>> 0, 11) + 157) >>> 0;
}

function easeByte(progress) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 256;
  const angle = Math.trunc(progress * 4096) & 8191;
  return (8192 - COS[angle]) >> 6;
}

function packedFromImageData(source) {
  if (!source || !source.data || source.width !== WIDTH || source.height !== HEIGHT) {
    throw new Error('IntroEffect expects 512x384 ImageData for x12-x15');
  }
  const result = new Uint32Array(PIXELS);
  const rgba = source.data;
  for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
    result[pixel] = (rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2];
  }
  return result;
}

function grayFromImageData(source, expectedWidth, expectedHeight, label) {
  if (!source || !source.data || source.width !== expectedWidth || source.height !== expectedHeight) {
    throw new Error(`IntroEffect expects ${expectedWidth}x${expectedHeight} ImageData for ${label}`);
  }
  const result = new Uint8Array(expectedWidth * expectedHeight);
  // FUN_00404d40 copied the low byte of each 0x00RRGGBB source pixel.  On the
  // little-endian PTC surface that is blue.  The three supplied maps are gray,
  // but retaining the exact channel also preserves their JPEG rounding noise.
  for (let pixel = 0, offset = 2; pixel < result.length; pixel++, offset += 4) {
    result[pixel] = source.data[offset];
  }
  return result;
}

function blendPacked(first, second, progress, output) {
  if (progress <= 0) {
    output.set(first);
    return;
  }
  if (progress >= 1) {
    output.set(second);
    return;
  }
  const secondWeight = easeByte(progress);
  const firstWeight = 255 - secondWeight;
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const a = first[pixel];
    const b = second[pixel];
    const red = (((a >>> 16) & 255) * firstWeight + ((b >>> 16) & 255) * secondWeight) >> 8;
    const green = (((a >>> 8) & 255) * firstWeight + ((b >>> 8) & 255) * secondWeight) >> 8;
    const blue = ((a & 255) * firstWeight + (b & 255) * secondWeight) >> 8;
    output[pixel] = (red << 16) | (green << 8) | blue;
  }
}

function scalePacked(buffer, progress) {
  if (progress <= 0) {
    buffer.fill(0);
    return;
  }
  // FUN_004032d0 still performs its integer multiply at state 1.0.  Its
  // first-source weight is 255, so the fully revealed image is 255/256 rather
  // than an identity copy.
  const weight = Math.min(255, easeByte(Math.min(1, progress)));
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const value = buffer[pixel];
    const red = ((value >>> 16) & 255) * weight >> 8;
    const green = ((value >>> 8) & 255) * weight >> 8;
    const blue = (value & 255) * weight >> 8;
    buffer[pixel] = (red << 16) | (green << 8) | blue;
  }
}

function addPacked(target, source) {
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const a = target[pixel];
    const b = source[pixel];
    const red = Math.min(255, ((a >>> 16) & 255) + ((b >>> 16) & 255));
    const green = Math.min(255, ((a >>> 8) & 255) + ((b >>> 8) & 255));
    const blue = Math.min(255, (a & 255) + (b & 255));
    target[pixel] = (red << 16) | (green << 8) | blue;
  }
}

function decayPacked(buffer) {
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const value = buffer[pixel];
    const red = (value >>> 16) & 255;
    const green = (value >>> 8) & 255;
    const blue = value & 255;
    buffer[pixel] = ((red - (red >> 2)) << 16) |
      ((green - (green >> 2)) << 8) | (blue - (blue >> 2));
  }
}

function addSaturated(buffer, pixel, red, green, blue) {
  const value = buffer[pixel];
  const outRed = Math.min(255, ((value >>> 16) & 255) + red);
  const outGreen = Math.min(255, ((value >>> 8) & 255) + green);
  const outBlue = Math.min(255, (value & 255) + blue);
  buffer[pixel] = (outRed << 16) | (outGreen << 8) | outBlue;
}

export class IntroEffect {
  constructor(options = {}) {
    this.updateTrace = normalizeUpdateTrace(options.updateTrace);
    this.maxFrame = Math.max(0,
      Math.ceil(interpolateUpdates(this.updateTrace, PARTICLE_REMOVAL) - 1e-9) - 1);
    this.level = options.level ?? null;

    this.fieldOrange = grayFromImageData(options.x12, WIDTH, HEIGHT, 'x12');
    this.fieldIbiza = grayFromImageData(options.x13, WIDTH, HEIGHT, 'x13');
    this.background14 = packedFromImageData(options.x14);
    this.background15 = packedFromImageData(options.x15);
    this.bob = grayFromImageData(options.superBob, 8, 8, 'superBob');

    this.x = new Int32Array(PARTICLES);
    this.y = new Int32Array(PARTICLES);
    this.trail = new Uint32Array(PIXELS);
    this.background = new Uint32Array(PIXELS);
    this.display = new Uint32Array(PIXELS);
    this.displayTrail = new Uint32Array(PIXELS);
    this.imageCache = new WeakMap();
    this.checkpoints = [];
    this.reset();
  }

  reset() {
    this.positionRandomState = PARTICLE_CONSTRUCTOR_SEED;
    for (let index = 0; index < PARTICLES; index++) this.respawn(index);
    // The remaining loading-screen calls are external to this effect, but the
    // replacement particles use that same process-wide state once rendering
    // starts.  Use the exact hand-off rather than replaying unrelated loading.
    this.positionRandomState = PARTICLE_RUNTIME_SEED;
    this.motionRandomState = PARTICLE_MOTION_SEED;
    this.noiseState = NOISE_SEED;
    this.activeParticles = 0;
    this.trail.fill(0);
    this.display.fill(0);
    this.displayTrail.fill(0);
    this.displayNoiseState = NOISE_SEED;
    this.frame = -1;
    this.displayFrame = -1;
    this.checkpoints.length = 0;
  }

  respawn(index) {
    let random = nextPositionRandom(this.positionRandomState, 3);
    this.positionRandomState = random.state;
    let y = random.value * 0xbf00 + 0x100;
    random = nextPositionRandom(this.positionRandomState, 0x1fe00);
    this.positionRandomState = random.state;
    let x = random.value + 0x100;
    if (x < 0x300) x = 0x300;
    else if (x > 0x1fc00) x = 0x1fc00;
    if (y < 0x300) y = 0x300;
    else if (y > 0x17c00) y = 0x17c00;
    this.x[index] = x;
    this.y[index] = y;
  }

  motionRandom(range) {
    const random = nextMotionRandom(this.motionRandomState, range);
    this.motionRandomState = random.state;
    return random.value;
  }

  frameForTime(time) {
    if (time < 0) return -1;
    const clamped = Math.min(time, PARTICLE_REMOVAL);
    const interpolated = interpolateUpdates(this.updateTrace, clamped);
    const updates = time >= PARTICLE_REMOVAL
      ? Math.ceil(interpolated - 1e-9)
      : Math.floor(interpolated + 1e-7);
    return Math.min(this.maxFrame, Math.max(0, updates - 1));
  }

  frameTime(frame) {
    return interpolateTime(this.updateTrace, frame + 1);
  }

  snapshot() {
    this.checkpoints.push({
      frame: this.frame,
      positionRandomState: this.positionRandomState,
      motionRandomState: this.motionRandomState,
      noiseState: this.noiseState,
      activeParticles: this.activeParticles,
      x: this.x.slice(),
      y: this.y.slice(),
      trail: this.trail.slice()
    });
  }

  restore(checkpoint) {
    const saved = this.checkpoints.slice();
    if (!checkpoint) {
      this.reset();
      this.checkpoints = saved;
      return;
    }
    this.frame = checkpoint.frame;
    this.displayFrame = -2;
    this.positionRandomState = checkpoint.positionRandomState;
    this.motionRandomState = checkpoint.motionRandomState;
    this.noiseState = checkpoint.noiseState;
    this.activeParticles = checkpoint.activeParticles;
    this.x.set(checkpoint.x);
    this.y.set(checkpoint.y);
    this.trail.set(checkpoint.trail);
  }

  simulateTo(time, level = this.level) {
    const target = this.frameForTime(time);
    if (target < 0) {
      this.display.fill(0);
      this.displayTrail.fill(0);
      this.displayFrame = -1;
      return;
    }
    if (target === this.frame && target === this.displayFrame) return;

    if (target <= this.frame) {
      let best = null;
      for (const checkpoint of this.checkpoints) {
        if (checkpoint.frame < target && (!best || checkpoint.frame > best.frame)) best = checkpoint;
      }
      this.restore(best);
    }

    while (this.frame < target) {
      const nextFrame = this.frame + 1;
      this.step(nextFrame, this.levelForFrame(nextFrame, level), nextFrame === target);
      this.frame = nextFrame;
      this.displayFrame = nextFrame;
      if ((nextFrame + 1) % CHECKPOINT_INTERVAL === 0 &&
          !this.checkpoints.some(checkpoint => checkpoint.frame === nextFrame)) {
        this.snapshot();
      }
    }
  }

  levelForFrame(frame, source = this.level) {
    if (source == null) {
      return DEFAULT_LEVEL_TRACE[Math.min(DEFAULT_LEVEL_TRACE.length - 1, Math.max(0, frame))];
    }
    if (typeof source === 'function') return source(this.frameTime(frame), frame);
    if (ArrayBuffer.isView(source) || Array.isArray(source)) {
      return source[Math.min(source.length - 1, Math.max(0, frame))] ?? 0;
    }
    return source;
  }

  backgroundProgress(frame) {
    return Math.min(1, Math.max(0, (this.frameTime(frame) - BACKGROUND_MORPH) / 10));
  }

  noiseProgress(frame) {
    const time = this.frameTime(frame);
    if (time < NOISE_IN) return 0;
    if (time < SCENE_END) return Math.min(0.3, time - NOISE_IN);
    return Math.max(0, 0.3 - (time - SCENE_END) / 100);
  }

  step(frame, level, captureDisplay) {
    const time = this.frameTime(frame);
    const boundedLevel = Math.min(255, Math.max(0, level | 0));

    // The executable discards and reallocates sixteen random particles before
    // every update, even before any particle is visible.
    for (let replacement = 0; replacement < 16; replacement++) {
      const index = this.motionRandom(PARTICLES);
      this.respawn(index);
    }

    blendPacked(this.background14, this.background15,
      this.backgroundProgress(frame), this.background);
    const field = time >= PARTICLE_FIELD_CHANGE ? this.fieldIbiza : this.fieldOrange;
    if (time < PARTICLE_MODE_OUT) {
      this.activeParticles = Math.min(PARTICLES, Math.max(0, Math.trunc(time * 256)));
    } else {
      this.activeParticles -= this.activeParticles >> 3;
    }
    const active = this.activeParticles;

    for (let index = 0; index < active; index++) {
      let fixedX = this.x[index];
      let fixedY = this.y[index];
      const x = fixedX >> 8;
      const y = fixedY >> 8;
      const pixel = y * WIDTH + x;

      const base = this.background[pixel];
      const color = ((base >>> 4) & 0x0f0f0f) + 0x1f0f07;
      const fieldPixel = pixel;
      let dx = (field[fieldPixel + 1] - field[fieldPixel - 1]) << 8;
      let dy = (field[fieldPixel + WIDTH] - field[fieldPixel - WIDTH]) << 8;
      if (dx > 1024) dx = 1024;
      else if (dx < -1024) dx = -1024;
      if (dy > 1024) dy = 1024;
      else if (dy < -1024) dy = -1024;

      fixedX = (fixedX + dx) | 0;
      fixedY = (fixedY + dy) | 0;
      // 004058d9 reloads the clamped BASS level from local_8; the earlier
      // `level * 2 - 256` value at 0040578a is passed only to FUN_00405b90,
      // whose allocator ignores all three arguments. Particle displacement is
      // therefore level, or level + 128 where both gradients are near zero.
      const jitter = boundedLevel +
        (Math.abs(dx) < 64 && Math.abs(dy) < 64 ? 128 : 0);
      const randomX = this.motionRandom(3);
      if (randomX < 1) fixedX = (fixedX - jitter * 4) | 0;
      else if (randomX > 1) fixedX = (fixedX + jitter * 4) | 0;
      const randomY = this.motionRandom(3);
      if (randomY < 1) fixedY = (fixedY - jitter * 4) | 0;
      else if (randomY > 1) fixedY = (fixedY + jitter * 4) | 0;

      if (fixedY < 0x300) fixedY = 0x300;
      else if (fixedY > 0x17c00) fixedY = 0x17c00;
      if (fixedX < 0x300) fixedX = 0x300;
      else if (fixedX > 0x1fc00) fixedX = 0x1fc00;
      this.x[index] = fixedX;
      this.y[index] = fixedY;

      const centerX = fixedX >> 8;
      const centerY = fixedY >> 8;
      const firstX = centerX - 3;
      const firstY = centerY - 3;
      for (let drawY = firstY, bobRow = 0; drawY < centerY + 4; drawY++, bobRow += 8) {
        if (drawY < 0 || drawY >= HEIGHT) continue;
        let outPixel = drawY * WIDTH + firstX;
        for (let drawX = firstX, bobPixel = bobRow;
            drawX < centerX + 4; drawX++, bobPixel++, outPixel++) {
          if (drawX < 0 || drawX >= WIDTH) continue;
          const intensity = this.bob[bobPixel];
          const red = (((color >>> 16) & 255) * intensity) >> 8;
          const green = (((color >>> 8) & 255) * intensity) >> 8;
          const blue = ((color & 255) * intensity) >> 8;
          addSaturated(this.trail, outPixel, red, green, blue);
        }
      }
    }

    if (captureDisplay) {
      this.displayTrail.set(this.trail);
      this.displayNoiseState = this.noiseState;
      this.display.set(this.background);
      addPacked(this.display, this.displayTrail);
      scalePacked(this.display, Math.min(1, time / 7));
      this.applyNoise(this.display, frame);
    } else {
      this.advanceNoise(frame);
    }
    decayPacked(this.trail);
  }

  advanceNoise(frame) {
    if (this.noiseProgress(frame) <= 0) return;
    let state = this.noiseState;
    for (let pixel = 0; pixel < PIXELS; pixel++) state = nextNoiseState(state);
    this.noiseState = state;
  }

  applyNoise(buffer, frame) {
    const progress = this.noiseProgress(frame);
    if (progress <= 0) return;
    const weight = easeByte(progress);
    const oldWeight = 255 - weight;
    let state = this.noiseState;
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      state = nextNoiseState(state);
      const noise = state & 255;
      const value = buffer[pixel];
      const red = (((value >>> 16) & 255) * oldWeight + noise * weight) >> 8;
      const green = (((value >>> 8) & 255) * oldWeight + noise * weight) >> 8;
      const blue = ((value & 255) * oldWeight + noise * weight) >> 8;
      buffer[pixel] = (red << 16) | (green << 8) | blue;
    }
    this.noiseState = state;
  }

  render(ctx, musicTime, level = this.level) {
    this.simulateTo(musicTime, level);
    this.writeDisplay(ctx);
  }

  // State immediately after the final scheduled opening-scene noise pass.
  // The noise object itself remains linked after the particle object is
  // removed, so the comic scene continues from this exact private RNG state.
  noiseStateAtParticleRemoval(level = this.level) {
    this.simulateTo(PARTICLE_REMOVAL, level);
    return this.noiseState >>> 0;
  }

  // The native particle object remains scheduled over the comic framebuffer
  // from 25.9 until its unlink callback at 30.7.  This method lets that scene
  // supply the already-rendered lower-priority base while preserving the
  // particle trail and the higher-priority seeded noise pass from this exact
  // update snapshot. `basePixels` may be packed 0x00RRGGBB or RGBA bytes.
  composeOver(ctx, musicTime, basePixels, level = this.level) {
    this.simulateTo(musicTime, level);
    const source = ArrayBuffer.isView(basePixels) ? basePixels : basePixels?.data;
    if (!source) throw new TypeError('basePixels must be packed pixels or RGBA data');
    if (source instanceof Uint32Array && source.length === PIXELS) {
      this.display.set(source);
    } else if (source.length === PIXELS * 4) {
      for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
        this.display[pixel] = (source[offset] << 16) |
          (source[offset + 1] << 8) | source[offset + 2];
      }
    } else {
      throw new RangeError('basePixels must contain exactly 512x384 pixels');
    }
    addPacked(this.display, this.displayTrail);
    scalePacked(this.display, Math.min(1, this.frameTime(this.frame) / 7));
    const advancedNoiseState = this.noiseState;
    this.noiseState = this.displayNoiseState;
    this.applyNoise(this.display, this.frame);
    this.noiseState = advancedNoiseState;
    this.writeDisplay(ctx);
  }

  writeDisplay(ctx) {
    let image = this.imageCache.get(ctx);
    if (!image) {
      image = ctx.createImageData(WIDTH, HEIGHT);
      this.imageCache.set(ctx, image);
    }
    for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
      const value = this.display[pixel];
      image.data[offset] = (value >>> 16) & 255;
      image.data[offset + 1] = (value >>> 8) & 255;
      image.data[offset + 2] = value & 255;
      image.data[offset + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }
}
