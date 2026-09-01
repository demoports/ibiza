// Software port of demo.exe:FUN_0040caf0/FUN_0040ccd0 (x21..x27).
//
// The scheduler links this renderer at XM order 37 row 8 (197.475 s of
// tracker time), FUN_0040cad0 switches its material set at order 41
// (216.275 s) and the particle transition removes it at order 43 (225.875 s).
// app.js passes those cues minus its fitted 0.2 s presentation lead. The x41
// background is a separate, lower-priority object.

const WIDTH = 512;
const HEIGHT = 384;
const MAP_SIZE = 512;
const MAP_MASK = MAP_SIZE * MAP_SIZE - 1;
const MAP_PIXELS = MAP_SIZE * MAP_SIZE;
const SCREEN_PIXELS = WIDTH * HEIGHT;
const TIMER_LEAD = 0.073;

// Constants are kept in the precision with which FUN_0040ccd0 loads them.
const PI_F32 = Math.fround(3.141592502593994);
const TIME_SCALE = 0.1979999989271164;
const AMPLITUDE_RATE = 0.92543;
const AMPLITUDE_BASE = 2.4000000953674316;
const PHASE_RATE_A = 0.236346;
const PHASE_RATE_B = 0.436346;
const SHAPE_RATE = 4.3642;
const CENTER_WOBBLE_RATE = 0.5213000178337097;
const WARP_ANGLE_SCALE = 2822;
const RAY_DIRECTION_SCALE = 65536;
const HEIGHT_SCALE = Math.fround(491520);
const FIXED_SCALE = Math.fround(65536);

// demo.exe uses the shared 8192-entry integer sine table.
const TRIG_STEP = 0.000766990234375;
const SIN = new Int32Array(8192);
for (let index = 0; index < SIN.length; index++) {
  SIN[index] = Math.trunc(Math.sin(index * TRIG_STEP) * 8192);
}

function sinQ13(angle) {
  return SIN[angle & 8191];
}

function sourcePixels(source) {
  if (!source) throw new TypeError('A raster source is required');
  if (ArrayBuffer.isView(source)) return source;
  if (ArrayBuffer.isView(source.data)) return source.data;

  const context = source.ctx ||
    (typeof source.getContext === 'function'
      ? source.getContext('2d', { willReadFrequently: true })
      : null);
  if (!context || typeof context.getImageData !== 'function') {
    throw new TypeError('Expected raw pixels, ImageData, or a readable canvas');
  }
  return context.getImageData(0, 0, source.width || MAP_SIZE,
    source.height || MAP_SIZE).data;
}

function makeColorMap(source, name) {
  const pixels = sourcePixels(source);
  if (pixels instanceof Uint32Array && pixels.length === MAP_PIXELS) {
    const result = new Uint32Array(MAP_PIXELS);
    for (let index = 0; index < MAP_PIXELS; index++) {
      result[index] = pixels[index] & 0x00ffffff;
    }
    return result;
  }
  if (pixels.length !== MAP_PIXELS * 4) {
    throw new RangeError(`${name} must contain exactly 512x512 RGBA pixels`);
  }

  const result = new Uint32Array(MAP_PIXELS);
  for (let pixel = 0, offset = 0; pixel < MAP_PIXELS; pixel++, offset += 4) {
    result[pixel] = (pixels[offset] << 16) |
      (pixels[offset + 1] << 8) | pixels[offset + 2];
  }
  return result;
}

function makeHeightMap(source, name) {
  const pixels = sourcePixels(source);
  if (pixels.length === MAP_PIXELS) return Uint8Array.from(pixels);
  if (pixels.length !== MAP_PIXELS * 4) {
    throw new RangeError(`${name} must contain 512x512 bytes or RGBA pixels`);
  }

  // FUN_00404d40 converts JPEG to packed 00RRGGBB and copies byte zero.
  // Packed byte zero is blue on the original little-endian x86 machine.
  const result = new Uint8Array(MAP_PIXELS);
  for (let pixel = 0, offset = 2; pixel < MAP_PIXELS; pixel++, offset += 4) {
    result[pixel] = pixels[offset];
  }
  return result;
}

function saturatedAdd(first, second) {
  const red = Math.min(255, ((first >>> 16) & 255) + ((second >>> 16) & 255));
  const green = Math.min(255, ((first >>> 8) & 255) + ((second >>> 8) & 255));
  const blue = Math.min(255, (first & 255) + (second & 255));
  return (red << 16) | (green << 8) | blue;
}

function bilerpByte(map, index, fractionX, fractionY) {
  const topLeft = map[index];
  const topRight = map[(index + 1) & MAP_MASK];
  const bottomLeft = map[(index + MAP_SIZE) & MAP_MASK];
  const bottomRight = map[(index + MAP_SIZE + 1) & MAP_MASK];
  const top = topLeft + (Math.imul(topRight - topLeft, fractionX) >> 16);
  const bottom = bottomLeft +
    (Math.imul(bottomRight - bottomLeft, fractionX) >> 16);
  return top + (Math.imul(bottom - top, fractionY) >> 16);
}

function bilerpChannel(map, index, fractionX, fractionY, shift) {
  const topLeft = (map[index] >>> shift) & 255;
  const topRight = (map[(index + 1) & MAP_MASK] >>> shift) & 255;
  const bottomLeft = (map[(index + MAP_SIZE) & MAP_MASK] >>> shift) & 255;
  const bottomRight = (map[(index + MAP_SIZE + 1) & MAP_MASK] >>> shift) & 255;
  const top = topLeft + (Math.imul(topRight - topLeft, fractionX) >> 16);
  const bottom = bottomLeft +
    (Math.imul(bottomRight - bottomLeft, fractionX) >> 16);
  return top + (Math.imul(bottom - top, fractionY) >> 16);
}

function packedFixedColor(red, green, blue) {
  return (red & 0x00ff0000) | (green & 0x0000ff00) |
    ((blue >>> 16) & 255);
}

let sharedScreenMap = null;
let sharedCurve = null;

function buildScreenMap() {
  if (sharedScreenMap) return sharedScreenMap;
  const result = new Uint32Array(SCREEN_PIXELS);
  let output = 0;
  for (let y = 192; y > -192; y--) {
    for (let x = -256; x < 256; x++) {
      const angle = Math.trunc(
        Math.atan2(y, x) * 512 / PI_F32 * 0.5) & 511;
      const radius = Math.trunc(Math.sqrt(x * x + y * y)) & 511;
      result[output++] = (angle << 9) | radius;
    }
  }
  sharedScreenMap = result;
  return result;
}

function buildCurve() {
  if (sharedCurve) return sharedCurve;
  const result = new Float32Array(MAP_SIZE);
  for (let index = 0; index < MAP_SIZE; index++) {
    const fraction = Math.fround(index / MAP_SIZE);
    result[index] = Math.fround(
      Math.pow(1 - fraction, 8.94) * Math.sin(PI_F32 * fraction));
  }
  sharedCurve = result;
  return result;
}

export class BlobEffect {
  constructor({
    x21, x22, x23, x24, x25, x26, x27,
    startTime, swapTime, endTime
  }) {
    this.x21 = makeColorMap(x21, 'x21');
    this.x22 = makeColorMap(x22, 'x22');
    this.x23 = makeColorMap(x23, 'x23');
    this.x24 = makeHeightMap(x24, 'x24');
    this.x25 = makeHeightMap(x25, 'x25');
    this.x26 = makeHeightMap(x26, 'x26');
    this.x27 = makeHeightMap(x27, 'x27');

    this.start = startTime;
    this.swap = swapTime;
    this.end = endTime;

    this.screenMap = buildScreenMap();
    this.curve = buildCurve();
    this.height = new Uint8Array(MAP_PIXELS);
    this.material = new Uint32Array(MAP_PIXELS);
    this.polar = new Int32Array(MAP_PIXELS);
    this.rgba = new Uint8ClampedArray(SCREEN_PIXELS * 4);
    this.contextImages = new WeakMap();
  }

  isActive(time) {
    return time >= this.start && time < this.end;
  }

  makeParams(time) {
    const driver = (time + TIMER_LEAD) * TIME_SCALE;
    const phase = Math.fround(Math.sin(driver * PHASE_RATE_A) *
      Math.sin(driver * PHASE_RATE_B) * PI_F32 * 0.5);
    const amplitude = Math.fround(
      (Math.cos(driver * AMPLITUDE_RATE) + 1) * 0.5 * 11 + AMPLITUDE_BASE);
    const shapeExtended = Math.sin(driver * SHAPE_RATE) * 0.20000000298023224 + 1;
    const shape = Math.fround(shapeExtended);
    const shapeOffset = Math.fround(128 - shapeExtended * 128);
    const centerX = Math.fround(driver * 50 +
      Math.sin(driver * CENTER_WOBBLE_RATE) * 50.9 + 256);
    const centerY = Math.fround(driver * 350 + 256);
    const blend = (sinQ13(Math.trunc(driver * WARP_ANGLE_SCALE)) + 8192) >> 6;
    return { time, driver, phase, amplitude, shape, shapeOffset,
      centerX, centerY, blend };
  }

  buildHeight(params) {
    const first = params.time >= this.swap ? this.x26 : this.x24;
    const second = params.time >= this.swap ? this.x27 : this.x25;
    const firstWeight = params.blend;
    const secondWeight = 255 - firstWeight;
    const output = this.height;
    for (let index = 0; index < MAP_PIXELS; index++) {
      output[index] = (Math.imul(first[index], firstWeight) +
        Math.imul(second[index], secondWeight)) >> 8;
    }
  }

  buildMaterial(params) {
    const baseMap = params.time >= this.swap ? this.x22 : this.x21;
    const lightMap = this.x23;
    const height = this.height;
    const output = this.material;
    const negativeRow = (-(Math.trunc(params.centerY) | 0) << 9) | 0;
    const base = (Math.trunc(negativeRow - params.centerX +
      Math.fround(131328)) - 2048) | 0;

    for (let index = 0; index < MAP_PIXELS; index++) {
      const address = index + 2048;
      const gradient = (((height[(address - 4096) & MAP_MASK] -
        height[address & MAP_MASK]) << 9) -
        height[(address - 2044) & MAP_MASK] +
        height[(address - 2052) & MAP_MASK]) | 0;
      const warped = (base + Math.imul(gradient, 4) + address) & MAP_MASK;
      output[index] = saturatedAdd(baseMap[index], lightMap[warped]);
    }
  }

  renderPolar(params) {
    const polar = this.polar;
    polar.fill(-1);
    const height = this.height;
    const material = this.material;
    const radiusScale = 128 / MAP_SIZE;
    const centerXFixed = Math.trunc(params.centerX * FIXED_SCALE) | 0;
    const centerYFixed = Math.trunc(params.centerY * FIXED_SCALE) | 0;

    for (let angleIndex = 0; angleIndex < MAP_SIZE; angleIndex++) {
      const angle = angleIndex * Math.fround(1 / 512) * PI_F32 * 2 + params.phase;
      let deltaX = Math.trunc(Math.sin(angle) * radiusScale *
        params.amplitude * RAY_DIRECTION_SCALE) | 0;
      let deltaY = Math.trunc(Math.cos(angle) * radiusScale *
        params.amplitude * RAY_DIRECTION_SCALE) | 0;
      let x = centerXFixed;
      let y = centerYFixed;
      let radius = 0;
      let radiusStep = 1;
      let maximumFixed = 0;
      let previousY = 0;
      let previousRed = 0;
      let previousGreen = 0;
      let previousBlue = 0;
      const row = angleIndex << 9;

      while (radius < 128) {
        if (((radius + 1) & 63) === 0) {
          deltaX = (deltaX << 1) | 0;
          deltaY = (deltaY << 1) | 0;
          radiusStep = (radiusStep << 1) | 0;
        }

        const integerX = x >> 16;
        const integerY = y >> 16;
        const fractionX = x & 0xffff;
        const fractionY = y & 0xffff;
        const index = ((integerY << 9) + integerX) & MAP_MASK;
        const sampleHeight = bilerpByte(height, index, fractionX, fractionY);
        let heightFixed = Math.trunc((sampleHeight * params.shape +
          params.shapeOffset) * this.curve[radius] * HEIGHT_SCALE) | 0;
        if (heightFixed > 0x01ff0000) heightFixed = 0x01ff0000;

        const red = bilerpChannel(material, index, fractionX, fractionY, 16);
        const green = bilerpChannel(material, index, fractionX, fractionY, 8);
        const blue = bilerpChannel(material, index, fractionX, fractionY, 0);
        const shade = Math.min(511, Math.max(0, (128 - radius) << 3));
        const currentRed = (Math.imul(red, shade) << 7) | 0;
        const currentGreen = (Math.imul(green, shade) << 7) | 0;
        const currentBlue = (Math.imul(blue, shade) << 7) | 0;

        if (heightFixed > maximumFixed) {
          const currentY = heightFixed >> 16;
          const span = currentY - previousY;
          if (span > 1) {
            const redStep = Math.trunc((currentRed - previousRed) / span) | 0;
            const greenStep = Math.trunc(
              ((currentGreen >> 8) - (previousGreen >> 8)) / span) | 0;
            const blueStep = Math.trunc((currentBlue - previousBlue) / span) | 0;
            let redValue = currentRed;
            let greenValue = currentGreen >> 8;
            let blueValue = currentBlue;
            for (let drawY = currentY - 1; drawY >= previousY; drawY--) {
              if (drawY >= 0 && drawY < MAP_SIZE) {
                polar[row + drawY] = packedFixedColor(
                  redValue, greenValue, blueValue);
              }
              redValue = (redValue - redStep) | 0;
              greenValue = (greenValue - greenStep) | 0;
              blueValue = (blueValue - blueStep) | 0;
            }
          } else {
            const oldMaximumY = maximumFixed >> 16;
            if (oldMaximumY < currentY) {
              const color = packedFixedColor(
                currentRed, currentGreen >> 8, currentBlue);
              for (let drawY = oldMaximumY; drawY < currentY; drawY++) {
                if (drawY >= 0 && drawY < MAP_SIZE) polar[row + drawY] = color;
              }
            }
          }
          previousY = currentY;
          maximumFixed = heightFixed;
        }

        // The color endpoint follows every ray sample, even an occluded one;
        // only the height endpoint above is conditional in FUN_0040ccd0.
        previousRed = currentRed;
        previousGreen = currentGreen;
        previousBlue = currentBlue;

        x = (x + deltaX) | 0;
        y = (y + deltaY) | 0;
        radius = (radius + radiusStep) | 0;
      }
    }
  }

  mapToRGBA(output) {
    const supplied = output !== undefined;
    const targetObject = output ?? this.rgba;
    const target = ArrayBuffer.isView(targetObject) ? targetObject : targetObject.data;
    if (!target || target.length < SCREEN_PIXELS * 4) {
      throw new RangeError('Output must provide at least 512x384 RGBA bytes');
    }
    // With no base supplied this is a transparent overlay. With a supplied
    // buffer, sentinel pixels preserve its existing contents like demo.exe.
    if (!supplied) target.fill(0);
    const polar = this.polar;
    const screenMap = this.screenMap;
    for (let pixel = 0, offset = 0; pixel < SCREEN_PIXELS; pixel++, offset += 4) {
      const color = polar[screenMap[pixel]];
      if (color === -1) continue;
      target[offset] = (color >>> 16) & 255;
      target[offset + 1] = (color >>> 8) & 255;
      target[offset + 2] = color & 255;
      target[offset + 3] = 255;
    }
    return target;
  }

  renderRGBA(time, output) {
    if (!this.isActive(time)) return null;
    const params = this.makeParams(time);
    this.buildHeight(params);
    this.buildMaterial(params);
    this.renderPolar(params);
    return this.mapToRGBA(output);
  }

  render(context, time) {
    if (!this.isActive(time)) return false;
    // Native rendering skips -1 polar pixels and therefore preserves the
    // lower-priority x41 object already in the main framebuffer.
    let image = this.contextImages.get(context);
    if (!image) {
      image = context.createImageData(WIDTH, HEIGHT);
      this.contextImages.set(context, image);
    }
    const base = context.getImageData(0, 0, WIDTH, HEIGHT);
    const pixels = this.renderRGBA(time, base.data);
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
    return true;
  }

}
