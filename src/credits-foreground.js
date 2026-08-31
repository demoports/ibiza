// Exact software port of demo.exe's finale card foreground.
//
// Native routines and state:
//   FUN_00401900  masked-card constructor
//   FUN_00401970  set transition duration (speed = 1 / duration)
//   FUN_00401990  time update and packed 00RRGGBB compositor
//   FUN_00402ba0  order 0x31 / 0x33 tracker callback
//
// The background is intentionally not part of this module.  Render the x28
// finale background or CreditsBackground first, then call render().  The first
// and last transitions alias one image endpoint to that live framebuffer; a
// normal Canvas globalAlpha fade does not reproduce the native rounding.

const WIDTH = 512;
const HEIGHT = 384;
const SCREEN_PIXELS = WIDTH * HEIGHT;

const FADE_IN_DURATION = 3.0;
const TRANSITION_DURATION = 1.0;
const END_CALLBACK = 8;

// Literal at demo.exe:00439b60.  The executable builds its cosine table with
// x87 FCOS and truncates every entry to an integer at FUN_0040b620.
const TRIG_STEP = 0.000766990234375;
const COS = new Int32Array(8192);
for (let index = 0; index < COS.length; index++) {
  COS[index] = Math.trunc(Math.cos(index * TRIG_STEP) * 8192);
}

const LIVE = -1;

function pixelsFromSource(source, name) {
  if (!source) throw new TypeError(`${name} is required`);
  if (ArrayBuffer.isView(source)) return source;
  if (ArrayBuffer.isView(source.data)) return source.data;

  const ownContext = source.ctx ||
    (typeof source.getContext === 'function'
      ? source.getContext('2d', { willReadFrequently: true })
      : null);
  if (ownContext && typeof ownContext.getImageData === 'function') {
    return ownContext.getImageData(0, 0, WIDTH, HEIGHT).data;
  }

  // ImageBitmap/HTMLImageElement path.  This keeps construction synchronous,
  // matching the other standalone renderers in this port.
  if (source.width === WIDTH && source.height === HEIGHT) {
    let canvas = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      canvas = new OffscreenCanvas(WIDTH, HEIGHT);
    } else if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas');
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
    }
    const context = canvas?.getContext('2d', { willReadFrequently: true });
    if (context && typeof context.drawImage === 'function') {
      context.drawImage(source, 0, 0, WIDTH, HEIGHT);
      return context.getImageData(0, 0, WIDTH, HEIGHT).data;
    }
  }

  throw new TypeError(
    `${name} must be raw RGBA, packed 00RRGGBB, ImageData, or a readable canvas`
  );
}

function makeColor(source, name) {
  const pixels = pixelsFromSource(source, name);
  const color = new Uint8Array(SCREEN_PIXELS * 3);

  if (pixels instanceof Uint32Array && pixels.length === SCREEN_PIXELS) {
    for (let pixel = 0, output = 0; pixel < SCREEN_PIXELS;
        pixel++, output += 3) {
      const packed = pixels[pixel];
      color[output] = (packed >>> 16) & 255;
      color[output + 1] = (packed >>> 8) & 255;
      color[output + 2] = packed & 255;
    }
    return color;
  }

  if (pixels.length !== SCREEN_PIXELS * 4) {
    throw new RangeError(`${name} must contain exactly 512x384 pixels`);
  }
  for (let pixel = 0, input = 0, output = 0; pixel < SCREEN_PIXELS;
      pixel++, input += 4, output += 3) {
    color[output] = pixels[input];
    color[output + 1] = pixels[input + 1];
    color[output + 2] = pixels[input + 2];
  }
  return color;
}

function makeMask(source, name) {
  const pixels = pixelsFromSource(source, name);
  if (pixels instanceof Uint32Array && pixels.length === SCREEN_PIXELS) {
    const mask = new Uint8Array(SCREEN_PIXELS);
    // Native 00RRGGBB byte zero is blue on little-endian x86.
    for (let pixel = 0; pixel < SCREEN_PIXELS; pixel++) {
      mask[pixel] = pixels[pixel] & 255;
    }
    return mask;
  }
  if (pixels.length === SCREEN_PIXELS) return Uint8Array.from(pixels);
  if (pixels.length !== SCREEN_PIXELS * 4) {
    throw new RangeError(`${name} must contain 512x384 bytes or RGBA pixels`);
  }

  const mask = new Uint8Array(SCREEN_PIXELS);
  for (let pixel = 0, input = 2; pixel < SCREEN_PIXELS;
      pixel++, input += 4) {
    mask[pixel] = pixels[input];
  }
  return mask;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// FUN_00401990: (8192 - cosQ13(trunc(progress * 4096))) >> 6.
function transitionWeight(progress) {
  const angle = Math.trunc(progress * 4096) & 8191;
  return (8192 - COS[angle]) >> 6;
}

function blendPackedChannel(first, second, firstWeight, secondWeight) {
  return ((first * firstWeight) >> 8) + ((second * secondWeight) >> 8);
}

export class CreditsForeground {
  constructor({ images, callbackTimes }) {
    this.colors = [
      makeColor(images.x55, 'x55'),
      makeColor(images.x56, 'x56'),
      makeColor(images.x57, 'x57'),
      makeColor(images.x58, 'x58'),
      makeColor(images.x59, 'x59'),
      makeColor(images.x65, 'x65')
    ];
    this.masks = [
      makeMask(images.x60, 'x60'),
      makeMask(images.x61, 'x61'),
      makeMask(images.x62, 'x62'),
      makeMask(images.x63, 'x63'),
      makeMask(images.x64, 'x64'),
      makeMask(images.x66, 'x66')
    ];

    if (!Array.isArray(callbackTimes) && !ArrayBuffer.isView(callbackTimes)) {
      throw new TypeError('callbackTimes must be an array of scheduler cues');
    }
    if (callbackTimes.length !== END_CALLBACK + 1) {
      throw new RangeError(`callbackTimes must contain ${END_CALLBACK + 1} cues`);
    }
    this.visualCallbacks = Float64Array.from(callbackTimes);
    for (let index = 0; index < this.visualCallbacks.length; index++) {
      if (!Number.isFinite(this.visualCallbacks[index]) ||
          (index && this.visualCallbacks[index] <= this.visualCallbacks[index - 1])) {
        throw new RangeError('callbackTimes must be finite and strictly increasing');
      }
    }
    this.fadeInDuration = FADE_IN_DURATION;
    this.transitionDuration = TRANSITION_DURATION;
    this.visualStart = this.visualCallbacks[0];
    this.end = this.visualCallbacks[END_CALLBACK];
  }

  isActive(time) {
    return time >= this.visualStart && time < this.end;
  }

  callbackCountAt(time) {
    if (time < this.visualStart) return -1;
    let count = 0;
    while (count < END_CALLBACK &&
        time + 1e-9 >= this.visualCallbacks[count + 1]) count++;
    return count;
  }

  // Resolve the scheduler-owned object that is active at an absolute time.
  // Color/mask indices 0..4 mean x55..x59/x60..x64; index 5 is x65/x66;
  // LIVE means the corresponding image pointer aliases the output framebuffer.
  resolve(time) {
    if (!this.isActive(time)) return null;
    const count = this.callbackCountAt(time);

    if (count < 2) {
      return {
        count,
        cue: this.visualStart,
        duration: this.fadeInDuration,
        fromColor: LIVE,
        fromMask: 5,
        toColor: 5,
        toMask: 5
      };
    }

    // Counts 2..6 walk x65 -> x55 -> ... -> x59.
    if (count <= 6) {
      const toColor = count - 2;
      return {
        count,
        cue: this.visualCallbacks[count],
        duration: this.transitionDuration,
        fromColor: count === 2 ? 5 : toColor - 1,
        fromMask: count === 2 ? 5 : toColor - 1,
        toColor,
        toMask: toColor
      };
    }

    // Count 7 keeps x64 as both masks and aliases image B to the live credits
    // framebuffer.  Count 8 removes the object before the next render.
    return {
      count,
      cue: this.visualCallbacks[7],
      duration: this.transitionDuration,
      fromColor: 4,
      fromMask: 4,
      toColor: LIVE,
      toMask: 4
    };
  }

  compositeEndpoint(target, colorIndex, maskIndex) {
    const color = colorIndex === LIVE ? null : this.colors[colorIndex];
    const mask = this.masks[maskIndex];
    for (let pixel = 0, rgba = 0, rgb = 0; pixel < SCREEN_PIXELS;
        pixel++, rgba += 4, rgb += 3) {
      const amount = mask[pixel];
      const inverse = 255 - amount;
      const backgroundRed = target[rgba];
      const backgroundGreen = target[rgba + 1];
      const backgroundBlue = target[rgba + 2];
      const sourceRed = color ? color[rgb] : backgroundRed;
      const sourceGreen = color ? color[rgb + 1] : backgroundGreen;
      const sourceBlue = color ? color[rgb + 2] : backgroundBlue;

      target[rgba] = blendPackedChannel(
        backgroundRed, sourceRed, inverse, amount);
      target[rgba + 1] = blendPackedChannel(
        backgroundGreen, sourceGreen, inverse, amount);
      target[rgba + 2] = blendPackedChannel(
        backgroundBlue, sourceBlue, inverse, amount);
    }
  }

  compositeTransition(target, state, progress) {
    const weight = transitionWeight(progress);
    const inverseWeight = 255 - weight;
    const firstColor = state.fromColor === LIVE
      ? null : this.colors[state.fromColor];
    const secondColor = state.toColor === LIVE
      ? null : this.colors[state.toColor];
    const firstMask = this.masks[state.fromMask];
    const secondMask = this.masks[state.toMask];

    for (let pixel = 0, rgba = 0, rgb = 0; pixel < SCREEN_PIXELS;
        pixel++, rgba += 4, rgb += 3) {
      const backgroundRed = target[rgba];
      const backgroundGreen = target[rgba + 1];
      const backgroundBlue = target[rgba + 2];
      const firstRed = firstColor ? firstColor[rgb] : backgroundRed;
      const firstGreen = firstColor ? firstColor[rgb + 1] : backgroundGreen;
      const firstBlue = firstColor ? firstColor[rgb + 2] : backgroundBlue;
      const secondRed = secondColor ? secondColor[rgb] : backgroundRed;
      const secondGreen = secondColor ? secondColor[rgb + 1] : backgroundGreen;
      const secondBlue = secondColor ? secondColor[rgb + 2] : backgroundBlue;

      const mixedRed = blendPackedChannel(
        firstRed, secondRed, inverseWeight, weight);
      const mixedGreen = blendPackedChannel(
        firstGreen, secondGreen, inverseWeight, weight);
      const mixedBlue = blendPackedChannel(
        firstBlue, secondBlue, inverseWeight, weight);
      const mixedMask = (firstMask[pixel] * inverseWeight +
        secondMask[pixel] * weight) >> 8;
      const backgroundWeight = 255 - mixedMask;

      target[rgba] = blendPackedChannel(
        backgroundRed, mixedRed, backgroundWeight, mixedMask);
      target[rgba + 1] = blendPackedChannel(
        backgroundGreen, mixedGreen, backgroundWeight, mixedMask);
      target[rgba + 2] = blendPackedChannel(
        backgroundBlue, mixedBlue, backgroundWeight, mixedMask);
    }
  }

  // Mutates an already-rendered 512x384 RGBA framebuffer in place.
  renderRGBA(time, target) {
    if (!this.isActive(time)) return false;
    if (!ArrayBuffer.isView(target) || target.length !== SCREEN_PIXELS * 4) {
      throw new RangeError('RGBA target must contain exactly 512x384x4 bytes');
    }

    const state = this.resolve(time);
    const progress = clamp01((time - state.cue) / state.duration);
    if (progress <= 0) {
      this.compositeEndpoint(target, state.fromColor, state.fromMask);
    } else if (progress >= 1) {
      this.compositeEndpoint(target, state.toColor, state.toMask);
    } else {
      this.compositeTransition(target, state, progress);
    }
    return true;
  }

  // Reads the current background, applies the native packed compositor, and
  // puts it back.  Alpha is deliberately preserved; native PTC ignores byte 3.
  render(context, time) {
    if (!this.isActive(time)) return false;
    if (!context || typeof context.getImageData !== 'function' ||
        typeof context.putImageData !== 'function') {
      throw new TypeError('render expects a readable CanvasRenderingContext2D');
    }
    const image = context.getImageData(0, 0, WIDTH, HEIGHT);
    this.renderRGBA(time, image.data);
    context.putImageData(image, 0, 0);
    return true;
  }
}
