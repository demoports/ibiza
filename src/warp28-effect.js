/*
 * Exact software port of demo.exe's x28 warp (004035f0..00403c8f).
 *
 * The executable constructs two instances over data/x28.jpg.  The first is
 * inserted at XM order 1, receives instrument-33 impact callbacks, and is
 * removed at order 9. The 23.1/63.0 scheduler values below are capture/PTC
 * anchors; the mixer row-zero frames are 1,018,248 and 2,777,040. The second
 * is reset at the first order-49 visit (mixer frame 11,226,074); its separately
 * fitted 254.675 cue keeps zero impact/phase state throughout the finale.
 *
 * `renderStateRGBA` is the literal low-level renderer.  `renderRGBA` and
 * `render` reconstruct the two instances' callback state for arbitrary seeks.
 */

const WIDTH = 512;
const HEIGHT = 384;
const TEXTURE_SIZE = 512;
const TEXTURE_PIXELS = TEXTURE_SIZE * TEXTURE_SIZE;
const TEXTURE_MASK = TEXTURE_PIXELS - 1;
const SCREEN_PIXELS = WIDTH * HEIGHT;

const FIRST_START = 23.1;
const PHASE_RESET = 42.3;
const FINALE_VISUAL_START = 254.475;

// The original advances its impact decay once per host render.  The release
// capture resolves the same approximately 59 Hz host cadence as the other
// lightweight grid effects.  The timer itself leads the encoded XM/video
// clock slightly because it is started immediately after BASS_MusicPlay.
const FPS = 59;
const TIMER_LEAD = 0.073;
// In the 60 Hz source capture, the 49.5 and 49.8 sync impacts first appear at
// 49.417 and 49.717 respectively; preserve that empirical presentation lead.
const SYNC_LEAD = 1 / 12;

const IMPACT_DECAY = 0.795334;
const IMPACT_VALUE = 1024;

const IMPACTS = Object.freeze([
  27.8, 32.6, 37.4, 41.0, 41.4, 42.2, 42.6, 43.5, 43.8, 44.7,
  45.0, 47.1, 47.4, 48.3, 48.6, 49.5, 49.8, 51.9, 53.1, 53.4,
  54.3, 54.6, 56.7, 57.0, 57.9, 58.2, 59.1, 59.4, 60.3, 61.2,
  61.95, 62.55
]);

// Literal at demo.exe:00439b60.  It is intentionally not 2*pi/8192.
const TRIG_STEP = 0.000766990234375;
const SIN = new Int32Array(8192);
const COS = new Int32Array(8192);
for (let index = 0; index < 8192; index++) {
  const angle = index * TRIG_STEP;
  SIN[index] = Math.trunc(Math.sin(angle) * 8192);
  COS[index] = Math.trunc(Math.cos(angle) * 8192);
}

const sinQ13 = angle => SIN[angle & 8191];
const cosQ13 = angle => COS[angle & 8191];
const add32 = (first, second) => (first + second) | 0;
const sub32 = (first, second) => (first - second) | 0;

function pixelsFromSource(source) {
  if (!source) throw new TypeError('x28 is required');
  if (ArrayBuffer.isView(source)) return source;
  if (ArrayBuffer.isView(source.data)) return source.data;

  const ownContext = source.ctx ||
    (typeof source.getContext === 'function'
      ? source.getContext('2d', { willReadFrequently: true })
      : null);
  if (ownContext && typeof ownContext.getImageData === 'function') {
    return ownContext.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE).data;
  }

  if (source.width === TEXTURE_SIZE && source.height === TEXTURE_SIZE) {
    let canvas = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(TEXTURE_SIZE, TEXTURE_SIZE);
    } else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = TEXTURE_SIZE;
      canvas.height = TEXTURE_SIZE;
    }
    const context = canvas?.getContext('2d', { willReadFrequently: true });
    if (context) {
      context.drawImage(source, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
      return context.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE).data;
    }
  }

  throw new TypeError('x28 must be RGBA, packed 00RRGGBB, ImageData, or a canvas source');
}

function makePackedTexture(source) {
  const pixels = pixelsFromSource(source);
  if (pixels instanceof Uint32Array && pixels.length === TEXTURE_PIXELS) {
    const packed = new Uint32Array(TEXTURE_PIXELS);
    for (let index = 0; index < TEXTURE_PIXELS; index++) {
      packed[index] = pixels[index] & 0x00ffffff;
    }
    return packed;
  }
  if (pixels.length !== TEXTURE_PIXELS * 4) {
    throw new RangeError('x28 must contain exactly 512x512 pixels');
  }
  const packed = new Uint32Array(TEXTURE_PIXELS);
  for (let index = 0, offset = 0; index < TEXTURE_PIXELS;
      index++, offset += 4) {
    packed[index] = (pixels[offset] << 16) |
      (pixels[offset + 1] << 8) | pixels[offset + 2];
  }
  return packed;
}

// FUN_00403b60.  Its four integer weights intentionally total less than 256
// for most sub-pixel positions, which makes the native image slightly darker.
function samplePacked(texture, coordinateX, coordinateY) {
  const fractionX = coordinateX & 255;
  const fractionY = coordinateY & 255;
  const inverseX = 256 - fractionX;
  const inverseY = 256 - fractionY;
  const weight00 = Math.imul(inverseX, inverseY) >> 8;
  const weight10 = Math.imul(fractionX, inverseY) >> 8;
  const weight01 = Math.imul(inverseX, fractionY) >> 8;
  const weight11 = Math.imul(fractionX, fractionY) >> 8;

  const x = (coordinateX >> 8) & 511;
  const y = (coordinateY >> 8) & 511;
  const index = x + y * TEXTURE_SIZE;
  const topLeft = texture[index];
  const topRight = texture[(index + 1) & TEXTURE_MASK];
  const bottomLeft = texture[(index + TEXTURE_SIZE) & TEXTURE_MASK];
  const bottomRight = texture[(index + TEXTURE_SIZE + 1) & TEXTURE_MASK];

  let redBlue = Math.imul(topLeft & 0x00ff00ff, weight00);
  redBlue = add32(redBlue,
    Math.imul(topRight & 0x00ff00ff, weight10));
  redBlue = add32(redBlue,
    Math.imul(bottomLeft & 0x00ff00ff, weight01));
  redBlue = add32(redBlue,
    Math.imul(bottomRight & 0x00ff00ff, weight11));
  let green = Math.imul(topLeft & 0x0000ff00, weight00);
  green = add32(green, Math.imul(topRight & 0x0000ff00, weight10));
  green = add32(green, Math.imul(bottomLeft & 0x0000ff00, weight01));
  green = add32(green, Math.imul(bottomRight & 0x0000ff00, weight11));

  redBlue = (redBlue >> 8) & 0x00ff00ff;
  green = (green >> 8) & 0x0000ff00;
  return (redBlue | green) >>> 0;
}

export class Warp28Effect {
  constructor({ sourceRGBA }) {
    this.texture = makePackedTexture(sourceRGBA);
    this.fps = FPS;
    this.timerLead = TIMER_LEAD;
    this.syncLead = SYNC_LEAD;
    this.grid = new Int32Array(33 * 25 * 2);
    this.packed = new Uint32Array(SCREEN_PIXELS);
    this.rgba = new Uint8ClampedArray(SCREEN_PIXELS * 4);
    this.imageDataByContext = new WeakMap();
  }

  frameTime(time, start) {
    const frame = Math.max(0,
      Math.floor((time - start) * this.fps + 1e-7));
    return start + frame / this.fps + this.timerLead;
  }

  // State at the prepare call (FUN_00403ad0) of the displayed first-instance
  // frame.  Audio callbacks execute before the following host render, and the
  // prepare call decays a freshly written 1024 once before using it.
  firstState(time) {
    const engineTime = this.frameTime(time, FIRST_START);
    let lastImpact = -Infinity;
    for (const impact of IMPACTS) {
      if (impact > time + this.syncLead) break;
      lastImpact = impact;
    }

    let impact = 0;
    if (Number.isFinite(lastImpact)) {
      const callbackFrame = Math.max(0,
        Math.ceil((lastImpact - FIRST_START - this.syncLead) * this.fps - 1e-7));
      const displayFrame = Math.max(0,
        Math.floor((time - FIRST_START) * this.fps + 1e-7));
      const decays = Math.max(1, displayFrame - callbackFrame + 1);
      impact = IMPACT_VALUE;
      for (let index = 0; index < decays && impact; index++) {
        impact = Math.trunc(impact * IMPACT_DECAY);
      }
    }

    let phase = 0;
    if (time + this.syncLead >= PHASE_RESET) {
      const resetFrame = Math.max(0,
        Math.ceil((PHASE_RESET - FIRST_START - this.syncLead) * this.fps - 1e-7));
      const resetTime = FIRST_START + resetFrame / this.fps + this.timerLead;
      phase = impact * 0.00001 + (engineTime - resetTime) * 0.003;
    }
    return { engineTime, impact, phase };
  }

  stateForTime(time, finale = false) {
    if (finale) {
      return {
        engineTime: this.frameTime(time, FINALE_VISUAL_START),
        impact: 0,
        phase: 0
      };
    }
    return this.firstState(time);
  }

  buildGrid(engineTime, impact, phase) {
    const grid = this.grid;
    const clockA = engineTime * 1153;
    const clockB = engineTime * 1134;
    let output = 0;
    for (let row = 0, y = -49152; row < 25; row++, y += 4096) {
      for (let column = 0, x = -65536;
          column < 33; column++, x += 4096) {
        const xPixel = x >> 8;
        const yPixel = y >> 8;
        const radiusSquared = add32(Math.imul(xPixel, xPixel),
          Math.imul(yPixel, yPixel));
        let radial = Math.imul(cosQ13(radiusSquared >> 3), impact) >> 12;
        radial = add32(sub32(radial, radiusSquared >> 5), 8192);

        let waves = sinQ13(Math.trunc(Math.trunc(x / 7) + clockA));
        waves = add32(waves,
          sinQ13(Math.trunc(Math.trunc(y / 7) + clockA)));
        waves = add32(waves,
          sinQ13(Math.trunc(Math.trunc(x / 13) - clockB)));
        waves = add32(waves,
          sinQ13(Math.trunc(Math.trunc(y / 13) - clockB)));
        const angle = Math.trunc(waves * phase + Math.trunc(engineTime * 26));

        const scaledX = Math.imul(radial, x) >> 13;
        const scaledY = Math.imul(radial, y) >> 13;
        const sine = sinQ13(angle);
        const cosine = cosQ13(angle);

        // FUN_00403920 writes this pair in this order. FUN_004036a0 passes
        // the second member as texture X and the first as texture Y.
        grid[output++] = sub32(Math.imul(cosine, scaledY),
          Math.imul(sine, scaledX)) >> 13;
        grid[output++] = add32(Math.imul(sine, scaledY),
          Math.imul(cosine, scaledX)) >> 13;
      }
    }
  }

  rasterize() {
    const grid = this.grid;
    const screen = this.packed;
    let cellRowDestination = 0;
    let cellGrid = 0;
    for (let cellY = 0; cellY < 24; cellY++) {
      let cellDestination = cellRowDestination;
      let gridPoint = cellGrid;
      for (let cellX = 0; cellX < 32; cellX++) {
        let leftX = add32(grid[gridPoint + 1], 65536);
        let leftY = add32(grid[gridPoint], 65536);
        let rightX = add32(grid[gridPoint + 3], 65536);
        let rightY = add32(grid[gridPoint + 2], 65536);
        const leftStepX = sub32(grid[gridPoint + 67],
          grid[gridPoint + 1]) >> 4;
        const leftStepY = sub32(grid[gridPoint + 66],
          grid[gridPoint]) >> 4;
        const rightStepX = sub32(grid[gridPoint + 69],
          grid[gridPoint + 3]) >> 4;
        const rightStepY = sub32(grid[gridPoint + 68],
          grid[gridPoint + 2]) >> 4;

        let destination = cellDestination;
        for (let pixelY = 0; pixelY < 16; pixelY++) {
          let coordinateX = leftX;
          let coordinateY = leftY;
          const horizontalStepX = sub32(rightX, leftX) >> 4;
          const horizontalStepY = sub32(rightY, leftY) >> 4;
          for (let pixelX = 0; pixelX < 16; pixelX++) {
            screen[destination++] = samplePacked(this.texture,
              coordinateX, coordinateY);
            coordinateX = add32(coordinateX, horizontalStepX);
            coordinateY = add32(coordinateY, horizontalStepY);
          }
          destination += WIDTH - 16;
          leftX = add32(leftX, leftStepX);
          leftY = add32(leftY, leftStepY);
          rightX = add32(rightX, rightStepX);
          rightY = add32(rightY, rightStepY);
        }
        cellDestination += 16;
        gridPoint += 2;
      }
      cellRowDestination += WIDTH * 16;
      cellGrid += 33 * 2;
    }
  }

  renderStatePacked(engineTime, impact = 0, phase = 0) {
    this.buildGrid(engineTime, impact | 0, phase);
    this.rasterize();
    return this.packed;
  }

  renderStateRGBA(engineTime, impact = 0, phase = 0, target = this.rgba) {
    const packed = this.renderStatePacked(engineTime, impact, phase);
    if (!ArrayBuffer.isView(target) || target.length !== SCREEN_PIXELS * 4) {
      throw new RangeError('RGBA target must contain exactly 512x384x4 bytes');
    }
    for (let index = 0, offset = 0; index < SCREEN_PIXELS;
        index++, offset += 4) {
      const color = packed[index];
      target[offset] = (color >>> 16) & 255;
      target[offset + 1] = (color >>> 8) & 255;
      target[offset + 2] = color & 255;
      target[offset + 3] = 255;
    }
    return target;
  }

  renderRGBA(time, finale = false, target = this.rgba) {
    const state = this.stateForTime(time, finale);
    return this.renderStateRGBA(state.engineTime, state.impact, state.phase,
      target);
  }

  render(context, time, finale = false) {
    const pixels = this.renderRGBA(time, finale);
    let image = this.imageDataByContext.get(context);
    if (!image || image.width !== WIDTH || image.height !== HEIGHT) {
      image = context.createImageData(WIDTH, HEIGHT);
      this.imageDataByContext.set(context, image);
    }
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
  }
}
