/*
 * Exact software port of the first x28/comic sequence in demo.exe.
 *
 * Native objects and callbacks:
 *   00403640 / 004036a0  x28 grid warp (priority 1)
 *   00401900 / 00401990  masked comic dissolves (priority 2)
 *   00401650 / 004016d0  x15 -> scene entry dissolve (priority 5)
 *   00403270 / 004032d0  fade to black (priority 98)
 *   00406d50 / 00406de0  fading seeded noise (priority 666)
 *
 * Callback constants below are the port's legacy nominal/capture cue anchors
 * for the visual scheduler, not exact BASS mixer-frame timestamps. Released-
 * capture fitting supplies the separate visual lead.
 */

const WIDTH = 512;
const HEIGHT = 384;
const PIXELS = WIDTH * HEIGHT;
const TRIG_STEP = 0.000766990234375;

const ENTRY = 25.890249;
const PARTICLE_REMOVAL = 30.696780;
const BLACK = 59.477914;
// A 28-frame sweep over all six page changes and the black fade minimizes
// released-capture RGB MAE here: .027762 versus .027855 at .12 and .028204
// at .14. BASS callback delivery is asynchronous, so the video fit—not the
// nominal buffer length—is the presentation-clock authority.
const DEFAULT_SYNC_LEAD = 0.13;

const TRANSITIONS = Object.freeze([
  Object.freeze({ at: 30.696780, first: 'x17', second: 'x29', firstMask: 'x18', secondMask: 'x32' }),
  Object.freeze({ at: 35.491701, first: 'x29', second: 'x30', firstMask: 'x32', secondMask: 'x33' }),
  Object.freeze({ at: 40.286621, first: 'x30', second: 'x31', firstMask: 'x33', secondMask: 'x34' }),
  Object.freeze({ at: 45.081542, first: 'x31', second: 'x35', firstMask: 'x34', secondMask: 'x38' }),
  Object.freeze({ at: 49.888073, first: 'x35', second: 'x36', firstMask: 'x38', secondMask: 'x39' }),
  Object.freeze({ at: 54.682993, first: 'x36', second: 'x37', firstMask: 'x39', secondMask: 'x40' })
]);

const COS = new Int32Array(8192);
for (let index = 0; index < COS.length; index++) {
  COS[index] = Math.trunc(Math.cos(index * TRIG_STEP) * 8192);
}

function easeByte(progress) {
  if (progress <= 0) return 0;
  if (progress >= 1) return 256;
  const angle = Math.trunc(progress * 4096) & 8191;
  return (8192 - COS[angle]) >> 6;
}

function rgbaSource(source, name) {
  const data = ArrayBuffer.isView(source) ? source : source?.data;
  if (!data || data.length !== PIXELS * 4) {
    throw new RangeError(`${name} must contain exactly 512x384 RGBA pixels`);
  }
  return data;
}

function packColor(source, name) {
  const rgba = rgbaSource(source, name);
  const packed = new Uint32Array(PIXELS);
  for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
    packed[pixel] = (rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2];
  }
  return packed;
}

function packMask(source, name) {
  const rgba = rgbaSource(source, name);
  const mask = new Uint8Array(PIXELS);
  // FUN_00404d40 copies the low byte from each 00RRGGBB pixel.  That is the
  // JPEG's blue channel on the little-endian PTC surface.
  for (let pixel = 0, offset = 2; pixel < PIXELS; pixel++, offset += 4) {
    mask[pixel] = rgba[offset];
  }
  return mask;
}

function blendChannel(first, second, firstWeight, secondWeight) {
  return (first * firstWeight + second * secondWeight) >> 8;
}

function blendMaskedChannel(first, second, firstWeight, secondWeight) {
  return ((first * firstWeight) >> 8) + ((second * secondWeight) >> 8);
}

function blendPacked(first, second, progress, target) {
  if (progress <= 0) {
    target.set(first);
    return;
  }
  if (progress >= 1) return;
  const secondWeight = easeByte(progress);
  const firstWeight = 255 - secondWeight;
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const a = first[pixel];
    const b = second[pixel];
    const red = blendChannel((a >>> 16) & 255, (b >>> 16) & 255,
      firstWeight, secondWeight);
    const green = blendChannel((a >>> 8) & 255, (b >>> 8) & 255,
      firstWeight, secondWeight);
    const blue = blendChannel(a & 255, b & 255, firstWeight, secondWeight);
    target[pixel] = (red << 16) | (green << 8) | blue;
  }
}

// Literal scalar form of FUN_00401990.  The native routine first blends the
// two colors and masks, then applies that mask over the already-rendered x28
// framebuffer.  Every stage divides by 256, including 255-valued masks.
function compositeMasked(target, first, second, firstMask, secondMask, progress) {
  let secondWeight;
  let firstWeight;
  if (progress <= 0) {
    secondWeight = 0;
    firstWeight = 256;
  } else if (progress >= 1) {
    secondWeight = 256;
    firstWeight = 0;
  } else {
    secondWeight = easeByte(progress);
    firstWeight = 255 - secondWeight;
  }

  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const old = target[pixel];
    const a = first[pixel];
    const b = second[pixel];
    const mask = progress <= 0
      ? firstMask[pixel]
      : progress >= 1
        ? secondMask[pixel]
        : (firstMask[pixel] * firstWeight + secondMask[pixel] * secondWeight) >> 8;
    const inverseMask = 255 - mask;

    let red;
    let green;
    let blue;
    if (progress <= 0) {
      red = (a >>> 16) & 255;
      green = (a >>> 8) & 255;
      blue = a & 255;
    } else if (progress >= 1) {
      red = (b >>> 16) & 255;
      green = (b >>> 8) & 255;
      blue = b & 255;
    } else {
      red = blendMaskedChannel((a >>> 16) & 255, (b >>> 16) & 255,
        firstWeight, secondWeight);
      green = blendMaskedChannel((a >>> 8) & 255, (b >>> 8) & 255,
        firstWeight, secondWeight);
      blue = blendMaskedChannel(a & 255, b & 255, firstWeight, secondWeight);
    }

    red = blendMaskedChannel(red, (old >>> 16) & 255, mask, inverseMask);
    green = blendMaskedChannel(green, (old >>> 8) & 255, mask, inverseMask);
    blue = blendMaskedChannel(blue, old & 255, mask, inverseMask);
    target[pixel] = (red << 16) | (green << 8) | blue;
  }
}

function scalePacked(target, progress) {
  if (progress <= 0) {
    target.fill(0);
    return;
  }
  // FUN_004032d0 applies the 255/256 integer endpoint even at state 1.0.
  const weight = Math.min(255, easeByte(Math.min(1, progress)));
  for (let pixel = 0; pixel < PIXELS; pixel++) {
    const value = target[pixel];
    const red = ((value >>> 16) & 255) * weight >> 8;
    const green = ((value >>> 8) & 255) * weight >> 8;
    const blue = (value & 255) * weight >> 8;
    target[pixel] = (red << 16) | (green << 8) | blue;
  }
}

function rotl32(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function nextNoiseState(state) {
  return (rotl32((state ^ 157) >>> 0, 11) + 157) >>> 0;
}

// Release-run continuation of FUN_00406de0.  The opening effect hands off
// after update 1,031; comic host frames 0..1,321 consume noise and the state
// then remains dormant until the later tracker callback raises its amount.
export const COMIC_NOISE_CONTINUITY = Object.freeze({
  dormantState: 0x5728718e
});

export class ComicEffect {
  constructor(options = {}) {
    this.warp = options.warp;
    this.intro = options.intro;
    if (!this.warp || !this.intro) throw new TypeError('ComicEffect requires warp and intro effects');
    this.syncLead = options.syncLead ?? DEFAULT_SYNC_LEAD;
    if (!Number.isFinite(this.syncLead)) throw new RangeError('syncLead must be finite');

    const colors = ['x15', 'x17', 'x29', 'x30', 'x31', 'x35', 'x36', 'x37'];
    const masks = ['x18', 'x32', 'x33', 'x34', 'x38', 'x39', 'x40'];
    this.colors = Object.fromEntries(colors.map(name => [name, packColor(options[name], name)]));
    this.masks = Object.fromEntries(masks.map(name => [name, packMask(options[name], name)]));
    this.frame = new Uint32Array(PIXELS);
    this.imageDataByContext = new WeakMap();
    // Seed before each post-particle host-frame noise pass.  Populated lazily
    // so direct seeks and continuous playback share the same native sequence.
    this.lateNoiseSeeds = [];
  }

  transitionAt(callbackTime) {
    return callbackTime - this.syncLead;
  }

  buildLowerLayers(time) {
    const state = this.warp.stateForTime(time, false);
    this.frame.set(this.warp.renderStatePacked(state.engineTime, state.impact, state.phase));

    const eventTime = time + this.syncLead;
    let transition = TRANSITIONS[0];
    let progress = 0;
    for (let index = 0; index < TRANSITIONS.length; index++) {
      if (eventTime < TRANSITIONS[index].at) break;
      transition = TRANSITIONS[index];
      progress = Math.min(1, eventTime - transition.at);
    }
    compositeMasked(this.frame,
      this.colors[transition.first], this.colors[transition.second],
      this.masks[transition.firstMask], this.masks[transition.secondMask], progress);

    // The entry object blends static x15 into the framebuffer pointer.  Once
    // it reaches one its second source and destination are identical, so it
    // becomes a no-op until the 35.5 callback unlinks it.
    const entryProgress = eventTime - ENTRY;
    if (entryProgress < 1) blendPacked(this.colors.x15, this.frame, entryProgress, this.frame);
    return this.frame;
  }

  applyLateNoise(time) {
    const eventTime = time + this.syncLead;
    const amount = Math.max(0, 0.3 - (eventTime - 23.1) / 100);
    if (amount <= 0) return;
    const noiseWeight = easeByte(amount);
    const oldWeight = 255 - noiseWeight;
    const hostFrame = Math.max(0, Math.floor(
      (eventTime - PARTICLE_REMOVAL) * this.warp.fps + 1e-7));
    let state = this.lateNoiseStateForFrame(hostFrame);
    for (let pixel = 0; pixel < PIXELS; pixel++) {
      state = nextNoiseState(state);
      const noise = state & 255;
      const value = this.frame[pixel];
      const red = (((value >>> 16) & 255) * oldWeight + noise * noiseWeight) >> 8;
      const green = (((value >>> 8) & 255) * oldWeight + noise * noiseWeight) >> 8;
      const blue = ((value & 255) * oldWeight + noise * noiseWeight) >> 8;
      this.frame[pixel] = (red << 16) | (green << 8) | blue;
    }
    // Avoid replaying this frame's 196,608 permutation steps on the normal
    // next-frame path.  Sparse forward seeks fill every intermediate seed in
    // lateNoiseStateForFrame, preserving the same state continuity.
    if (this.lateNoiseSeeds.length === hostFrame + 1) {
      this.lateNoiseSeeds.push(state);
    }
  }

  lateNoiseStateForFrame(hostFrame) {
    if (this.lateNoiseSeeds.length === 0) {
      // simulateTo captures the last scheduled intro render and leaves
      // noiseState immediately after that frame's 512x384 noise pass.
      this.lateNoiseSeeds.push(this.intro.noiseStateAtParticleRemoval());
    }
    let state = this.lateNoiseSeeds[this.lateNoiseSeeds.length - 1];
    while (this.lateNoiseSeeds.length <= hostFrame) {
      for (let pixel = 0; pixel < PIXELS; pixel++) state = nextNoiseState(state);
      this.lateNoiseSeeds.push(state);
    }
    return this.lateNoiseSeeds[hostFrame];
  }

  write(ctx) {
    let image = this.imageDataByContext.get(ctx);
    if (!image) {
      image = ctx.createImageData(WIDTH, HEIGHT);
      this.imageDataByContext.set(ctx, image);
    }
    for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
      const value = this.frame[pixel];
      image.data[offset] = (value >>> 16) & 255;
      image.data[offset + 1] = (value >>> 8) & 255;
      image.data[offset + 2] = value & 255;
      image.data[offset + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }

  render(ctx, time) {
    const entryAt = this.transitionAt(ENTRY);
    if (time < entryAt) {
      this.intro.render(ctx, time);
      return;
    }

    this.buildLowerLayers(time);
    const particleRemovalAt = this.transitionAt(PARTICLE_REMOVAL);
    if (time < particleRemovalAt) {
      // Feed the music time shifted to the callback-visible clock so mode-out
      // and the entry dissolve start on the same host frame.
      this.intro.composeOver(ctx, time + this.syncLead, this.frame);
      return;
    }

    const blackProgress = time + this.syncLead - BLACK;
    // The priority-98 layer remains linked at endpoint one, which is still a
    // 255/256 multiply. Priority-666 noise is composited after it.
    scalePacked(this.frame, blackProgress > 0 ? 1 - blackProgress : 1);
    this.applyLateNoise(time);
    this.write(ctx);
  }
}
