/*
 * Packed common-transition chain used from the late x7 strip through Part A.
 *
 * This is the scalar Canvas2D form of demo.exe's persistent scheduler objects:
 *   FUN_00403440  white fade, priority 99
 *   FUN_00405330  x42 / blue(x43) TV overlay, priority 50
 *   FUN_004016d0  live framebuffer -> x45 crossfade, priority 60
 * and the already-complete black object at priority 98.  All arithmetic is
 * performed on integer RGB bytes; Canvas globalAlpha is deliberately avoided.
 */

const WIDTH = 512;
const HEIGHT = 384;
const PIXELS = WIDTH * HEIGHT;
const TRIG_STEP = 0.000766990234375;

const WHITE_CALLBACK = 83.025;
const TERRAIN_CALLBACK = 84.675;
const FEEDBACK_CALLBACK = 103.875;
const X45_CALLBACK = 120.675;

// The decoded seconds are advisory: callback delivery lands between unlocked
// host renders, and the released 30 Hz capture retains a small phase drift
// against that decode. These are the recovered presentation anchors. White
// and terrain are fitted independently from their packed fade states; the
// later callbacks use the 200 ms presentation lead measured in that capture.
const WHITE_PRESENTATION_LEAD = 0.115;
const TERRAIN_PRESENTATION_LEAD = 0.160;
const CALLBACK_PRESENTATION_LEAD = 0.2;
const FEEDBACK_FIRST_UPDATE_LEAD = 0.160;
const WHITE_VISUAL = WHITE_CALLBACK - WHITE_PRESENTATION_LEAD;
const TERRAIN_VISUAL = TERRAIN_CALLBACK - TERRAIN_PRESENTATION_LEAD;
const FEEDBACK_LINK_VISUAL = FEEDBACK_CALLBACK - CALLBACK_PRESENTATION_LEAD;
const FEEDBACK_FIRST_UPDATE_VISUAL = FEEDBACK_CALLBACK - FEEDBACK_FIRST_UPDATE_LEAD;
const X45_VISUAL = X45_CALLBACK - CALLBACK_PRESENTATION_LEAD;

const COS = new Int32Array(8192);
for (let index = 0; index < COS.length; index++) {
  COS[index] = Math.trunc(Math.cos(index * TRIG_STEP) * 8192);
}

function ease256(state) {
  const angle = Math.trunc(state * 4096) & 8191;
  return (8192 - COS[angle]) >> 6;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function rgbaBytes(source, name) {
  const bytes = ArrayBuffer.isView(source) ? source : source?.data;
  if (!bytes || bytes.length !== PIXELS * 4) {
    throw new RangeError(`${name} must contain exactly 512x384 RGBA pixels`);
  }
  return bytes;
}

function packColor(source, name) {
  const rgba = rgbaBytes(source, name);
  const packed = new Uint32Array(PIXELS);
  for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
    packed[pixel] = (rgba[offset] << 16) |
      (rgba[offset + 1] << 8) | rgba[offset + 2];
  }
  return packed;
}

function packBlueMask(source, name) {
  const rgba = rgbaBytes(source, name);
  const mask = new Uint8Array(PIXELS);
  // FUN_00404d40 copies byte zero of native 00RRGGBB.  On Canvas RGBA this is
  // the decoded asset's blue byte, not luminance and not alpha.
  for (let pixel = 0, offset = 2; pixel < PIXELS; pixel++, offset += 4) {
    mask[pixel] = rgba[offset];
  }
  return mask;
}

function whiteStateAt(time) {
  if (time < WHITE_VISUAL) return 0;
  if (time < TERRAIN_VISUAL) return clamp01(time - WHITE_VISUAL);
  // sync_26c0 explicitly stores state=1 before changing direction/duration.
  return clamp01(1 - (time - TERRAIN_VISUAL) / 2);
}

function tvStateAt(time) {
  return time < TERRAIN_VISUAL ? 0 : clamp01(time - TERRAIN_VISUAL);
}

function x45StateAt(time) {
  return time < X45_VISUAL ? 0 : clamp01((time - X45_VISUAL) / 2);
}

export const EARLY_TRANSITION_TIMING = Object.freeze({
  terrainVisual: TERRAIN_VISUAL,
  feedbackLinkVisual: FEEDBACK_LINK_VISUAL,
  feedbackFirstUpdateVisual: FEEDBACK_FIRST_UPDATE_VISUAL,
  feedbackFirstSampleTime: FEEDBACK_CALLBACK
});

export class EarlyTransitionChain {
  constructor(options = {}) {
    this.x45 = packColor(options.x45, 'x45');
    this.x42 = packColor(options.x42, 'x42');
    this.x43 = packBlueMask(options.x43, 'x43');
  }

  applyTV(ctx, time) {
    const state = tvStateAt(time);
    if (state <= 0) return;
    const frame = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    const bytes = frame.data;
    const weight = state >= 1 ? 256 : ease256(state);

    for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
      const mask = state >= 1
        ? this.x43[pixel]
        : Math.imul(this.x43[pixel], weight) >> 8;
      const inverse = 255 - mask;
      const image = this.x42[pixel];
      bytes[offset] = Math.min(255,
        (Math.imul((image >>> 16) & 255, mask) >> 8) +
        (Math.imul(bytes[offset], inverse) >> 8));
      bytes[offset + 1] = Math.min(255,
        (Math.imul((image >>> 8) & 255, mask) >> 8) +
        (Math.imul(bytes[offset + 1], inverse) >> 8));
      bytes[offset + 2] = Math.min(255,
        (Math.imul(image & 255, mask) >> 8) +
        (Math.imul(bytes[offset + 2], inverse) >> 8));
      bytes[offset + 3] = 255;
    }
    ctx.putImageData(frame, 0, 0);
  }

  applyLiveToX45(ctx, time) {
    const state = x45StateAt(time);
    if (state <= 0) return;
    const frame = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    const bytes = frame.data;

    if (state >= 1) {
      for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
        const image = this.x45[pixel];
        bytes[offset] = (image >>> 16) & 255;
        bytes[offset + 1] = (image >>> 8) & 255;
        bytes[offset + 2] = image & 255;
        bytes[offset + 3] = 255;
      }
    } else {
      const secondWeight = ease256(state);
      const firstWeight = 255 - secondWeight;
      for (let pixel = 0, offset = 0; pixel < PIXELS; pixel++, offset += 4) {
        const image = this.x45[pixel];
        bytes[offset] = (Math.imul(bytes[offset], firstWeight) +
          Math.imul((image >>> 16) & 255, secondWeight)) >> 8;
        bytes[offset + 1] = (Math.imul(bytes[offset + 1], firstWeight) +
          Math.imul((image >>> 8) & 255, secondWeight)) >> 8;
        bytes[offset + 2] = (Math.imul(bytes[offset + 2], firstWeight) +
          Math.imul(image & 255, secondWeight)) >> 8;
        bytes[offset + 3] = 255;
      }
    }
    ctx.putImageData(frame, 0, 0);
  }

  applyPersistentFades(ctx, time, blackWeight = 255) {
    // The order-9 black object remains linked after reaching state one.
    // FUN_004032d0 still multiplies by 255/256 at that endpoint on every
    // newly-rendered framebuffer, including frames before white is linked.
    const white = whiteStateAt(time);
    blackWeight = Math.max(0, Math.min(255, Math.trunc(blackWeight)));
    const frame = ctx.getImageData(0, 0, WIDTH, HEIGHT);
    const bytes = frame.data;

    if (white >= 1) {
      for (let offset = 0; offset < bytes.length; offset += 4) {
        bytes[offset] = 255;
        bytes[offset + 1] = 255;
        bytes[offset + 2] = 255;
        bytes[offset + 3] = 255;
      }
    } else {
      const whiteWeight = white > 0 ? ease256(white) : 0;
      const oldWeight = 255 - whiteWeight;
      for (let offset = 0; offset < bytes.length; offset += 4) {
        // Priority 98 black first, then priority 99 white.  The white object's
        // state-zero special case is a no-op; it must not darken a second time.
        let red = Math.imul(bytes[offset], blackWeight) >> 8;
        let green = Math.imul(bytes[offset + 1], blackWeight) >> 8;
        let blue = Math.imul(bytes[offset + 2], blackWeight) >> 8;
        if (white > 0) {
          red = Math.min(255, (Math.imul(red, oldWeight) >> 8) + whiteWeight);
          green = Math.min(255, (Math.imul(green, oldWeight) >> 8) + whiteWeight);
          blue = Math.min(255, (Math.imul(blue, oldWeight) >> 8) + whiteWeight);
        }
        bytes[offset] = red;
        bytes[offset + 1] = green;
        bytes[offset + 2] = blue;
        bytes[offset + 3] = 255;
      }
    }
    ctx.putImageData(frame, 0, 0);
  }
}
