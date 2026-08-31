// Executable-faithful ports of the two 16,000-particle effects in demo.exe.
//
// The original effects are frame stepped, not delta-time integrated.  Their
// effective host cadence is recovered per scene from the released capture;
// skipped frames are reconstructed deterministically for browser seeking.

const WIDTH = 512;
const HEIGHT = 384;
const PIXELS = WIDTH * HEIGHT;
const COUNT = 16000;
// Released-capture fitting places scene construction/removal 200 ms before
// the decoded XM cues. The exact shared-RNG handoff proves that this interval
// contains 1,008 native renderer invocations on the reference run. Frame zero
// does not reach the PTC surface until the next completed host pass. A
// frame-zero particle is still black (the constructor's particles have no
// color), which is why the captured x45 frame remains visually unchanged
// until the following pass.
const PART_A_START = 122.875;
const PART_A_FIRST_RENDER = 122.936;
const PART_A_END = 139.275;
const PART_A_UPDATES = 1008;
const PART_A_FPS = PART_A_UPDATES / (PART_A_END - PART_A_START);
// ptc_timer_time() runs independently from the encoded music clock.  Spark
// centers in the first visible frame and the dense 130 s frame both resolve
// the same 80 ms offset.
export const PART_A_TIMER_LEAD = 0.080;
// The released executable is uncapped.  These cumulative native-call anchors
// preserve its measured change in host cadence while the endpoint is fixed by
// the process-RNG checksum (1,008 calls / 166,706 respawns).
export const PART_A_UPDATE_TRACE = Object.freeze([
  Object.freeze({ time: PART_A_FIRST_RENDER, updates: 1 }),
  Object.freeze({ time: 123.000, updates: 5 }),
  Object.freeze({ time: 130.000, updates: 451 }),
  Object.freeze({ time: PART_A_END, updates: PART_A_UPDATES })
]);
// The Part B callback is likewise observed 200 ms ahead of its nominal XM
// position. Across five independent reference frames its persistent trails
// resolve to exactly 60 native renderer invocations per second.  Order 48
// row 60 only starts the persistent noise layer; sync_2ba0 removes Part B at
// the first order-49 callback, 1.8 seconds later.
const GALAXY_START = 225.675;
const GALAXY_END = 254.475;
const GALAXY_FPS = 60;
const GALAXY_TIMER_LEAD = 0.073;
// Exact double at demo.exe:00439b68 (1 / UINT32_MAX, not 1 / 2^32).
const UINT32_SCALE = 1 / 0xffffffff;
const CHECKPOINT_INTERVAL = 120;

// After the loader, opening constructor, and the opening scene's exact 1,031
// updates, the shared process generator enters Part A in this state.  Its
// 166,706 respawns consume 1,166,942 values and land at 0x78187521, the exact
// pre-state recovered for the first rock velocity callback.
const PART_A_SEED = 0x11b72146;
// IFS resets the shared generator to zero on every render and consumes one
// value for each of its 40,000 points.  No later recovered scene consumes this
// generator before Part B, making this the reproducible hand-off seed.
const IFS_EXIT_SEED = 0x3c736a02;
const TRIG_STEP = 0.000766990234375; // exact double at 00439b60

const SIN = new Int32Array(8192);
const COS = new Int32Array(8192);
for (let index = 0; index < 8192; index++) {
  const angle = index * TRIG_STEP;
  SIN[index] = Math.trunc(Math.sin(angle) * 8192);
  COS[index] = Math.trunc(Math.cos(angle) * 8192);
}

function sinQ13(angle) {
  return SIN[angle & 8191];
}

function cosQ13(angle) {
  return COS[angle & 8191];
}

function wave(q, frequency) {
  return sinQ13(Math.trunc(q * frequency));
}

function interpolateUpdates(trace, time) {
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

function rotl32(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function nextDemoRandom(state, range) {
  const next = (rotl32((state + 157) >>> 0, 11) ^ 157) >>> 0;
  return {
    state: next,
    value: Math.trunc(next * UINT32_SCALE * range)
  };
}

function addPackedPixel(buffer, pixel, color, weight) {
  // This is the component-wise equivalent of the MMX-era packed saturating
  // add in FUN_00409920.  Every contribution is even and clips at 254.
  const old = buffer[pixel];
  const blue = Math.min(254,
    (old & 0xfe) + (((color & 0xff) * weight >> 8) & 0xfe));
  const green = Math.min(254,
    ((old >>> 8) & 0xfe) + ((((color >>> 8) & 0xff) * weight >> 8) & 0xfe));
  const red = Math.min(254,
    ((old >>> 16) & 0xfe) + ((((color >>> 16) & 0xff) * weight >> 8) & 0xfe));
  buffer[pixel] = (red << 16) | (green << 8) | blue;
}

function projectParticle(buffer, x, y, z, color) {
  const near = 4096;
  const depth = (z >> 4) + near;
  if (depth <= 0) return;

  let zClamp = z - near;
  if (zClamp < -near) zClamp = -near;
  else if (zClamp > near) zClamp = near;
  const brightness = Math.trunc(((near * 2 - zClamp) * 1024) / (near * 2));

  const fixedX = (Math.trunc(Math.imul(x, 16002) / depth) - 512 + 256 * 1024) | 0;
  const fixedY = (Math.trunc(Math.imul(y, 16002) / depth) - 512 + 192 * 1024) | 0;
  const ix = fixedX >> 10;
  const iy = fixedY >> 10;
  const fx = fixedX & 1023;
  const fy = fixedY & 1023;

  const invX = 1023 - fx;
  const invY = 1023 - fy;
  const w00 = Math.imul(Math.imul(invY, invX) >> 12, brightness) >> 12;
  const w10 = Math.imul(Math.imul(invY, fx) >> 12, brightness) >> 12;
  const w01 = Math.imul(Math.imul(fy, invX) >> 12, brightness) >> 12;
  const w11 = Math.imul(Math.imul(fy, fx) >> 12, brightness) >> 12;
  const pixel = iy * WIDTH + ix;

  if (ix > 1 && iy > 1 && ix < WIDTH - 1 && iy < HEIGHT - 1) {
    addPackedPixel(buffer, pixel, color, w00);
  }
  if (ix + 1 > 1 && iy > 1 && ix + 1 < WIDTH - 1 && iy < HEIGHT - 1) {
    addPackedPixel(buffer, pixel + 1, color, w10);
  }
  if (ix > 1 && iy + 1 > 1 && ix < WIDTH - 1 && iy + 1 < HEIGHT - 1) {
    addPackedPixel(buffer, pixel + WIDTH, color, w01);
  }
  if (ix + 1 > 1 && iy + 1 > 1 && ix + 1 < WIDTH - 1 && iy + 1 < HEIGHT - 1) {
    addPackedPixel(buffer, pixel + WIDTH + 1, color, w11);
  }
}

function blurTrail(buffer) {
  // FUN_0040b810/FUN_0040c1f0 use the four cardinal neighbours and subtract
  // avg/64.  Borders are deliberately left untouched.
  for (let y = 1; y < HEIGHT - 1; y++) {
    let pixel = y * WIDTH + 1;
    const end = pixel + WIDTH - 2;
    for (; pixel < end; pixel++) {
      const left = buffer[pixel - 1];
      const right = buffer[pixel + 1];
      const up = buffer[pixel - WIDTH];
      const down = buffer[pixel + WIDTH];

      const redSum = ((left >>> 16) & 0xff) + ((right >>> 16) & 0xff) +
        ((up >>> 16) & 0xff) + ((down >>> 16) & 0xff);
      const greenSum = ((left >>> 8) & 0xff) + ((right >>> 8) & 0xff) +
        ((up >>> 8) & 0xff) + ((down >>> 8) & 0xff);
      const blueSum = (left & 0xff) + (right & 0xff) + (up & 0xff) + (down & 0xff);

      const redAverage = redSum >> 2;
      const greenAverage = greenSum >> 2;
      const blueAverage = blueSum >> 2;
      const red = redAverage - (redAverage >> 6);
      const green = greenAverage - (greenAverage >> 6);
      const blue = blueAverage - (blueAverage >> 6);
      // Deliberately in-place: left/up have already been filtered while
      // right/down still contain their previous values, matching the x86 loop.
      buffer[pixel] = (red << 16) | (green << 8) | blue;
    }
  }
}

class ParticleScene {
  constructor(kind, start, end, fps, seed, timing = {}) {
    this.kind = kind;
    this.start = start;
    this.fps = fps;
    this.updateTrace = timing.updateTrace || null;
    this.clockLead = timing.clockLead || 0;
    this.maxFrame = this.updateTrace
      ? this.updateTrace[this.updateTrace.length - 1].updates - 1
      : Math.max(0, Math.ceil((end - start) * fps - 1e-9) - 1);
    this.initialSeed = seed >>> 0;

    this.x = new Int32Array(COUNT);
    this.y = new Int32Array(COUNT);
    this.z = new Int32Array(COUNT);
    this.vx = new Int32Array(COUNT);
    this.vy = new Int32Array(COUNT);
    this.vz = new Int32Array(COUNT);
    this.life = new Int16Array(COUNT);
    this.color = new Uint32Array(COUNT);
    this.trail = new Uint32Array(PIXELS);
    this.display = new Uint32Array(PIXELS);
    this.checkpoints = [];
    this.reset();
  }

  reset() {
    this.x.fill(0);
    this.y.fill(0);
    this.z.fill(0);
    this.vx.fill(0);
    this.vy.fill(0);
    this.vz.fill(0);
    this.color.fill(0);
    this.trail.fill(0);
    this.display.fill(0);
    for (let index = 0; index < COUNT; index++) this.life[index] = index & 127;
    this.randomState = this.initialSeed;
    this.frame = -1;
    this.displayFrame = -1;
    this.phase = 121038543;
    this.sign = -1;
    this.checkpoints.length = 0;
  }

  random(range) {
    const result = nextDemoRandom(this.randomState, range);
    this.randomState = result.state;
    return result.value;
  }

  snapshot() {
    this.checkpoints.push({
      frame: this.frame,
      randomState: this.randomState,
      phase: this.phase,
      sign: this.sign,
      x: this.x.slice(),
      y: this.y.slice(),
      z: this.z.slice(),
      vx: this.vx.slice(),
      vy: this.vy.slice(),
      vz: this.vz.slice(),
      life: this.life.slice(),
      color: this.color.slice(),
      trail: this.trail.slice()
    });
  }

  restore(checkpoint) {
    if (!checkpoint) {
      const savedCheckpoints = this.checkpoints;
      this.checkpoints = [];
      this.reset();
      this.checkpoints = savedCheckpoints;
      return;
    }
    this.frame = checkpoint.frame;
    this.displayFrame = -2;
    this.randomState = checkpoint.randomState;
    this.phase = checkpoint.phase;
    this.sign = checkpoint.sign;
    this.x.set(checkpoint.x);
    this.y.set(checkpoint.y);
    this.z.set(checkpoint.z);
    this.vx.set(checkpoint.vx);
    this.vy.set(checkpoint.vy);
    this.vz.set(checkpoint.vz);
    this.life.set(checkpoint.life);
    this.color.set(checkpoint.color);
    this.trail.set(checkpoint.trail);
  }

  frameForTime(time) {
    if (this.updateTrace) {
      if (time < this.updateTrace[0].time) return -1;
      const updates = time >= this.updateTrace[this.updateTrace.length - 1].time
        ? this.updateTrace[this.updateTrace.length - 1].updates
        : Math.floor(interpolateUpdates(this.updateTrace, time) + 1e-7);
      return Math.min(this.maxFrame, Math.max(0, updates - 1));
    }
    if (time < this.start) return -1;
    return Math.min(this.maxFrame,
      Math.max(0, Math.floor((time - this.start) * this.fps + 1e-7)));
  }

  frameTime(frame) {
    if (this.updateTrace) {
      return interpolateTime(this.updateTrace, frame + 1) + this.clockLead;
    }
    return this.start + frame / this.fps + this.clockLead;
  }

  simulateTo(time) {
    const target = this.frameForTime(time);
    if (target < 0) {
      this.display.fill(0);
      this.displayFrame = -1;
      return;
    }
    if (target === this.frame && this.displayFrame === target) return;

    if (target <= this.frame) {
      let best = null;
      for (const checkpoint of this.checkpoints) {
        // A checkpoint stores post-blur state, not that frame's pre-blur
        // display, so restore a frame strictly before the requested one.
        if (checkpoint.frame < target && (!best || checkpoint.frame > best.frame)) {
          best = checkpoint;
        }
      }
      this.restore(best);
    }

    while (this.frame < target) {
      const nextFrame = this.frame + 1;
      const frameTime = this.frameTime(nextFrame);
      const previousTime = nextFrame === 0 ? frameTime : this.frameTime(nextFrame - 1);
      this.step(frameTime, nextFrame === 0 ? 0 : frameTime - previousTime,
        nextFrame === target);
      this.frame = nextFrame;
      this.displayFrame = nextFrame;
      if ((this.frame + 1) % CHECKPOINT_INTERVAL === 0 &&
          !this.checkpoints.some(checkpoint => checkpoint.frame === this.frame)) {
        this.snapshot();
      }
    }
  }

  step(time, dt, captureDisplay) {
    const angleX = this.kind === 'a'
      ? sinQ13(Math.trunc(time * 33))
      : Math.trunc(sinQ13(Math.trunc(time * 33)) / 16);
    const angleY = this.kind === 'a'
      ? Math.trunc(sinQ13(Math.trunc(time * 66)) / 2)
      : Math.trunc(time * 166);
    const angleZ = this.kind === 'a'
      ? Math.trunc(sinQ13(Math.trunc(time * 10)) / 4)
      : Math.trunc(sinQ13(Math.trunc(time * 10)) / 8);

    const sinX = sinQ13(angleX);
    const cosX = cosQ13(angleX);
    const sinY = sinQ13(angleY);
    const cosY = cosQ13(angleY);
    const sinZ = sinQ13(angleZ);
    const cosZ = cosQ13(angleZ);

    for (let index = 0; index < COUNT; index++) {
      const px = this.x[index];
      const py = this.y[index];
      const pz = this.z[index];

      // Fixed-point matrix in the same operation order as 40_b810/40_c1f0.
      const yz = (Math.imul(py, cosZ) + Math.imul(px, sinZ)) >> 13;
      const xz = (Math.imul(px, cosZ) - Math.imul(py, sinZ)) >> 13;
      const xr = (Math.imul(xz, cosY) - Math.imul(pz, sinY)) >> 13;
      const zy = (Math.imul(pz, cosY) + Math.imul(xz, sinY)) >> 13;
      const yr = (Math.imul(yz, cosX) - Math.imul(zy, sinX)) >> 13;
      const zr = (Math.imul(yz, sinX) + Math.imul(zy, cosX)) >> 13;
      projectParticle(this.trail, xr, yr, zr, this.color[index]);

      this.x[index] = (px + this.vx[index]) | 0;
      this.y[index] = (py + this.vy[index]) | 0;
      this.z[index] = (pz + this.vz[index]) | 0;
      const life = this.life[index] - 1;
      this.life[index] = life;
      if (life <= 0) {
        if (this.kind === 'a') this.respawnPartA(index, time);
        else {
          this.respawnGalaxy(index, this.sign < 0);
          this.sign = -this.sign;
          this.phase += dt * 0.5;
        }
      }
    }

    // The live output receives the persistent buffer before its neighbour
    // blur prepares the trails for the next frame.
    if (captureDisplay) this.display.set(this.trail);
    blurTrail(this.trail);
  }

  respawnPartA(index, time) {
    const q = Math.trunc(time * 416);
    if ((index & 1) === 0) {
      this.x[index] = (((wave(q, 1.1) * 2 + wave(q, 3.1)) * 2 + wave(q, 6.6)) + wave(q, 4.3)) | 0;
      this.y[index] = (((wave(q, 2.1) * 2 + wave(q, 3.2)) * 2 + wave(q, 5.6)) + wave(q, 7.1)) | 0;
      this.z[index] = (((wave(q, 1.8) * 2 + wave(q, 5.7)) * 2 + wave(q, 5.1)) + wave(q, 9.1)) | 0;
      this.vx[index] = this.random(1024) - 512;
      this.vy[index] = this.random(1024) - 512;
      this.vz[index] = this.random(1024) - 512;
      const red = this.random(16) + 240;
      const green = this.random(96) + 128;
      const blue = this.random(96) + 64;
      this.color[index] = (red << 16) | (green << 8) | blue;
    } else {
      this.x[index] = (((wave(q, 3.1) * 2 + wave(q, 5.1)) * 2 + wave(q, 1.3)) + wave(q, 3.6)) | 0;
      this.y[index] = (((wave(q, 1.1) * 2 + wave(q, 4.2)) * 2 + wave(q, 4.6)) + wave(q, 5.1)) | 0;
      this.z[index] = (((wave(q, 4.8) * 2 + wave(q, 2.7)) * 2 + wave(q, 8.1)) + wave(q, 2.1)) | 0;
      this.vx[index] = this.random(1024) - 512;
      this.vy[index] = this.random(1024) - 512;
      this.vz[index] = this.random(1024) - 512;
      const blue = this.random(16) + 240;
      const green = this.random(96) + 128;
      const red = this.random(96) + 64;
      this.color[index] = (red << 16) | (green << 8) | blue;
    }
    this.life[index] = this.random(64) + 64;
  }

  respawnGalaxy(index, negativeArm) {
    const q = Math.trunc(this.phase);
    const radialFrequencies = negativeArm
      ? [12.2, 11.2, 13.2, 19.1]
      : [13.1, 12.0, 13.5, 16.3];
    const verticalFrequencies = negativeArm
      ? [22.1, 43.2, 15.6, 57.1]
      : [22.3, 41.2, 15.7, 57.5];

    const radialSum = wave(q, radialFrequencies[0]) + wave(q, radialFrequencies[1]) +
      wave(q, radialFrequencies[2]) + wave(q, radialFrequencies[3]) + 32768;
    const rr = radialSum >> 4;
    const radius = Math.imul(rr, rr) >> 12;
    const envelope = (cosQ13(radius) + 8192) >> 1;
    const angle = q << 7;
    const vertical = ((wave(q, verticalFrequencies[0]) * 2 +
      wave(q, verticalFrequencies[1])) * 2 + wave(q, verticalFrequencies[2]) +
      wave(q, verticalFrequencies[3])) | 0;

    this.x[index] = Math.imul(sinQ13(angle), radius) >> 9;
    this.y[index] = Math.imul(vertical, envelope) >> (negativeArm ? 14 : 15);
    this.z[index] = Math.imul(cosQ13(angle), radius) >> 9;
    this.vx[index] = this.random(256) - 128;
    this.vy[index] = this.random(64) - 32;
    this.vz[index] = this.random(256) - 128;

    if (negativeArm) {
      const red = this.random(64) + 64;
      const green = this.random(96) + 128;
      const blue = this.random(16) + 240;
      this.color[index] = (red << 16) | (green << 8) | blue;
    } else {
      const green = this.random(16) + 240;
      const red = this.random(64) + 64;
      const blue = this.random(96) + 128;
      this.color[index] = (red << 16) | (green << 8) | blue;
    }
    this.life[index] = this.random(64) + 64;
  }
}

function compositeDisplay(ctx, words, imageCache) {
  let image = imageCache.get(ctx);
  if (!image) {
    image = ctx.createImageData(WIDTH, HEIGHT);
    imageCache.set(ctx, image);
  }

  // Read the already-rendered layer because the executable saturating-added
  // particles over the scheduler's current framebuffer (Part A retains x45).
  const base = ctx.getImageData(0, 0, WIDTH, HEIGHT);
  const source = base.data;
  for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
    const packed = words[pixel];
    image.data[offset] = Math.min(255, source[offset] + ((packed >>> 16) & 0xff));
    image.data[offset + 1] = Math.min(255, source[offset + 1] + ((packed >>> 8) & 0xff));
    image.data[offset + 2] = Math.min(255, source[offset + 2] + (packed & 0xff));
    image.data[offset + 3] = source[offset + 3];
  }
  ctx.putImageData(image, 0, 0);
}

export class ParticleEffects {
  constructor() {
    this.partA = new ParticleScene('a', PART_A_START, PART_A_END,
      PART_A_FPS, PART_A_SEED, {
        updateTrace: PART_A_UPDATE_TRACE,
        clockLead: PART_A_TIMER_LEAD
      });
    this.galaxy = new ParticleScene('b', GALAXY_START, GALAXY_END,
      GALAXY_FPS, IFS_EXIT_SEED, {
        clockLead: GALAXY_TIMER_LEAD
      });
    this.imageCache = new WeakMap();
  }

  renderPartA(ctx, musicTime) {
    this.partA.simulateTo(musicTime);
    compositeDisplay(ctx, this.partA.display, this.imageCache);
  }

  renderGalaxy(ctx, musicTime) {
    this.galaxy.simulateTo(musicTime);
    compositeDisplay(ctx, this.galaxy.display, this.imageCache);
  }
}
