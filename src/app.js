import XMPlayer from './xm-player.js';
import { ParticleEffects } from './particle-effects.js';
import { HeightfieldEffect } from './heightfield-effect.js';
import { BlobEffect } from './blob-effect.js';
import { TunnelEffect } from './tunnel-effect.js';
import { CreditsBackground } from './credits-background.js';
import { CreditsForeground } from './credits-foreground.js';
import { IntroEffect } from './intro-effect.js';
import { Warp28Effect } from './warp28-effect.js';
import { ComicEffect } from './comic-effect.js';
import { IFSEffect } from './ifs-effect.js';
import { PartANoiseEffect } from './native-noise-effect.js';
import {
  EarlyTransitionChain,
  EARLY_TRANSITION_TIMING
} from './early-transition-chain.js';
import { LateTransitionEffect } from './late-transition-effect.js';
import { X7StripEffect } from './x7-strip-effect.js';
import { LoadingEffect, LOADING_PROGRESS_SEQUENCE } from './loading-effect.js';

(() => {
  'use strict';

  const WIDTH = 512;
  const HEIGHT = 384;
  const AUDIO_URL = 'data/atbia3.xm';
  const LOADING_PREVIEW = Object.freeze({ x: 264, y: 24, size: 240 });

  // Presented callback boundary fitted to the released 60 Hz capture. BASS's
  // mixer reaches order 9 row 0 at frame 2,777,040 (62.971428571 s); the
  // independently calibrated PTC/presentation boundary is the 62.875 frame.
  const MOVIE7_REVEAL_START = 62.875;
  // The first presented x8 frame in the released capture.  The decoded strip
  // is already 0.2 frames into its interpolation at integer video PTS values.
  const PRECALC_TWO_START = 187.32666666666665;
  // Capture-calibrated PTC/presentation cues. These drive the visual scheduler
  // and deliberately are not raw AudioWorklet/BASS mixer-frame timestamps.
  const PTC_CUES = Object.freeze({
    comicStart: 23.100,
    particlesA: 123.075,
    to46A: 156.275,
    ifs: 158.675,
    ifsChange1: 163.475,
    shoe1: 168.275,
    shoe2: 173.075,
    shoe3: 177.875,
    shoe4: 182.675,
    movie8: 187.475,
  });
  // Empirical callback-to-picture lead recovered from the released capture.
  // This is presentation calibration, not a claim about BASS's buffer size.
  const CALLBACK_PRESENTATION_LEAD = 0.2;
  // The worklet reproduces BASS 0.8's tick length: bass.dll computes
  // rate * 125 / (bpm * 50) with an integer division (1000e99b) and its mixer
  // countdown (1000ec79) never carries the remainder, so at the module's
  // constant 100 BPM a tick is 1102 samples rather than the nominal 1102.5.
  // Every visual cue in this file was fitted on the nominal grid, so the
  // visual clock counts nominal tracker seconds: wall-clock seconds divided
  // by this ratio. Only the x7 instrument table is kept in replay frames.
  const NOMINAL_TICK_SAMPLES = 44100 * 2.5 / 100;
  const TICK_SCALE = Math.floor(NOMINAL_TICK_SAMPLES) / NOMINAL_TICK_SAMPLES;
  const PARTICLES_A_VISUAL = PTC_CUES.particlesA - CALLBACK_PRESENTATION_LEAD;
  const TERRAIN_VISUAL = EARLY_TRANSITION_TIMING.terrainVisual;
  // The tunnel's first pass seeds itself from the framebuffer of the same
  // scheduler walk, so the terrain keeps animating until that pass.
  const FEEDBACK_FIRST_PASS_VISUAL =
    EARLY_TRANSITION_TIMING.feedbackFirstUpdateVisual;
  // The released stream presents Part A at 139.333333 and the light ball on
  // the following 60 Hz picture.
  const ROCK_VISUAL = 8361 / 60;
  const IFS_VISUAL = PTC_CUES.ifs - CALLBACK_PRESENTATION_LEAD;
  const MOVIE8_VISUAL = PTC_CUES.movie8 - CALLBACK_PRESENTATION_LEAD;
  // Released-capture presentation anchors for the integer-floor callbacks.
  // The measured callback-to-picture lead shrinks from 112.8 ms here to
  // 75.2 ms at the credits callback.
  const X44_VISUAL = 190.875;
  // Order 37 row 0 lands after video frame 5907 has already been presented.
  // Keep that frame's x44 picture, but use its PTS as the following white
  // transition's phase anchor.
  const BLOB_BLACK_VISUAL = 5907 / 30;
  const BLOB_WHITE_REPEAT_VISUAL = 197.075;
  const BLOB_VISUAL = 197.275;
  const BLOB_SWAP_VISUAL = 216.075;
  const TO_46_B_VISUAL = 223.275;
  const PARTICLES_B_VISUAL = 225.675;
  const FINALE_NOISE_VISUAL = 252.675;
  // Capture-calibrated presentation positions for the repeating decoder
  // callbacks. Capture fitting leaves the observed card changes exactly
  // 9.6 seconds apart even though the raw XM loop is slightly shorter.
  const FINALE_VISUAL_CALLBACKS = Object.freeze([
    254.475, 264.075, 273.675, 283.275, 292.875,
    302.475, 312.075, 321.675, 331.275
  ]);
  // FUN_004040f0 displays the warp of the preceding feedback surface and only
  // then mixes the callback-selected image into the next surface. Align each
  // reconstructed callback with the native pass which feeds its first picture
  // in the released capture. The fifth callback already lies exactly on a
  // native pass and therefore needs no lead; the post-video sixth callback
  // repeats the first callback's fractional native-pass phase.
  const CREDITS_BACKGROUND_CALLBACK_LEAD_FRAMES = Object.freeze([
    1, 1, 3, 2, 0, 1
  ]);
  const CREDITS_BACKGROUND_CALLBACKS = Object.freeze(
    FINALE_VISUAL_CALLBACKS.slice(3).map((time, index) =>
      time - CREDITS_BACKGROUND_CALLBACK_LEAD_FRAMES[index] / 59)
  );
  const FINALE_VISUAL = FINALE_VISUAL_CALLBACKS[0];
  const FINALE_NATIVE_CALLBACK_PERIOD = 9.5956462585;
  const CREDITS_BACKGROUND_VISUAL = FINALE_VISUAL_CALLBACKS[2];
  // PTC's visual timer is already about 73 ms old when the BASS playback
  // clock starts. Dynamic renderers that consume that timer retain the lead.
  const ROCK_TIMER_LEAD = 0.073;
  const TO_46_A_VISUAL = PTC_CUES.to46A - CALLBACK_PRESENTATION_LEAD;
  const ROCK_REFERENCE_FPS = 60;
  const ROCK_REFERENCE_STEP = 1 / ROCK_REFERENCE_FPS;
  const ROCK_CALLBACK_PASSES = Object.freeze([288, 575, 862]);
  // The native renderer missed these eight 60 Hz capture slots.
  const ROCK_REPEATED_FRAMES = Object.freeze([
    213, 221, 229, 236, 244, 252, 261, 271
  ]);
  // FUN_00409400 installs the first row.  FUN_00409590 replaces all six
  // velocities at the three tracker callbacks using the executable's shared
  // rotate/add/xor generator (range 64000, mapped to [-1, 1)).
  const ROCK_VELOCITIES = [
    [0.16, 0.54, 0.26, 0.65, 0.46, 0.15],
    [0.52871875000000013, -0.12793750000000004, 0.99,
      0.55771875, -0.75196875, -0.98846875],
    [0.63109375, -0.49971875, -0.39874999999999994,
      0.36015624999999996, 0.61415625, 0.7965],
    [0.27134375, 0.76371875, -0.84421875,
      0.074249999999999927, -0.906125, -0.68815625]
  ];

  const FILES = {
    x2: 'data/x2.jpg',
    x3: 'data/x3.JPG', x4: 'data/x4.JPG', x5: 'data/x5.JPG', x6: 'data/x6.JPG',
    x7: 'data/x7.jpg', x8: 'data/x8.jpg', x9: 'data/x9.jpg',
    x10: 'data/x10.jpg', x11: 'data/x11.jpg', x12: 'data/x12.jpg',
    x13: 'data/x13.jpg', x14: 'data/x14.jpg', x15: 'data/x15.jpg',
    x16: 'data/x16.JPG', x17: 'data/x17.JPG', x18: 'data/x18.JPG',
    x19: 'data/x19.jpg', x21: 'data/x21.jpg', x22: 'data/x22.jpg',
    x23: 'data/x23.jpg', x24: 'data/x24.jpg', x25: 'data/x25.jpg',
    x26: 'data/x26.jpg', x27: 'data/x27.jpg',
    x28: 'data/x28.jpg', x29: 'data/x29.jpg', x30: 'data/x30.jpg',
    x31: 'data/x31.jpg', x32: 'data/x32.jpg', x33: 'data/x33.jpg',
    x34: 'data/x34.jpg', x35: 'data/x35.JPG', x36: 'data/x36.JPG',
    x37: 'data/x37.JPG', x38: 'data/x38.JPG', x39: 'data/x39.JPG',
    x40: 'data/x40.jpg', x41: 'data/x41.jpg', x42: 'data/x42.JPG',
    x43: 'data/x43.JPG', x44: 'data/x44.jpg', x45: 'data/x45.jpg',
    x46: 'data/x46.jpg', x47: 'data/x47.JPG', x48: 'data/x48.JPG',
    x49: 'data/x49.JPG', x50: 'data/x50.JPG', x51: 'data/x51.JPG',
    x52: 'data/x52.JPG', x53: 'data/x53.JPG', x54: 'data/x54.JPG',
    x55: 'data/x55.JPG', x56: 'data/x56.JPG', x57: 'data/x57.JPG',
    x58: 'data/x58.JPG', x59: 'data/x59.JPG', x60: 'data/x60.JPG',
    x61: 'data/x61.JPG', x62: 'data/x62.JPG', x63: 'data/x63.JPG',
    x64: 'data/x64.JPG', x65: 'data/x65.jpg', x66: 'data/x66.jpg',
    bob: 'data/superBob.jpg'
  };

  const canvas = document.querySelector('#screen');
  const ctx = canvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true
  });
  const gate = document.querySelector('#gate');
  const startButton = document.querySelector('#start');
  const loadingPreview = document.querySelector('#loading-preview');
  const loadingPreviewContext = loadingPreview.getContext('2d', { alpha: false });
  const status = document.querySelector('#status');

  function updateLoadingPreview(loading) {
    const { x, y, size } = LOADING_PREVIEW;
    loading.writeProgressLayer(loadingPreviewContext, x, y, size);
  }

  // WebKit never settles suspend() on a context that has not started running,
  // so awaiting one strands the caller. A context that is not running is
  // already silent; only an actually running context needs the call.
  async function suspendAudio(audioContext) {
    if (audioContext?.state !== 'running') return;
    await audioContext.suspend();
  }

  function makeCanvas(width, height) {
    const result = document.createElement('canvas');
    result.width = width;
    result.height = height;
    result.ctx = result.getContext('2d', { willReadFrequently: true });
    return result;
  }

  function clamp(value, low = 0, high = 1) {
    return Math.max(low, Math.min(high, value));
  }

  function nativeTrunc(value) {
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }

  function nativeEaseByte(value) {
    if (value <= 0) return 0;
    if (value >= 1) return 256;
    const angle = Math.trunc(value * 4096) & 8191;
    const cosine = Math.trunc(Math.cos(angle * 0.000766990234375) * 8192);
    return (8192 - cosine) >> 6;
  }

  function fract(value) {
    return value - Math.floor(value);
  }

  async function fetchBlob(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Could not load ${url}`);
    return response.blob();
  }

  function startBlobLoad(url, signal) {
    const load = fetchBlob(url, signal);
    // A later asset can fail before the ordered decoder reaches it. Attach a
    // handler now while retaining the original rejection for that later await.
    void load.catch(() => {});
    return load;
  }

  async function loadImage(url, blobLoad = fetchBlob(url)) {
    // The embedded IJG 6b decoder ignored the Photoshop ICC profiles in these
    // JPEGs. Disable browser color conversion to preserve the same RGB samples.
    return createImageBitmap(await blobLoad, {
      colorSpaceConversion: 'none',
      premultiplyAlpha: 'none'
    });
  }

  async function loadPCX(url, blobLoad = fetchBlob(url)) {
    const bytes = new Uint8Array(await (await blobLoad).arrayBuffer());
    if (bytes.length < 897 || bytes[0] !== 10 || bytes[2] !== 1 || bytes[3] !== 8) {
      throw new Error(`Unsupported PCX format in ${url}`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint16(8, true) - view.getUint16(4, true) + 1;
    const height = view.getUint16(10, true) - view.getUint16(6, true) + 1;
    const planes = bytes[65];
    const bytesPerLine = view.getUint16(66, true);
    if (planes !== 3) {
      throw new Error(`Unsupported ${planes}-plane PCX image in ${url}`);
    }

    const decoded = new Uint8Array(bytesPerLine * planes * height);
    let source = 128;
    let destination = 0;
    const dataEnd = bytes.length;
    while (destination < decoded.length && source < dataEnd) {
      const value = bytes[source++];
      if ((value & 0xc0) === 0xc0) {
        const count = value & 0x3f;
        const repeated = bytes[source++];
        decoded.fill(repeated, destination, Math.min(destination + count, decoded.length));
        destination += count;
      } else {
        decoded[destination++] = value;
      }
    }
    if (destination < decoded.length) throw new Error(`Truncated PCX image in ${url}`);

    const canvas = makeCanvas(width, height);
    const image = canvas.ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const output = (y * width + x) * 4;
        const row = y * bytesPerLine * 3;
        image.data[output] = decoded[row + x];
        image.data[output + 1] = decoded[row + bytesPerLine + x];
        image.data[output + 2] = decoded[row + bytesPerLine * 2 + x];
        image.data[output + 3] = 255;
      }
    }
    canvas.ctx.putImageData(image, 0, 0);
    return canvas;
  }

  class PrecalcDecoder {
    constructor(image, frames) {
      this.image = image;
      this.frames = frames;
      this.scratchA = makeCanvas(129, 97);
      this.scratchB = makeCanvas(129, 97);
      this.frameCache = new Map();
      this.output = new ImageData(WIDTH, HEIGHT);
      this.temporal = new Uint16Array(129 * 97 * 3);
    }

    readFrame(index, scratch) {
      index = ((index % this.frames) + this.frames) % this.frames;
      const cached = this.frameCache.get(index);
      if (cached) return cached;

      scratch.ctx.drawImage(this.image, 0, index * 97, 129, 97, 0, 0, 129, 97);
      const pixels = scratch.ctx.getImageData(0, 0, 129, 97).data;
      this.frameCache.set(index, pixels);
      if (this.frameCache.size > 10) {
        this.frameCache.delete(this.frameCache.keys().next().value);
      }
      return pixels;
    }

    draw(target, frame) {
      const firstIndex = Math.floor(frame);
      const mix = Math.trunc(fract(frame) * 256);
      // FUN_00401130 deliberately uses weights summing to 255.
      const inverse = 255 - mix;
      const first = this.readFrame(firstIndex, this.scratchA);
      const second = this.readFrame(firstIndex + 1, this.scratchB);
      const temporal = this.temporal;

      for (let source = 0, out = 0; source < first.length; source += 4) {
        temporal[out++] = (first[source] * inverse + second[source] * mix) >> 8;
        temporal[out++] = (first[source + 1] * inverse + second[source + 1] * mix) >> 8;
        temporal[out++] = (first[source + 2] * inverse + second[source + 2] * mix) >> 8;
      }

      // FUN_00401130 walks each 4x4 cell with fixed-point /4 increments.
      const output = this.output.data;
      for (let cellY = 0; cellY < 96; cellY++) {
        for (let cellX = 0; cellX < 128; cellX++) {
          const topLeft = (cellY * 129 + cellX) * 3;
          const topRight = topLeft + 3;
          const bottomLeft = topLeft + 129 * 3;
          const bottomRight = bottomLeft + 3;
          for (let channel = 0; channel < 3; channel++) {
            let left = temporal[topLeft + channel] << 8;
            let right = temporal[topRight + channel] << 8;
            const leftStep = ((temporal[bottomLeft + channel] << 8) - left) >> 2;
            const rightStep = ((temporal[bottomRight + channel] << 8) - right) >> 2;
            for (let subY = 0; subY < 4; subY++) {
              let current = left;
              const horizontalStep = (right - left) >> 2;
              let destination = (((cellY << 2) + subY) * WIDTH +
                (cellX << 2)) * 4 + channel;
              for (let subX = 0; subX < 4; subX++) {
                output[destination] = (current >> 8) & 255;
                destination += 4;
                current = (current + horizontalStep) | 0;
              }
              left = (left + leftStep) | 0;
              right = (right + rightStep) | 0;
            }
          }
        }
      }
      for (let destination = 3; destination < output.length; destination += 4) {
        output[destination] = 255;
      }
      target.putImageData(this.output, 0, 0);
    }
  }

  class Demo {
    constructor() {
      this.images = {};
      this.loading = null;
      this.ifsEffect = null;
      this.rockFrame = null;
      this.rockGlowFrame = null;
      this.sphereLookup = null;
      this.audioBytes = null;
      this.audioContext = null;
      this.music = null;
      this.musicLoadPromise = null;
      this.running = false;
      this.starting = false;
      this.startSequence = 0;
      this.paused = false;
      this.startContextTime = 0;
      this.startDemoTime = 0;
      this.pauseDemoTime = 0;
      this.frameRequest = 0;
      this.pauseTransition = Promise.resolve();
      this.controlSeekTarget = null;
      this.controlSeekSequence = 0;
      this.intro = null;
      this.comic = null;
      this.lateTransitions = null;
      this.warp28 = null;
      this.particleEffects = null;
      this.partANoise = null;
      this.x7Strip = null;
      this.earlyTransitions = null;
      this.assetScratch = null;
      this.loadAbortController = null;
    }

    async load() {
      this.loadAbortController?.abort();
      const loadController = new AbortController();
      this.loadAbortController = loadController;
      const assetBlobs = new Map();
      try {
        await this.loadAssets(loadController, assetBlobs);
      } catch (error) {
        loadController.abort();
        throw error;
      } finally {
        assetBlobs.clear();
        if (this.loadAbortController === loadController) {
          this.loadAbortController = null;
        }
      }
    }

    async loadAssets(loadController, assetBlobs) {
      const { signal } = loadController;

      // Get the original loading artwork on screen first. The remaining files
      // then transfer together while decoding and preparation retain the
      // executable's order and real progress checkpoints.
      const loadingImage = await loadImage(
        'data/x1.jpg', fetchBlob('data/x1.jpg', signal));
      const loadingSource = makeCanvas(WIDTH, HEIGHT);
      try {
        loadingSource.ctx.drawImage(loadingImage, 0, 0, WIDTH, HEIGHT);
      } finally {
        loadingImage.close?.();
      }
      this.loading = new LoadingEffect(
        loadingSource.ctx.getImageData(0, 0, WIDTH, HEIGHT));
      this.loading.renderSequenceIndex(ctx, 0);
      updateLoadingPreview(this.loading);
      await new Promise(resolve => requestAnimationFrame(resolve));

      const imageURLs = Object.values(FILES);
      const pcxPosition = imageURLs.indexOf(FILES.x19) + 1;
      const assetURLs = new Set([
        ...imageURLs.slice(0, pcxPosition),
        'data/x26.pcx',
        ...imageURLs.slice(pcxPosition),
        AUDIO_URL
      ]);
      for (const url of assetURLs) {
        assetBlobs.set(url, startBlobLoad(url, signal));
      }
      const blobFor = url => assetBlobs.get(url);

      let progressIndex = 1;
      const decode = async (name, retain = true) => {
        const image = await loadImage(FILES[name], blobFor(FILES[name]));
        if (retain) this.images[name] = image;
        else image.close?.();
        await this.presentLoadingProgress(progressIndex++);
      };

      for (const name of ['x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9']) {
        await decode(name);
      }
      await decode('x10', false); // The executable decodes and discards this copy.
      await decode('x10');
      for (const name of [
        'x11', 'x12', 'x13', 'x14', 'x15', 'x16', 'x17', 'x18', 'x19'
      ]) await decode(name);

      this.images.x26pcx = await loadPCX(
        'data/x26.pcx', blobFor('data/x26.pcx'));
      await this.presentLoadingProgress(progressIndex++);
      for (const name of ['x21', 'x22', 'x23', 'x24', 'x25', 'x26', 'x27']) {
        await decode(name);
      }

      this.prepareBlob();
      await this.presentLoadingProgress(progressIndex++);
      await this.presentLoadingProgress(progressIndex++);

      for (const name of [
        'x28', 'x29', 'x30', 'x31', 'x32', 'x33', 'x34', 'x35', 'x36',
        'x37', 'x38', 'x39', 'x40', 'x41', 'x42', 'x43', 'x44'
      ]) await decode(name);

      await this.presentLoadingProgress(progressIndex++);
      await this.presentLoadingProgress(progressIndex++);
      await this.presentLoadingProgress(progressIndex++);

      for (const name of [
        'x45', 'x46', 'x47', 'x48', 'x49', 'x50', 'x51', 'x52', 'x53',
        'x54', 'x55', 'x56', 'x57', 'x58', 'x59', 'x60', 'x61', 'x62',
        'x63', 'x64', 'x65', 'x66'
      ]) await decode(name);

      this.prepareComicSources();
      this.preparePartANoise();
      await this.presentLoadingProgress(progressIndex++);
      await this.presentLoadingProgress(progressIndex++);
      await this.presentLoadingProgress(progressIndex++);

      this.prepareLateTransitions();
      await this.presentLoadingProgress(progressIndex++);

      this.prepareCreditsForeground();
      this.prepareCreditsAndWarp();
      await this.presentLoadingProgress(progressIndex++);
      this.preparePrecalcDecoders();
      await this.presentLoadingProgress(progressIndex++);
      await this.presentLoadingProgress(progressIndex++);
      await this.presentLoadingProgress(progressIndex++);
      await this.presentLoadingProgress(progressIndex++); // Native .83 call.

      this.prepareRock();
      await this.presentLoadingProgress(progressIndex++);
      await this.presentLoadingProgress(progressIndex++); // Native .87 call.

      this.images.bob = await loadImage(FILES.bob, blobFor(FILES.bob));
      this.prepareIntroAndComic();
      await this.presentLoadingProgress(progressIndex++);

      this.prepareParticles();
      await this.presentLoadingProgress(progressIndex++);
      this.prepareIFS();
      await this.presentLoadingProgress(progressIndex++);
      this.prepareTunnel();
      await this.presentLoadingProgress(progressIndex++);
      this.prepareFinalEffects();
      await this.presentLoadingProgress(progressIndex++);
      await this.presentLoadingProgress(progressIndex++); // Native .97 call.

      this.audioBytes = await (await blobFor(AUDIO_URL)).arrayBuffer();
      await this.loadMusic();
      await this.presentLoadingProgress(progressIndex++);
      if (progressIndex !== LOADING_PROGRESS_SEQUENCE.length) {
        throw new Error(`Native loading sequence ended at ${progressIndex}`);
      }
      for (const [name, image] of Object.entries(this.images)) {
        if (name === 'x41' || name === 'x46') continue;
        if (name !== 'x7' && name !== 'x8') image.close?.();
        delete this.images[name];
      }
      this.assetScratch = null;
      this.loading = null;
      gate.classList.add('gate--ready');
      startButton.disabled = false;
      startButton.textContent = 'START';
      status.textContent = '';
      status.setAttribute('aria-busy', 'false');
    }

    async loadMusic() {
      if (this.music?.loaded && this.audioContext &&
          this.audioContext.state !== 'closed') return this.music;
      if (this.musicLoadPromise) return this.musicLoadPromise;

      const load = (async () => {
        const staleMusic = this.music;
        const staleContext = this.audioContext;
        this.music = null;
        this.audioContext = null;
        staleMusic?.destroy();
        if (staleContext && staleContext.state !== 'closed') {
          await staleContext.close().catch(() => {});
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) throw new Error('Web Audio is unavailable');
        const audioContext = new AudioContextClass({ sampleRate: 44100 });
        // The worklet reproduces BASS_MusicSetAmplify(handle, 75), its
        // 28-channel master scaling, and its final signed-16-bit conversion.
        const music = new XMPlayer({ context: audioContext });
        try {
          // The native loader creates and parses the music at progress index 89,
          // but BASS_MusicPlay still waits for the click. AudioWorklet messages
          // remain serviceable while a Web Audio context is suspended.
          await suspendAudio(audioContext);
          await music.load(this.audioBytes);
        } catch (error) {
          music.destroy();
          await audioContext.close().catch(() => {});
          throw error;
        }
        this.audioContext = audioContext;
        this.music = music;
        return music;
      })();
      this.musicLoadPromise = load;
      try {
        return await load;
      } finally {
        if (this.musicLoadPromise === load) this.musicLoadPromise = null;
      }
    }

    async discardFailedLoad() {
      const resources = new Set(Object.values(this.images));
      if (this.video1?.image) resources.add(this.video1.image);
      if (this.video2?.image) resources.add(this.video2.image);
      for (const resource of resources) {
        try {
          resource.close?.();
        } catch {
          // Continue releasing the remaining load-time resources.
        }
      }

      const music = this.music;
      const audioContext = this.audioContext;
      this.music = null;
      this.audioContext = null;
      this.musicLoadPromise = null;
      try {
        music?.destroy();
      } catch {
        // Continue releasing the remaining load-time resources.
      }
      if (audioContext && audioContext.state !== 'closed') {
        await audioContext.close().catch(() => {});
      }

      this.images = {};
      this.loading = null;
      this.ifsEffect = null;
      this.rockFrame = null;
      this.rockGlowFrame = null;
      this.sphereLookup = null;
      this.audioBytes = null;
      this.intro = null;
      this.comic = null;
      this.lateTransitions = null;
      this.warp28 = null;
      this.particleEffects = null;
      this.partANoise = null;
      this.x7Strip = null;
      this.earlyTransitions = null;
      this.assetScratch = null;
      this.blob = null;
      this.creditsForeground = null;
      this.creditsBackground = null;
      this.video1 = null;
      this.video2 = null;
      this.rockTexture = null;
      this.rockLightTexture = null;
      this.rockBackground = null;
      this.comicSources = null;
      this.tunnel = null;
      this.heightfield = null;
    }

    async presentLoadingProgress(index) {
      if (index < 0 || index >= LOADING_PROGRESS_SEQUENCE.length) {
        throw new RangeError(`Native loading progress index ${index} is invalid`);
      }
      this.loading.renderSequenceIndex(ctx, index);
      updateLoadingPreview(this.loading);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }

    assetPixels(name, width = WIDTH, height = HEIGHT) {
      if (!this.assetScratch) this.assetScratch = makeCanvas(width, height);
      this.assetScratch.width = width;
      this.assetScratch.height = height;
      this.assetScratch.ctx.clearRect(0, 0, width, height);
      this.assetScratch.ctx.drawImage(this.images[name], 0, 0, width, height);
      return this.assetScratch.ctx.getImageData(0, 0, width, height);
    }

    prepareBlob() {
      const sources = {};
      for (const name of ['x21', 'x22', 'x23', 'x24', 'x25', 'x26', 'x27']) {
        sources[name] = this.assetPixels(name, 512, 512);
      }
      this.blob = new BlobEffect({
        ...sources,
        startTime: BLOB_VISUAL,
        swapTime: BLOB_SWAP_VISUAL,
        endTime: PARTICLES_B_VISUAL
      });
    }

    prepareComicSources() {
      const names = [
        'x15', 'x17', 'x18', 'x29', 'x30', 'x31', 'x32', 'x33',
        'x34', 'x35', 'x36', 'x37', 'x38', 'x39', 'x40'
      ];
      this.comicSources = Object.fromEntries(
        names.map(name => [name, this.assetPixels(name)]));
    }

    preparePartANoise() {
      this.partANoise = new PartANoiseEffect();
    }

    prepareLateTransitions() {
      this.lateTransitions = new LateTransitionEffect({
        x44RGBA: this.assetPixels('x44'),
        x46RGBA: this.assetPixels('x46')
      });
    }

    prepareCreditsForeground() {
      this.creditsForeground = new CreditsForeground({
        images: this.images,
        callbackTimes: FINALE_VISUAL_CALLBACKS
      });
    }

    prepareCreditsAndWarp() {
      this.creditsBackground = new CreditsBackground({
        x3: this.images.x3,
        x4: this.images.x4,
        x5: this.images.x5,
        x6: this.images.x6,
        startTime: CREDITS_BACKGROUND_VISUAL,
        callbackTimes: CREDITS_BACKGROUND_CALLBACKS,
        repeatPeriod: FINALE_NATIVE_CALLBACK_PERIOD,
        timerLead: ROCK_TIMER_LEAD
      });
      const sourceRGBA = this.assetPixels('x28', 512, 512);
      this.warp28 = new Warp28Effect({ sourceRGBA });
    }

    preparePrecalcDecoders() {
      this.video1 = new PrecalcDecoder(this.images.x7, 250);
      this.video2 = new PrecalcDecoder(this.images.x8, 120);
      this.x7Strip = new X7StripEffect({
        startTime: MOVIE7_REVEAL_START * TICK_SCALE
      });
    }

    prepareRock() {
      this.rockFrame = ctx.createImageData(WIDTH, HEIGHT);
      this.rockGlowFrame = ctx.createImageData(WIDTH, HEIGHT);
      this.sphereLookup = Float32Array.from({ length: 5096 }, (_, index) => {
        const radial = Math.min(1, index * 0.00024420025874860585);
        return 4 / (Math.sqrt(1 - radial) * 60 + 44);
      });
      this.rockTexture = this.assetPixels('x10', 512, 512).data;
      this.rockLightTexture = this.assetPixels('x11', 512, 512).data;
      this.rockBackground = this.assetPixels('x16').data;
    }

    prepareIntroAndComic() {
      this.intro = new IntroEffect({
        x12: this.assetPixels('x12'),
        x13: this.assetPixels('x13'),
        x14: this.assetPixels('x14'),
        x15: this.assetPixels('x15'),
        superBob: this.assetPixels('bob', 8, 8)
      });
      this.comic = new ComicEffect({
        ...this.comicSources,
        intro: this.intro,
        warp: this.warp28
      });
      this.comicSources = null;
    }

    prepareParticles() {
      this.particleEffects = new ParticleEffects();
    }

    prepareIFS() {
      const palette = makeCanvas(256, 1);
      palette.ctx.drawImage(this.images.x2, 0, 0);
      this.ifsEffect = new IFSEffect({
        backgroundRGBA: this.assetPixels('x46'),
        paletteRGBA: palette.ctx.getImageData(0, 0, 256, 1),
        shoes: [
          { imageRGBA: this.assetPixels('x47'), maskRGBA: this.assetPixels('x51') },
          { imageRGBA: this.assetPixels('x48'), maskRGBA: this.assetPixels('x52') },
          { imageRGBA: this.assetPixels('x49'), maskRGBA: this.assetPixels('x53') },
          { imageRGBA: this.assetPixels('x50'), maskRGBA: this.assetPixels('x54') }
        ],
        sceneStart: IFS_VISUAL,
        paletteCues: [
          PTC_CUES.ifsChange1 - CALLBACK_PRESENTATION_LEAD,
          PTC_CUES.shoe1 - CALLBACK_PRESENTATION_LEAD,
          PTC_CUES.shoe2 - CALLBACK_PRESENTATION_LEAD,
          PTC_CUES.shoe3 - CALLBACK_PRESENTATION_LEAD,
          PTC_CUES.shoe4 - CALLBACK_PRESENTATION_LEAD
        ],
        timerLead: ROCK_TIMER_LEAD,
        shoeCues: [
          PTC_CUES.shoe1 - CALLBACK_PRESENTATION_LEAD,
          PTC_CUES.shoe2 - CALLBACK_PRESENTATION_LEAD,
          PTC_CUES.shoe3 - CALLBACK_PRESENTATION_LEAD,
          PTC_CUES.shoe4 - CALLBACK_PRESENTATION_LEAD
        ]
      });
    }

    prepareTunnel() {
      this.tunnel = new TunnelEffect({
        sourceRGBA: this.assetPixels('x9', 512, 512),
        firstPassVisualTime: EARLY_TRANSITION_TIMING.feedbackFirstUpdateVisual,
        firstSampleTime: EARLY_TRANSITION_TIMING.feedbackFirstSampleTime
      });
    }

    prepareFinalEffects() {
      const colorMap = this.assetPixels('x19', 512, 512).data;
      const heightMap = this.images.x26pcx.ctx
        .getImageData(0, 0, 512, 512).data;
      this.heightfield = new HeightfieldEffect({
        colorRGBA: colorMap,
        heightRGBA: heightMap,
        startTime: TERRAIN_VISUAL,
        endTime: FEEDBACK_FIRST_PASS_VISUAL
      });
      this.earlyTransitions = new EarlyTransitionChain({
        x45: this.assetPixels('x45'),
        x42: this.assetPixels('x42'),
        x43: this.assetPixels('x43')
      });

      // FUN_0040ac30 seeds its recursive surface with the terrain frame drawn
      // in the same scheduler walk as its first pass: after the terrain and
      // TV objects (priorities 1 and 50), before the black and white layers.
      const initial = makeCanvas(WIDTH, HEIGHT);
      this.heightfield.render(initial.ctx, FEEDBACK_FIRST_PASS_VISUAL - 1e-6);
      this.earlyTransitions.applyTV(initial.ctx, FEEDBACK_FIRST_PASS_VISUAL);
      this.tunnel.initialize(initial.ctx.getImageData(0, 0, WIDTH, HEIGHT));
    }

    drawImage(name) {
      ctx.drawImage(this.images[name], 0, 0, WIDTH, HEIGHT);
    }

    async start(at = 0) {
      const sequence = ++this.startSequence;
      this.starting = true;
      const superseded = () => sequence !== this.startSequence;
      try {
        if (!this.music?.loaded || !this.audioContext ||
            this.audioContext.state === 'closed') {
          status.textContent = 'loading the original tracker module…';
          await this.loadMusic();
          if (superseded()) return;
        }
        await this.audioContext.resume();
        if (superseded()) return;
        // A direct timeline seek can spend several frames reconstructing replay
        // and visual state. Quiesce the old loop before that asynchronous work.
        this.running = false;
        this.paused = false;
        cancelAnimationFrame(this.frameRequest);
        this.stopSource();
        this.startDemoTime = Math.max(0, at);
        await this.music.seek(this.startDemoTime);
        if (superseded()) return;
        this.x7Strip.reset(this.startDemoTime);
        // Some effects reconstruct a sought frame synchronously. Do that while
        // the tracker is still paused so their cost cannot advance playback.
        this.render(this.startDemoTime);
        if (superseded()) return;
        // The reconstruction may block main-thread clock messages. Refresh the
        // paused worklet snapshot before exposing currentTime or starting audio.
        await this.music.pause();
        if (superseded()) return;
        const playedState = await this.music.play();
        if (superseded()) return;
        // The release starts its PTC timer immediately after BASS_MusicPlay.
        // Keep the visual clock independent of the tracker's replay clock too.
        this.startContextTime = Number.isFinite(playedState?.audioTime)
          ? playedState.audioTime
          : this.audioContext.currentTime;
        this.running = true;
        this.paused = false;
        canvas.classList.add('screen--visible');
        if (this.controlSeekTarget === null) status.textContent = '';
        this.frameRequest = requestAnimationFrame(this.tick);
        void acquireWakeLock();
      } catch (error) {
        if (!superseded()) throw error;
      } finally {
        if (!superseded()) this.starting = false;
      }
    }

    time() {
      if (this.paused) return this.pauseDemoTime;
      return this.startDemoTime + this.audioContext.currentTime - this.startContextTime;
    }

    togglePause() {
      const transition = this.pauseTransition.then(() => this.applyPauseToggle());
      // Keep overlapping toggles serialized, while returning the real result to
      // callers that choose to observe a transition failure.
      this.pauseTransition = transition.catch(() => {});
      return transition;
    }

    async applyPauseToggle() {
      const sequence = this.startSequence;
      const active = () => this.running && sequence === this.startSequence;
      if (!active()) return;
      if (this.paused) {
        try {
          await this.audioContext.resume();
        } catch (error) {
          if (!active()) return;
          throw error;
        }
        if (!active()) return;
        this.startDemoTime = this.pauseDemoTime;
        let playedState;
        try {
          playedState = await this.music.play();
        } catch (error) {
          if (!active()) return;
          throw error;
        }
        if (!active()) return;
        this.startContextTime = Number.isFinite(playedState?.audioTime)
          ? playedState.audioTime
          : this.audioContext.currentTime;
        this.paused = false;
        this.tick();
      } else {
        const fallbackTime = this.time();
        this.paused = true;
        cancelAnimationFrame(this.frameRequest);
        let pausedState;
        try {
          pausedState = await this.music.pause();
        } catch (error) {
          if (!active()) return;
          this.paused = false;
          throw error;
        }
        if (!active()) return;
        this.pauseDemoTime = Number.isFinite(pausedState?.time)
          ? pausedState.time
          : fallbackTime;
        try {
          await suspendAudio(this.audioContext);
        } catch (error) {
          if (!active()) return;
          throw error;
        }
      }
    }

    stopSource() {
      this.music?.stop();
    }

    stop(force = false) {
      const wasActive = this.running || this.starting;
      this.startSequence++;
      this.starting = false;
      if (!wasActive && !force) return;
      this.running = false;
      this.paused = false;
      this.controlSeekTarget = null;
      this.controlSeekSequence++;
      cancelAnimationFrame(this.frameRequest);
      this.stopSource();
      releaseWakeLock();
      void suspendAudio(this.audioContext).catch(() => {});
      canvas.classList.remove('screen--visible');
      gate.classList.remove('gate--hidden', 'gate--error');
      startButton.disabled = false;
      startButton.textContent = 'START';
      status.textContent = '';
    }

    seekBy(delta) {
      if (!this.running && this.controlSeekTarget === null) return null;
      const base = this.controlSeekTarget ?? this.time();
      const target = Math.max(0, base + delta);
      const sequence = ++this.controlSeekSequence;
      this.controlSeekTarget = target;
      const transition = this.start(target).finally(() => {
        if (sequence === this.controlSeekSequence) this.controlSeekTarget = null;
      });
      return { target, transition };
    }

    tick = () => {
      if (!this.running || this.paused) return;
      try {
        this.render(this.time());
      } catch (error) {
        console.error(error);
        presentStartError(error);
        return;
      }
      this.frameRequest = requestAnimationFrame(this.tick);
    };

    render(wallTime) {
      const time = wallTime / TICK_SCALE;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, WIDTH, HEIGHT);

      if (time < PTC_CUES.comicStart) this.renderIntro(time);
      else if (time < MOVIE7_REVEAL_START) this.renderComicOne(time);
      else if (time < TERRAIN_VISUAL) this.renderPrecalcOne(time, wallTime);
      else if (time < FEEDBACK_FIRST_PASS_VISUAL) this.renderVoxel(time);
      else if (time < PARTICLES_A_VISUAL) this.renderTunnel(time);
      else if (time < ROCK_VISUAL) this.renderPartA(time);
      else if (time < IFS_VISUAL) this.renderLightBall(time);
      else if (time < MOVIE8_VISUAL) this.renderIFSAndShoes(time);
      else if (time < X44_VISUAL) this.renderPrecalcTwo(time);
      else if (time < BLOB_VISUAL) this.renderArtwork(time);
      else if (time < PARTICLES_B_VISUAL) this.renderMorph(time);
      else if (time < FINALE_VISUAL) this.renderGalaxy(time);
      else this.renderFinale(time);
    }

    renderIntro(time) {
      this.intro.render(ctx, time);
    }

    renderComicOne(time) {
      this.comic.render(ctx, time);
    }

    renderPrecalcOne(time, wallTime) {
      // At order 9 row 0 the persistent black object is reset to state zero
      // and advances to one over 0.2 s.  FUN_004032d0 multiplies every channel
      // by the same quantized cosine weight before the frame is presented.
      const blackWeight = Math.min(255,
        nativeEaseByte((time - MOVIE7_REVEAL_START) / 0.2));
      // The strip's instrument callbacks are replay sample frames, so its
      // clock is the wall clock rather than nominal tracker seconds.
      this.video1.draw(ctx, this.x7Strip.frameAt(wallTime));
      this.earlyTransitions.applyPersistentFades(ctx, time, blackWeight);
    }

    renderVoxel(time) {
      // The object updates immediately when linked, including while the white
      // endpoint still hides it; its frame-counted filters must not be frozen.
      this.heightfield.render(ctx, time);
      this.earlyTransitions.applyTV(ctx, time);
      this.earlyTransitions.applyPersistentFades(ctx, time);
    }

    renderTunnel(time) {
      this.tunnel.render(ctx, time);
      this.earlyTransitions.applyLiveToX45(ctx, time);
      this.earlyTransitions.applyPersistentFades(ctx, time);
    }

    renderPartA(time) {
      // The priority-60 live->x45 object remains scheduled after feedback is
      // removed. At this point it is at endpoint one and copies x45 exactly.
      this.earlyTransitions.applyLiveToX45(ctx, time);
      this.particleEffects.renderPartA(ctx, time);
      this.earlyTransitions.applyPersistentFades(ctx, time);
      this.partANoise.render(ctx, time);
    }

    rockPhasesAtFrame(frame) {
      const phases = new Float64Array(6);
      // FUN_00409660 draws from the old phases, then advances them.  The first
      // pass only stamps its timer, so frames zero and one share phase zero.
      for (let pass = 1; pass < frame; pass++) {
        let epoch = 0;
        while (epoch < ROCK_CALLBACK_PASSES.length &&
               pass >= ROCK_CALLBACK_PASSES[epoch]) epoch++;
        const velocities = ROCK_VELOCITIES[epoch];
        for (let index = 0; index < phases.length; index++) {
          phases[index] += velocities[index] * ROCK_REFERENCE_STEP;
        }
      }
      return phases;
    }

    renderLightBall(time) {
      let referenceFrame = Math.max(0,
        Math.floor((time - ROCK_VISUAL) * ROCK_REFERENCE_FPS + 1e-7));
      if (ROCK_REPEATED_FRAMES.includes(referenceFrame)) referenceFrame--;
      const referenceTime = ROCK_VISUAL + referenceFrame / ROCK_REFERENCE_FPS;
      const physicsTime = referenceTime + ROCK_TIMER_LEAD;
      const centerX = Math.fround(
        (Math.sin(physicsTime * 0.3476 + 4) + Math.cos(physicsTime * 0.423 + 3)) * 100 + 256);
      const centerY = Math.fround(
        (Math.sin(physicsTime * 0.31 + 2) + Math.cos(physicsTime * 0.44 + 5)) * 90 + 192);
      const radius = Math.fround(Math.sin(physicsTime * 0.1) * 64 + 80);

      const phases = this.rockPhasesAtFrame(referenceFrame);
      const textureX = Math.fround((Math.sin(phases[0]) + Math.sin(phases[1])) * 58);
      const textureY = Math.fround((Math.sin(phases[2]) + Math.sin(phases[3])) * 47);
      const rotation = Math.fround(Math.sin(phases[4]) + Math.sin(phases[5]) + 3.1415);

      this.rasterRockSphere(centerX, centerY, radius, rotation, textureX, textureY);
      this.applyRockRadial(centerX, centerY);
      const live = this.rockFrame.data;
      const light = this.rockGlowFrame.data;
      for (let offset = 0; offset < live.length; offset += 4) {
        live[offset] = Math.min(255, live[offset] + light[offset]);
        live[offset + 1] = Math.min(255, live[offset + 1] + light[offset + 1]);
        live[offset + 2] = Math.min(255, live[offset + 2] + light[offset + 2]);
      }
      ctx.putImageData(this.rockFrame, 0, 0);
      // The later packed live-framebuffer->x46 object runs at priority 60;
      // its 255/256 cosine blend is not Canvas globalAlpha.
      this.lateTransitions.crossfadeLive(ctx, 'x46', time,
        TO_46_A_VISUAL, 2.0);
      this.lateTransitions.compositePersistent(ctx);
      this.partANoise.render(ctx, time);
    }

    rasterRockSphere(centerXValue, centerYValue, radiusValue,
        rotationValue, textureXValue, textureYValue) {
      const output = this.rockFrame.data;
      const glow = this.rockGlowFrame.data;
      output.set(this.rockBackground);
      glow.fill(0);
      for (let offset = 3; offset < glow.length; offset += 4) glow[offset] = 255;

      const centerX = Math.fround(centerXValue);
      const centerY = Math.fround(centerYValue);
      const radius = Math.fround(radiusValue);
      const rotation = Math.fround(rotationValue);
      const textureX = Math.fround(textureXValue);
      const textureY = Math.fround(textureYValue);
      const sin = Math.fround(Math.sin(rotation));
      const cos = Math.fround(Math.cos(rotation));
      const radiusSquared = Math.fround(radius * radius);
      const inverseRadius = Math.fround(1 / radius);

      let firstY = Math.trunc(centerY - radius + 0.5);
      let lastY = Math.trunc(centerY + radius + 0.5);
      if (firstY > HEIGHT - 1 || lastY < 0) return;
      firstY = Math.max(0, firstY);
      lastY = Math.min(HEIGHT - 1, lastY);

      let normalizedY = (firstY - centerY) * inverseRadius;
      const normalizedYAtLast = (lastY - centerY) * inverseRadius;
      const normalizedYStep = Math.fround(
        (normalizedYAtLast - normalizedY) / (lastY - firstY));
      if (firstY > lastY) return;

      for (let y = firstY; y <= lastY; y++) {
        const relativeY = y - centerY;
        const chord = Math.sqrt(radiusSquared - relativeY * relativeY);
        let firstX = nativeTrunc(centerX - chord + 0.5);
        let lastX = nativeTrunc(centerX + chord + 0.5);

        if (firstX < WIDTH && lastX >= 0) {
          let normalizedX = (firstX - centerX) * inverseRadius;
          const normalizedXAtLast = (lastX - centerX) * inverseRadius;
          const normalizedXStep = Math.fround(
            (normalizedXAtLast - normalizedX) / (lastX - firstX));
          let rotatedX = normalizedX * cos - normalizedY * sin;
          let rotatedY = normalizedX * sin + normalizedY * cos;
          const rotatedXStep = Math.fround(normalizedXStep * cos);
          const rotatedYStep = Math.fround(normalizedXStep * sin);
          const normalizedYSquared = Math.fround(normalizedY * normalizedY);

          if (firstX < 0) {
            rotatedX -= firstX * rotatedXStep;
            rotatedY -= firstX * rotatedYStep;
            normalizedX -= firstX * normalizedXStep;
            firstX = 0;
          }
          lastX = Math.min(WIDTH - 1, lastX);

          let count = lastX - firstX;
          let destination = (y * WIDTH + firstX) * 4;
          while (count-- > 0) {
            const radialIndex = -nativeTrunc(
              (normalizedX * normalizedX + normalizedYSquared) * -4096);
            const stretch = this.sphereLookup[radialIndex] * 2560;
            const sourceY = nativeTrunc(rotatedY * stretch + textureY);
            const sourceX = nativeTrunc(rotatedX * stretch + textureX);
            const source = (((sourceY << 9) + sourceX) & 0x3ffff) * 4;
            output[destination] = this.rockTexture[source];
            output[destination + 1] = this.rockTexture[source + 1];
            output[destination + 2] = this.rockTexture[source + 2];
            glow[destination] = this.rockLightTexture[source];
            glow[destination + 1] = this.rockLightTexture[source + 1];
            glow[destination + 2] = this.rockLightTexture[source + 2];
            destination += 4;
            normalizedX += normalizedXStep;
            rotatedX += rotatedXStep;
            rotatedY += rotatedYStep;
          }
        }

        normalizedY += normalizedYStep;
      }
    }

    applyRockRadial(centerX, centerY) {
      const pixels = this.rockGlowFrame.data;
      const originX = Math.max(0, Math.min(WIDTH - 1, Math.floor(centerX)));
      const originY = Math.max(0, Math.min(HEIGHT - 1, Math.floor(centerY)));
      const xMap = new Int32Array(WIDTH);
      const yMap = new Int32Array(HEIGHT);
      const radialScale = Math.fround(0.02);
      for (let x = 0; x < WIDTH; x++) {
        xMap[x] = Math.trunc((originX - x) * radialScale * 32768);
      }
      for (let y = 0; y < HEIGHT; y++) {
        yMap[y] = Math.trunc((originY - y) * radialScale * 32768);
      }

      const interpolate = (from, to, weight) =>
        from + ((Math.imul(to - from, weight) >> 16) * 2);
      const process = (x, y) => {
        const horizontal = xMap[x];
        const vertical = yMap[y];
        const sourceX = x + (horizontal >> 15);
        const sourceY = y + (vertical >> 15);
        const nextX = Math.min(WIDTH - 1, sourceX + 1);
        const nextY = Math.min(HEIGHT - 1, sourceY + 1);
        const fractionX = ((horizontal & 32767) >> 7) << 7;
        const fractionY = vertical & 32767;
        const topLeft = (sourceY * WIDTH + sourceX) * 4;
        const topRight = (sourceY * WIDTH + nextX) * 4;
        const bottomLeft = (nextY * WIDTH + sourceX) * 4;
        const bottomRight = (nextY * WIDTH + nextX) * 4;
        const destination = (y * WIDTH + x) * 4;

        // The 64-bit vertical/feedback multiplier is `f *
        // 0x0000000100010001`, which repeats the weight across B/G/R while
        // leaving alpha alone. Horizontal interpolation uses 0x00RRGGBB.
        const leftRed = interpolate(pixels[topLeft], pixels[bottomLeft], fractionY);
        const leftGreen = interpolate(pixels[topLeft + 1], pixels[bottomLeft + 1], fractionY);
        const leftBlue = interpolate(pixels[topLeft + 2], pixels[bottomLeft + 2], fractionY);
        const rightRed = interpolate(pixels[topRight], pixels[bottomRight], fractionY);
        const rightGreen = interpolate(pixels[topRight + 1], pixels[bottomRight + 1], fractionY);
        const rightBlue = interpolate(pixels[topRight + 2], pixels[bottomRight + 2], fractionY);
        const oldRed = pixels[destination];
        const oldGreen = pixels[destination + 1];
        const oldBlue = pixels[destination + 2];
        const red = interpolate(leftRed, rightRed, fractionX) +
          ((Math.imul(oldRed, 8191) >> 16) * 2);
        const green = interpolate(leftGreen, rightGreen, fractionX) +
          ((Math.imul(oldGreen, 8191) >> 16) * 2);
        const blue = interpolate(leftBlue, rightBlue, fractionX) +
          ((Math.imul(oldBlue, 8191) >> 16) * 2);
        pixels[destination] = Math.max(0, Math.min(255, red));
        pixels[destination + 1] = Math.max(0, Math.min(255, green));
        pixels[destination + 2] = Math.max(0, Math.min(255, blue));
        pixels[destination + 3] = pixels[topLeft + 3];
      };

      for (let y = originY; y < HEIGHT; y++) {
        for (let x = originX; x < WIDTH; x++) process(x, y);
        for (let x = originX - 1; x >= 0; x--) process(x, y);
      }
      for (let y = originY - 1; y >= 0; y--) {
        for (let x = originX; x < WIDTH; x++) process(x, y);
        for (let x = originX - 1; x >= 0; x--) process(x, y);
      }
    }

    renderIFSAndShoes(time) {
      this.ifsEffect.render(ctx, time);
      this.lateTransitions.compositePersistent(ctx);
    }

    renderPrecalcTwo(time) {
      // The reference capture exposes the first decoded frame before the
      // nominal callback PTS; use its measured presentation anchor.
      const local = Math.max(0, time - PRECALC_TWO_START);
      this.video2.draw(ctx, local * 30);
      this.lateTransitions.compositePersistent(ctx);
    }

    renderArtwork(time) {
      if (time <= BLOB_BLACK_VISUAL) {
        // x8 stays linked while the live-framebuffer->x44 object fades over
        // it. Both remain below the persistent black endpoint layer.
        this.video2.draw(ctx,
          Math.max(0, time - PRECALC_TWO_START) * 30);
        this.lateTransitions.crossfadeLive(ctx, 'x44', time, X44_VISUAL, .7);
        this.lateTransitions.compositePersistent(ctx);
        return;
      }

      // At order 37 row 0, x8/x44 are removed and the black layer is held at
      // state zero. Row 4 repeats the white state-one, direction-minus reset.
      const cue = time >= BLOB_WHITE_REPEAT_VISUAL
        ? BLOB_WHITE_REPEAT_VISUAL
        : BLOB_BLACK_VISUAL;
      const whiteState = clamp(1 - (time - cue) / .5);
      this.lateTransitions.compositePersistent(ctx, {
        blackState: 0,
        whiteState
      });
    }

    renderMorph(time) {
      this.drawImage('x41');
      this.blob.render(ctx, time);
      this.lateTransitions.crossfadeLive(ctx, 'x46', time, TO_46_B_VISUAL, 2);
      // Row 8 links x41/blob and restarts white.  Order 41 resets white once
      // more in the same callback that switches the blob's source material.
      const whiteCue = time >= BLOB_SWAP_VISUAL
        ? BLOB_SWAP_VISUAL
        : BLOB_VISUAL;
      this.lateTransitions.compositePersistent(ctx, {
        whiteState: clamp(1 - (time - whiteCue) / .5)
      });
    }

    renderGalaxy(time) {
      this.drawImage('x46');
      this.particleEffects.renderGalaxy(ctx, time);
      this.lateTransitions.compositePersistent(ctx, {
        noiseTime: time >= FINALE_NOISE_VISUAL ? time : null
      });
    }

    renderFinale(time) {
      if (time < CREDITS_BACKGROUND_VISUAL) {
        this.warp28.render(ctx, time, true);
      } else {
        this.creditsBackground.render(ctx, time);
      }
      this.creditsForeground.render(ctx, time);
      this.lateTransitions.compositePersistent(ctx, { noiseTime: time });
    }
  }

  const demo = new Demo();

  let wakeLock = null;
  let wakeLockRequest = null;
  let wakeLockGeneration = 0;

  const acquireWakeLock = async () => {
    if (wakeLock || wakeLockRequest || !('wakeLock' in navigator) ||
        document.visibilityState !== 'visible') return;
    const token = { generation: wakeLockGeneration };
    wakeLockRequest = token;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (wakeLockRequest === token) wakeLockRequest = null;
      if (token.generation !== wakeLockGeneration || !demo.running ||
          document.visibilityState !== 'visible') {
        await lock.release().catch(() => {});
        return;
      }
      wakeLock = lock;
      lock.addEventListener('release', () => {
        if (wakeLock === lock) wakeLock = null;
      }, { once: true });
    } catch {
      if (wakeLockRequest === token) wakeLockRequest = null;
      // Playback remains fully functional when wake locks are unavailable.
    }
  };

  const releaseWakeLock = () => {
    wakeLockGeneration++;
    wakeLockRequest = null;
    const lock = wakeLock;
    wakeLock = null;
    if (lock) void lock.release().catch(() => {});
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen?.();
    } catch {
      // Fullscreen can be denied by the browser or the embedding document.
    }
  };

  let flashTimer = 0;

  const clearFlash = () => {
    clearTimeout(flashTimer);
    flashTimer = 0;
  };

  const flashStatus = text => {
    status.textContent = text;
    clearFlash();
    flashTimer = setTimeout(() => {
      if (status.textContent === text) status.textContent = '';
      flashTimer = 0;
    }, 1200);
  };

  const mmss = time => {
    const seconds = Math.max(0, Math.round(time));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  const presentStartError = error => {
    clearFlash();
    demo.stop(true);
    gate.classList.add('gate--error');
    startButton.textContent = 'RETRY';
    status.textContent = error.message;
  };

  startButton.addEventListener('click', async () => {
    clearFlash();
    startButton.disabled = true;
    gate.classList.remove('gate--error');
    gate.classList.add('gate--hidden');
    try {
      await demo.start();
    } catch (error) {
      console.error(error);
      presentStartError(error);
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      clearFlash();
      demo.stop();
      return;
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
        (demo.running || demo.controlSeekTarget !== null)) {
      event.preventDefault();
      const forward = event.key === 'ArrowRight';
      const request = demo.seekBy(forward ? 5 : -5);
      if (request) {
        flashStatus(`${forward ? '▶' : '◀'} ${mmss(request.target)}`);
        request.transition.catch(error => {
          console.error(error);
          presentStartError(error);
        });
      }
      return;
    }
    if (event.key === ' ' &&
        !demo.running && !demo.starting && !startButton.disabled) {
      event.preventDefault();
      startButton.click();
      return;
    }
    if (event.key === ' ' && (demo.running || demo.starting)) {
      event.preventDefault();
      if (demo.running && !demo.starting) {
        demo.togglePause().catch(error => {
          console.error(error);
          presentStartError(error);
        });
      }
      return;
    }
    if (event.key === 'f' && document.fullscreenEnabled) {
      void toggleFullscreen();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseWakeLock();
    else if (demo.running) void acquireWakeLock();
  });

  demo.load().catch(error => {
    console.error(error);
    void demo.discardFailedLoad();
    canvas.classList.remove('screen--visible');
    gate.classList.remove('gate--hidden');
    gate.classList.add('gate--error');
    startButton.disabled = true;
    startButton.textContent = 'LOAD FAILED';
    status.textContent = error.message;
    status.setAttribute('aria-busy', 'false');
  });
})();
