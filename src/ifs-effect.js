const WIDTH = 512;
const HEIGHT = 384;
const PIXEL_COUNT = WIDTH * HEIGHT;
const POINT_COUNT = 40000;
const DRIVER_ORIGIN = 104653889;
const DRIVER_RATE = 2.3;
const CADENCE = 90;

// FUN_0040b6b0's table is generated with the literal step in the executable,
// not with 2 * PI / 8192.  In particular, cos[4096] is -8191 rather than
// -8192, which keeps every packed blend weight in the byte range 0..255.
const TRIG_SIZE = 8192;
const TRIG_STEP = 0.000766990234375;
const COS_TABLE = Int16Array.from({ length: TRIG_SIZE }, (_, index) =>
  Math.trunc(Math.cos(index * TRIG_STEP) * 8192));

const COEFFICIENT_DEFINITIONS = [
  [.052456, 8.1], [.06456, 6.5], [.07256, 8.5], [.061757, 9.7],
  [.0716567, 7.6], [.052453, 4.5], [.071456, 6.4], [.066727, 5.8],
  [.056582, 6.9], [.0787782, 7], [.05324, 4.9], [.076635, 8.6],
  [.063167, 3.5], [.079827, 9.4], [.062732, 2.3], [.05578, 9.7],
  [.068682, 7.6], [.072686, 6.8], [.0687376, 5.9], [.0524527, 9],
  [.0776327, .6], [.06676, 3.5], [.072457, .7], [.06782, 4.3],
  [.052682, 6.4], [.077276, 7.5], [.0686862, 9.7], [.0712356, .3],
  [.06628, 3.7], [.05852, .8], [.061425, 5.6], [.07762, 7.7],
  [.06345, 9.5], [.07257, 8.4], [.0652, 3.3], [.05124, 1.6],
  [.0654, 2.3], [.072453, 3.4], [.06762, 7.5], [.065268, 6.6],
  [.05268, 8.5], [.06352, 3.7], [.0722142, 9.3], [.0634, 5.8],
  [.072352, 7.9], [.05145, 8.5], [.0645, 9.4], [.0725, 3.3]
];

// The render routine changes the scale before using it.  The native branch
// admits one .693... frame before noticing it crossed .7 on the next render.
const SCALE_TRACE = new Float64Array(28);
SCALE_TRACE[0] = .9;
for (let frame = 1; frame < SCALE_TRACE.length; frame++) {
  const previous = SCALE_TRACE[frame - 1];
  SCALE_TRACE[frame] = previous <= .7 ? .7 : previous * .99;
}

function packRGBA(image) {
  const source = image.data;
  const result = new Uint32Array(PIXEL_COUNT);
  for (let pixel = 0, offset = 0; pixel < PIXEL_COUNT; pixel++, offset += 4) {
    result[pixel] = (source[offset] << 16) |
      (source[offset + 1] << 8) | source[offset + 2];
  }
  return result;
}

function packPalette(image) {
  const source = image.data;
  const result = new Uint32Array(256);
  for (let index = 0, offset = 0; index < 256; index++, offset += 4) {
    result[index] = (source[offset] << 16) |
      (source[offset + 1] << 8) | source[offset + 2];
  }
  return result;
}

function blueMask(image) {
  const source = image.data;
  const result = new Uint8Array(PIXEL_COUNT);
  // FUN_00404d40 copies byte zero from each little-endian XRGB pixel.  That
  // byte is blue, rather than a luminance or maximum-channel conversion.
  for (let pixel = 0, offset = 2; pixel < PIXEL_COUNT; pixel++, offset += 4) {
    result[pixel] = source[offset];
  }
  return result;
}

function channel(color, shift) {
  return (color >>> shift) & 255;
}

function blendPaletteChannel(previous, current, inverse, amount) {
  // The two packed contribution groups in FUN_004043c0 are joined with OR.
  return ((previous * inverse) >> 8) | ((current * amount) >> 8);
}

function transitionChannel(from, to, inverse, amount) {
  return ((from * inverse) >> 8) + ((to * amount) >> 8);
}

function compositeChannel(destination, source, mask) {
  return ((destination * (255 - mask)) >> 8) + ((source * mask) >> 8);
}

export class IFSEffect {
  constructor({
    backgroundRGBA,
    paletteRGBA,
    shoes,
    sceneStart,
    paletteCues,
    shoeCues,
    timerLead = 0
  }) {
    this.background = packRGBA(backgroundRGBA);
    this.palette = packPalette(paletteRGBA);
    this.shoes = shoes.map(({ imageRGBA, maskRGBA }) => ({
      image: packRGBA(imageRGBA),
      mask: blueMask(maskRGBA)
    }));
    this.sceneStart = sceneStart;
    this.paletteCues = paletteCues;
    this.shoeCues = shoeCues;
    this.timerLead = timerLead;
    this.pixels = new Uint32Array(PIXEL_COUNT);
    this.frame = new ImageData(WIDTH, HEIGHT);
    this.coefficients = new Float64Array(48);
    this.blendedPalette = new Uint32Array(256);
  }

  scaleAt(time) {
    const frame = Math.max(1, Math.floor((time - this.sceneStart) * CADENCE) + 1);
    return frame < SCALE_TRACE.length ? SCALE_TRACE[frame] : .7;
  }

  makePalette(time) {
    let epoch = 0;
    while (epoch < this.paletteCues.length && time >= this.paletteCues[epoch]) epoch++;
    const previousShift = epoch === 0 ? 0 : ((epoch - 1) * 157) & 255;
    const currentShift = (epoch * 157) & 255;
    const phase = epoch === 0 ? 0 :
      Math.max(0, Math.min(1, (time - this.paletteCues[epoch - 1]) * DRIVER_RATE));
    const cosine = COS_TABLE[Math.trunc(phase * 4096) & 8191];
    const amount = (8192 - cosine) >> 6;
    const inverse = 255 - amount;

    for (let index = 0; index < 256; index++) {
      const previous = this.palette[(index + previousShift) & 255];
      const current = this.palette[(index + currentShift) & 255];
      const red = blendPaletteChannel(channel(previous, 16), channel(current, 16),
        inverse, amount);
      const green = blendPaletteChannel(channel(previous, 8), channel(current, 8),
        inverse, amount);
      const blue = blendPaletteChannel(channel(previous, 0), channel(current, 0),
        inverse, amount);
      this.blendedPalette[index] = (red << 16) | (green << 8) | blue;
    }
  }

  add(x, y, color, weight) {
    // FUN_00401c80 clips each of the four bilinear neighbours separately.
    if (x <= 0 || x >= WIDTH || y <= 0 || y >= HEIGHT) return;
    const pixel = y * WIDTH + x;
    const old = this.pixels[pixel];
    const addRed = ((channel(color, 16) * weight) >> 8) & 0xfe;
    const addGreen = ((channel(color, 8) * weight) >> 8) & 0xfe;
    const addBlue = ((channel(color, 0) * weight) >> 8) & 0xfe;
    // Native packed saturation strips the low bit from both operands and
    // clips at 254.  Dim one-count contributions therefore disappear.
    const red = Math.min(254, (channel(old, 16) & 0xfe) + addRed);
    const green = Math.min(254, (channel(old, 8) & 0xfe) + addGreen);
    const blue = Math.min(254, (channel(old, 0) & 0xfe) + addBlue);
    this.pixels[pixel] = (red << 16) | (green << 8) | blue;
  }

  renderPoints(time) {
    // demo.exe starts the PTC timer immediately after BASS_MusicPlay, so the
    // timer runs about 73 ms ahead of audible playback (a fitted output
    // latency).  Cue deltas cancel that offset, but the absolute
    // morph/rotation driver does not.
    const driver = (time + this.timerLead) * DRIVER_RATE + DRIVER_ORIGIN;
    const scale = this.scaleAt(time);
    const coefficients = this.coefficients;
    for (let index = 0; index < coefficients.length; index++) {
      const definition = COEFFICIENT_DEFINITIONS[index];
      coefficients[index] = Math.cos(driver * definition[0] + definition[1]) * scale;
    }
    this.makePalette(time);

    const angleA = Math.sin(driver * .08);
    const sinA = Math.sin(angleA);
    const cosA = Math.cos(angleA);
    const sinB = Math.sin(driver * .17);
    const cosB = Math.cos(driver * .17);
    let x = 0;
    let y = 0;
    let z = 0;
    let random = 0;

    for (let point = 0; point < POINT_COUNT; point++) {
      random = (random + 157) >>> 0;
      random = (((random << 11) | (random >>> 21)) ^ 157) >>> 0;
      const selector = random >>> 24;
      const map = selector < 30 ? 0 : selector < 150 ? 1 : selector < 210 ? 2 : 3;
      const base = map * 12;

      // These sums follow the x87 stack order in FUN_004043c0 (z, y, x,
      // translation), rather than relying on algebraic equivalence.
      const nextX = ((z * coefficients[base + 2] + y * coefficients[base + 1]) +
        x * coefficients[base]) + coefficients[base + 3];
      const nextY = ((z * coefficients[base + 6] + y * coefficients[base + 5]) +
        x * coefficients[base + 4]) + coefficients[base + 7];
      const nextZ = ((z * coefficients[base + 10] + y * coefficients[base + 9]) +
        x * coefficients[base + 8]) + coefficients[base + 11];
      const deltaX = nextX - x;
      const deltaY = nextY - y;
      const deltaZ = nextZ - z;
      const movement = Math.trunc(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
      x = nextX;
      y = nextY;
      z = nextZ;

      const rotatedA = y * cosA + x * sinA;
      const rotatedB = x * cosA - y * sinA;
      const projectedA = rotatedB * cosB + z * sinB;
      const projectedB = z * cosB - rotatedB * sinB;
      const vx = Math.trunc(projectedA * 8192);
      const vy = Math.trunc((rotatedA * cosA - projectedB * sinA) * 8192);
      const vz = Math.trunc((rotatedA * sinA + projectedB * cosA) * 8192);
      const depth = (vz >> 4) + 824;
      if (depth <= 0) continue;

      const fixedX = Math.trunc(Math.imul(vx, 10002) / depth) - 512 + 256 * 1024;
      const fixedY = Math.trunc(Math.imul(vy, 10002) / depth) - 512 + 192 * 1024;
      const screenX = fixedX >> 10;
      const screenY = fixedY >> 10;
      const fractionX = fixedX & 1023;
      const fractionY = fixedY & 1023;
      const clippedZ = Math.max(-824, Math.min(824, vz - 824));
      const brightness = Math.trunc((1648 - clippedZ) * 1024 / 1648);
      const color = this.blendedPalette[(movement << 3) & 255];
      const inverseX = 1023 - fractionX;
      const inverseY = 1023 - fractionY;
      const topLeft = (((inverseY * inverseX) >> 12) * brightness) >> 12;
      const topRight = (((inverseY * fractionX) >> 12) * brightness) >> 12;
      const bottomLeft = (((fractionY * inverseX) >> 12) * brightness) >> 12;
      const bottomRight = (((fractionY * fractionX) >> 12) * brightness) >> 12;
      this.add(screenX, screenY, color, topLeft);
      this.add(screenX + 1, screenY, color, topRight);
      this.add(screenX, screenY + 1, color, bottomLeft);
      this.add(screenX + 1, screenY + 1, color, bottomRight);
    }
  }

  renderShoe(time) {
    let index = -1;
    while (index + 1 < this.shoeCues.length && time >= this.shoeCues[index + 1]) index++;
    if (index < 0) return;

    const destination = this.pixels;
    const current = this.shoes[index];
    const previous = index === 0 ? null : this.shoes[index - 1];
    const phase = Math.max(0, Math.min(1, time - this.shoeCues[index]));
    const cosine = COS_TABLE[Math.trunc(phase * 4096) & 8191];
    const amount = (8192 - cosine) >> 6;
    const inverse = 255 - amount;

    for (let pixel = 0; pixel < PIXEL_COUNT; pixel++) {
      const dest = destination[pixel];
      const from = previous === null ? dest : previous.image[pixel];
      const to = current.image[pixel];
      let source;
      let mask;
      if (phase <= 0) {
        source = from;
        mask = previous === null ? current.mask[pixel] : previous.mask[pixel];
      } else if (phase >= 1) {
        source = to;
        mask = current.mask[pixel];
      } else {
        const red = transitionChannel(channel(from, 16), channel(to, 16), inverse, amount);
        const green = transitionChannel(channel(from, 8), channel(to, 8), inverse, amount);
        const blue = transitionChannel(channel(from, 0), channel(to, 0), inverse, amount);
        source = (red << 16) | (green << 8) | blue;
        const fromMask = previous === null ? current.mask[pixel] : previous.mask[pixel];
        mask = (fromMask * inverse + current.mask[pixel] * amount) >> 8;
      }
      const red = compositeChannel(channel(dest, 16), channel(source, 16), mask);
      const green = compositeChannel(channel(dest, 8), channel(source, 8), mask);
      const blue = compositeChannel(channel(dest, 0), channel(source, 0), mask);
      destination[pixel] = (red << 16) | (green << 8) | blue;
    }
  }

  render(context, time) {
    this.pixels.set(this.background);
    this.renderPoints(time);
    this.renderShoe(time);

    const output = this.frame.data;
    for (let pixel = 0, offset = 0; pixel < PIXEL_COUNT; pixel++, offset += 4) {
      const color = this.pixels[pixel];
      output[offset] = color >>> 16;
      output[offset + 1] = (color >>> 8) & 255;
      output[offset + 2] = color & 255;
      output[offset + 3] = 255;
    }
    context.putImageData(this.frame, 0, 0);
  }
}
