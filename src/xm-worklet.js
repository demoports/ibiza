/*
 * Minimal FastTracker II replayer for Nonstop Ibiza's atbia3.xm.
 *
 * This deliberately lives in the AudioWorklet. Tracker ticks, row changes,
 * note triggers and the mixer therefore share one sample-frame clock.  It is
 * plain JavaScript: there is no WASM, bundler, decoder plug-in or media file.
 *
 * The implementation is specialized to the released atbia3.xm. It preserves
 * every pattern/sample feature used by that module:
 * linear frequencies, envelopes/fadeout, instrument auto-vibrato, forward and
 * ping-pong sample loops, sample-offset memory, note delay, pattern loops,
 * multi-retrigger, and effects 0/1/2/3/4/8/9/A/C/D/E/F/R.
 */

const XM_QUICK_RAMP_SECONDS = 0.005;
const BASS_PHASE_SCALE = 32768;
// BASS 0.8's XM trigger path writes 0x7ef4, rather than 0x7fff, into the
// channel fade accumulator. The difference survives the integer gain shifts.
const BASS_XM_FADEOUT_START = 0x7ef4;
// With the demo's 28-channel module and MusicSetAmplify(75), BASS derives a
// stereo output shift of 4 and a per-channel master multiplier of 27.
const BASS_MUSIC_MASTER = 27;
const BASS_MUSIC_OUTPUT_SHIFT = 4;
const BASS_MIXER_CHUNK_FRAMES = 689;
const BASS_INITIAL_MIX_FRAMES = 8820;
const BASS_STEADY_MIX_FRAMES = 4410;

// BASS 0.8 builds this table through an x87 calculation whose exponent is
// rounded to Float32 before 2^x is evaluated.  The resulting integer Hertz
// values, and the Q15 step derived from them below, are what its sample mixer
// actually consumes.
const BASS_LINEAR_FREQUENCY = Int32Array.from({ length: 768 }, (_, index) =>
  Math.trunc(8363 * Math.pow(2, Math.fround(index / 768 + 8)) + 0.5));

function bassLinearFrequency(period) {
  // BASS stores XM linear periods 1536 above FT2's conventional value.
  const internalPeriod = (Math.trunc(period) + 1536) | 0;
  const relative = (0x2400 - internalPeriod) >>> 0;
  const octave = Math.floor(relative / 0x300);
  const remainder = relative % 0x300;
  return BASS_LINEAR_FREQUENCY[remainder] >> ((12 - octave) & 31);
}

function bassStepQ15(frequency, outputRate) {
  const hz = frequency | 0;
  const rate = outputRate | 0;
  let scale = 0;
  if (hz >= 0x10000) {
    let bit = 16;
    do {
      scale++;
      bit++;
    } while (((1 << bit) | 0) <= hz);
  }
  const numerator = (hz << ((15 - scale) & 31)) | 0;
  return ((Math.trunc(numerator / rate) | 0) << (scale & 31)) | 0;
}

// Tables and phase conventions below are the ones used by FT2. Effect 4
// uses an unsigned 8-bit phase and a 32-entry, unsigned half-wave table.
const FT2_VIBRATO_TABLE = Object.freeze([
  0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253,
  255, 253, 250, 244, 235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
]);

// FT2 indexes this table with its countdown tick. Entries 16..31 are the
// original replay's adjacent-data overrun and matter only at unusual speeds.
const FT2_ARPEGGIO_TABLE = Object.freeze([
  0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0,
  0x00, 0x18, 0x31, 0x4a, 0x61, 0x78, 0x8d, 0xa1,
  0xb4, 0xc5, 0xd4, 0xe0, 0xeb, 0xf4, 0xfa, 0xfd,
]);

// The unsigned half-sine embedded in BASS 0.8. Instrument auto-vibrato
// multiplies this 0..256 table before applying the half-cycle sign; combining
// those operations into a smaller signed table changes integer rounding.
const BASS_AUTO_VIBRATO_HALF_SINE = Object.freeze([
  0, 6, 13, 19, 25, 31, 38, 44, 50, 56, 62, 68, 74, 80, 86, 92,
  98, 104, 109, 115, 121, 126, 132, 137, 142, 147, 152, 157, 162, 167, 172, 177,
  181, 185, 190, 194, 198, 202, 206, 209, 213, 216, 220, 223, 226, 229, 231, 234,
  237, 239, 241, 243, 245, 247, 248, 250, 251, 252, 253, 254, 255, 255, 256, 256,
  256, 256, 256, 255, 255, 254, 253, 252, 251, 250, 248, 247, 245, 243, 241, 239,
  237, 234, 231, 229, 226, 223, 220, 216, 213, 209, 206, 202, 198, 194, 190, 185,
  181, 177, 172, 167, 162, 157, 152, 147, 142, 137, 132, 126, 121, 115, 109, 104,
  98, 92, 86, 80, 74, 68, 62, 56, 50, 44, 38, 31, 25, 19, 13, 6,
]);

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function readXMString(view, offset, length) {
  let result = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    result += String.fromCharCode(c);
  }
  return result.trim();
}

function decodeDeltaSample(view, offset, byteLength, sixteenBit) {
  if (sixteenBit) {
    const length = byteLength >>> 1;
    const output = new Int16Array(length);
    let accumulator = 0;
    for (let i = 0; i < length; i++) {
      accumulator = (accumulator + view.getInt16(offset + i * 2, true)) << 16 >> 16;
      output[i] = accumulator;
    }
    return output;
  }

  const output = new Int16Array(byteLength);
  let accumulator = 0;
  for (let i = 0; i < byteLength; i++) {
    accumulator = (accumulator + view.getInt8(offset + i)) << 24 >> 24;
    output[i] = accumulator << 8;
  }
  return output;
}

function parseEnvelope(view, header, pointOffset, countOffset, typeOffset,
                       sustainOffset, loopStartOffset, loopEndOffset) {
  const count = Math.min(12, view.getUint8(header + countOffset));
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push({
      frame: view.getUint16(header + pointOffset + i * 4, true),
      value: view.getUint16(header + pointOffset + i * 4 + 2, true),
    });
  }
  return {
    points,
    type: view.getUint8(header + typeOffset),
    sustain: view.getUint8(header + sustainOffset),
    loopStart: view.getUint8(header + loopStartOffset),
    loopEnd: view.getUint8(header + loopEndOffset),
  };
}

function parseXM(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 336 || readXMString(view, 0, 17) !== 'Extended Module:') {
    throw new Error('Not a FastTracker II XM module');
  }

  const version = view.getUint16(58, true);
  const headerLength = view.getUint32(60, true);
  const songLength = view.getUint16(64, true);
  const restart = view.getUint16(66, true);
  const channels = view.getUint16(68, true);
  const patternCount = view.getUint16(70, true);
  const instrumentCount = view.getUint16(72, true);
  const flags = view.getUint16(74, true);
  const initialSpeed = view.getUint16(76, true);
  const initialBPM = view.getUint16(78, true);

  if (version !== 0x0104) throw new Error(`Unsupported XM version 0x${version.toString(16)}`);
  if (channels < 1 || channels > 64) throw new Error(`Unsupported XM channel count ${channels}`);
  if (songLength < 1 || songLength > 256) throw new Error(`Invalid XM order length ${songLength}`);
  if (!(flags & 1)) throw new Error('atbia3.xm requires linear frequencies');

  const orders = new Uint8Array(songLength);
  for (let i = 0; i < songLength; i++) orders[i] = view.getUint8(80 + i);

  let cursor = 60 + headerLength;
  const patterns = [];
  for (let patternIndex = 0; patternIndex < patternCount; patternIndex++) {
    const patternHeaderLength = view.getUint32(cursor, true);
    const rows = view.getUint16(cursor + 5, true);
    const packedLength = view.getUint16(cursor + 7, true);
    if (rows < 1 || rows > 256) throw new Error(`Invalid row count in pattern ${patternIndex}`);

    let packed = cursor + patternHeaderLength;
    const packedEnd = packed + packedLength;
    const cells = new Uint8Array(rows * channels * 5);
    if (packedLength) {
      for (let cell = 0; cell < rows * channels; cell++) {
        if (packed >= packedEnd) throw new Error(`Truncated pattern ${patternIndex}`);
        let note = 0, instrument = 0, volume = 0, effect = 0, param = 0;
        const first = view.getUint8(packed++);
        if (first & 0x80) {
          if (first & 0x01) note = view.getUint8(packed++);
          if (first & 0x02) instrument = view.getUint8(packed++);
          if (first & 0x04) volume = view.getUint8(packed++);
          if (first & 0x08) effect = view.getUint8(packed++);
          if (first & 0x10) param = view.getUint8(packed++);
        } else {
          note = first;
          instrument = view.getUint8(packed++);
          volume = view.getUint8(packed++);
          effect = view.getUint8(packed++);
          param = view.getUint8(packed++);
        }
        const output = cell * 5;
        cells[output] = note;
        cells[output + 1] = instrument;
        cells[output + 2] = volume;
        cells[output + 3] = effect;
        cells[output + 4] = param;
      }
    }
    patterns.push({ rows, cells });
    cursor += patternHeaderLength + packedLength;
  }

  const instruments = [];
  for (let instrumentIndex = 0; instrumentIndex < instrumentCount; instrumentIndex++) {
    if (cursor + 29 > view.byteLength) throw new Error(`Truncated instrument ${instrumentIndex + 1}`);
    const instrumentHeaderLength = view.getUint32(cursor, true);
    const sampleCount = view.getUint16(cursor + 27, true);
    const instrument = {
      volumeEnvelope: { points: [], type: 0, sustain: 0, loopStart: 0, loopEnd: 0 },
      panningEnvelope: { points: [], type: 0, sustain: 0, loopStart: 0, loopEnd: 0 },
      fadeout: 0,
      vibratoDepth: 0,
      vibratoRate: 0,
      samples: [],
    };

    if (!sampleCount) {
      cursor += instrumentHeaderLength;
      instruments.push(instrument);
      continue;
    }

    if (sampleCount !== 1) {
      throw new Error(`Unsupported sample count in instrument ${instrumentIndex + 1}`);
    }
    const sampleHeaderLength = view.getUint32(cursor + 29, true);
    instrument.volumeEnvelope = parseEnvelope(view, cursor, 129, 225, 233, 227, 228, 229);
    instrument.panningEnvelope = parseEnvelope(view, cursor, 177, 226, 234, 230, 231, 232);
    instrument.vibratoDepth = view.getUint8(cursor + 237);
    instrument.vibratoRate = view.getUint8(cursor + 238);
    instrument.fadeout = view.getUint16(cursor + 239, true);

    cursor += instrumentHeaderLength;
    const sampleHeaders = [];
    let totalSampleBytes = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
      const sampleHeader = cursor + sampleIndex * sampleHeaderLength;
      const byteLength = view.getUint32(sampleHeader, true);
      const loopStartBytes = view.getUint32(sampleHeader + 4, true);
      const loopLengthBytes = view.getUint32(sampleHeader + 8, true);
      const type = view.getUint8(sampleHeader + 14);
      const sixteenBit = !!(type & 0x10);
      const divisor = sixteenBit ? 2 : 1;
      sampleHeaders.push({
        byteLength,
        length: byteLength / divisor,
        loopStart: loopStartBytes / divisor,
        loopLength: loopLengthBytes / divisor,
        loopType: type & 0x03,
        sixteenBit,
        volume: view.getUint8(sampleHeader + 12),
        finetune: view.getInt8(sampleHeader + 13),
        panning: view.getUint8(sampleHeader + 15),
        relativeNote: view.getInt8(sampleHeader + 16),
        byteOffset: totalSampleBytes,
      });
      totalSampleBytes += byteLength;
    }

    const sampleDataStart = cursor + sampleCount * sampleHeaderLength;
    for (const sample of sampleHeaders) {
      const decoded = decodeDeltaSample(
        view,
        sampleDataStart + sample.byteOffset,
        sample.byteLength,
        sample.sixteenBit,
      );
      sample.loopEnd = sample.loopStart + sample.loopLength;
      if (!sample.loopLength || sample.loopEnd > sample.length || sample.loopType > 2) {
        sample.loopType = 0;
        sample.loopStart = 0;
        sample.loopLength = 0;
        sample.loopEnd = sample.length;
      }
      // BASS mixes signed 16-bit samples and reserves four suffix guards for
      // its four-wide MMX interpolator. Loop guards are synthesized from the
      // opposite endpoint; an unlooped sample keeps the zero-filled suffix.
      sample.mixEnd = sample.loopType ? sample.loopEnd : sample.length;
      sample.data = new Int16Array(sample.mixEnd + 4);
      sample.data.set(decoded.subarray(0, sample.mixEnd));
      if (sample.loopType === 1) {
        for (let guard = 0; guard < 4; guard++) {
          // Reading from the destination buffer also reproduces BASS's
          // cyclic result when a legal forward loop is shorter than 4.
          sample.data[sample.mixEnd + guard] = sample.data[sample.loopStart + guard];
        }
      } else if (sample.loopType === 2) {
        for (let guard = 0; guard < 4; guard++) {
          sample.data[sample.mixEnd + guard] = decoded[sample.mixEnd - 1 - guard];
        }
      }
      instrument.samples.push(sample);
    }
    cursor = sampleDataStart + totalSampleBytes;
    instruments.push(instrument);
  }

  return {
    channels,
    patterns,
    instruments,
    orders,
    restart: restart < songLength ? restart : 0,
    initialSpeed,
    initialBPM,
  };
}

function makeChannel() {
  return {
    selectedInstrument: null,
    instrument: null,
    sample: null,
    note: 0,
    period: 0,
    targetPeriod: 0,
    step: 0,
    samplePosition: -1,
    sampleDirection: 1,
    active: false,
    volume: 64,
    panning: 128,
    keyOn: true,
    fadeout: BASS_XM_FADEOUT_START,
    volumeEnvelopePosition: 0,
    panningEnvelopePosition: 0,
    envelopeVolume: 64,
    envelopePanning: 32,
    autoVibratoPosition: 0,
    autoVibratoOffset: 0,
    arpeggioOffset: 0,
    vibratoOffset: 0,
    vibratoPosition: 0,
    vibratoSpeed: 0,
    vibratoDepth: 0,
    slideUp: 0,
    slideDown: 0,
    tonePortamento: 0,
    volumeSlide: 0,
    sampleOffset: 0,
    retrigger: 0,
    retriggerCounter: 0,
    loopStart: 0,
    loopCount: 0,
    noteDelay: -1,
    event: null,
    gainLeft: 0,
    gainRight: 0,
    targetGainLeft: 0,
    targetGainRight: 0,
    gainRampRemaining: 0,
    gainDeltaLeft: 0,
    gainDeltaRight: 0,
    quickRampPending: false,
    voiceTriggerPending: false,
    triggerSnapshot: null,
    mixMmxRemaining: 0,
    mixScalarRemaining: 0,
    mixedLeft: 0,
    mixedRight: 0,
    tail: null,
  };
}

function cloneVoiceState(voice) {
  return voice ? { ...voice } : null;
}

function cloneChannelState(channel) {
  return {
    ...channel,
    event: channel.event ? { ...channel.event } : null,
    triggerSnapshot: cloneVoiceState(channel.triggerSnapshot),
    tail: cloneVoiceState(channel.tail),
  };
}

function envelopeValue(envelope, position, fallback) {
  const points = envelope.points;
  if (!(envelope.type & 1) || !points.length) return fallback;
  if (position <= points[0].frame) return points[0].value;
  for (let i = 1; i < points.length; i++) {
    if (position <= points[i].frame) {
      const left = points[i - 1];
      const right = points[i];
      const width = right.frame - left.frame;
      if (!width) return right.value;
      // BASS 0.8 interpolates XM envelopes as signed 16.16 integers.  Its
      // division truncates toward zero and the mixer consumes the integer
      // part, so retaining a floating-point fraction here changes panning and
      // volume on almost every sloped envelope tick.
      const step = Math.trunc(((right.value - left.value) * 65536) / width);
      return (left.value * 65536 + step * (position - left.frame)) >> 16;
    }
  }
  return points[points.length - 1].value;
}

function advanceEnvelope(envelope, position, keyOn) {
  const points = envelope.points;
  if (!(envelope.type & 1) || !points.length) return position;
  if (keyOn && (envelope.type & 2) && envelope.sustain < points.length &&
      position === points[envelope.sustain].frame) {
    return position;
  }
  return position + 1;
}

class XMReplayEngine {
  constructor(module, outputRate) {
    this.module = module;
    this.outputRate = outputRate;
    this.quickRampSamples = Math.max(1, Math.floor(outputRate * XM_QUICK_RAMP_SECONDS));
    this.playing = false;
    this.reset();
  }

  reset() {
    this.speed = this.module.initialSpeed;
    this.bpm = this.module.initialBPM;
    this.order = 0;
    this.row = 0;
    this.tick = 0;
    this.generatedFrames = 0;
    this.samplesUntilTick = 0;
    this.samplesUntilMixerChunk = 0;
    this.samplesUntilOuterMix = BASS_INITIAL_MIX_FRAMES;
    this.pendingPosition = null;
    this.patternEndRow = 0;
    this.channels = Array.from({ length: this.module.channels }, () => makeChannel());
  }

  captureState() {
    return {
      speed: this.speed,
      bpm: this.bpm,
      order: this.order,
      row: this.row,
      tick: this.tick,
      generatedFrames: this.generatedFrames,
      samplesUntilTick: this.samplesUntilTick,
      samplesUntilMixerChunk: this.samplesUntilMixerChunk,
      samplesUntilOuterMix: this.samplesUntilOuterMix,
      pendingPosition: this.pendingPosition ? { ...this.pendingPosition } : null,
      patternEndRow: this.patternEndRow,
      channels: this.channels.map(cloneChannelState),
    };
  }

  restoreState(state) {
    this.speed = state.speed;
    this.bpm = state.bpm;
    this.order = state.order;
    this.row = state.row;
    this.tick = state.tick;
    this.generatedFrames = state.generatedFrames;
    this.samplesUntilTick = state.samplesUntilTick;
    this.samplesUntilMixerChunk = state.samplesUntilMixerChunk;
    this.samplesUntilOuterMix = state.samplesUntilOuterMix;
    this.pendingPosition = state.pendingPosition ? { ...state.pendingPosition } : null;
    this.patternEndRow = state.patternEndRow;
    this.channels = state.channels.map(cloneChannelState);
  }

  normalizePosition() {
    if (this.order < this.module.orders.length) return;
    this.order = this.module.restart;
    this.row = 0;
  }

  patternAtCurrentOrder() {
    const patternNumber = this.module.orders[this.order];
    return this.module.patterns[patternNumber];
  }

  readEvent(pattern, row, channel) {
    const offset = (row * this.module.channels + channel) * 5;
    return {
      note: pattern.cells[offset],
      instrument: pattern.cells[offset + 1],
      volume: pattern.cells[offset + 2],
      effect: pattern.cells[offset + 3],
      param: pattern.cells[offset + 4],
    };
  }

  periodFor(note, sample) {
    const noteValue = (note - 1) + sample.relativeNote;
    // BASS retains every signed XM finetune bit.  Its loader biases the byte
    // by 128 and the trigger later takes an arithmetic half; after removing
    // BASS's internal +1536 period bias this is the exact conventional value.
    return 7680 - noteValue * 64 - (sample.finetune >> 1);
  }

  frequencyFor(channel) {
    const effectivePeriod = channel.period - 64 * channel.arpeggioOffset +
      channel.vibratoOffset + channel.autoVibratoOffset;
    return bassLinearFrequency(effectivePeriod);
  }

  selectSample(instrument, note) {
    if (!instrument || !instrument.samples.length || note < 1 || note > 96) return null;
    return instrument.samples[0];
  }

  snapshotVoice(channel) {
    if (!channel.active || !channel.sample || channel.samplePosition < 0 ||
        (channel.gainLeft === 0 && channel.gainRight === 0)) return null;
    return {
      sample: channel.sample,
      position: channel.samplePosition,
      direction: channel.sampleDirection,
      step: channel.step,
      gainLeft: channel.gainLeft,
      gainRight: channel.gainRight,
      gainDeltaLeft: Math.trunc(-channel.gainLeft / this.quickRampSamples),
      gainDeltaRight: Math.trunc(-channel.gainRight / this.quickRampSamples),
      remaining: this.quickRampSamples,
      mixMmxRemaining: 0,
      mixScalarRemaining: 0,
    };
  }

  queueVoiceTrigger(channel) {
    // Several FT2 commands can trigger the same channel during one tracker
    // tick. The mixer sees one trigger flag at the end of that tick, so retain
    // the voice that existed before the first command as the ramp-out voice.
    if (!channel.voiceTriggerPending) channel.triggerSnapshot = this.snapshotVoice(channel);
    channel.voiceTriggerPending = true;
  }

  resetInstrumentState(channel) {
    channel.keyOn = true;
    channel.fadeout = BASS_XM_FADEOUT_START;
    channel.volumeEnvelopePosition = 0;
    channel.panningEnvelopePosition = 0;
    channel.retriggerCounter = 0;
    channel.autoVibratoPosition = 0;
    channel.autoVibratoOffset = 0;

    channel.vibratoPosition = 0;
  }

  trigger(channel, options = {}) {
    const {
      keepVolume = false,
      keepPanning = false,
      keepPeriod = false,
      keepPosition = false,
      keepEnvelope = false,
    } = options;

    if (!keepPosition) {
      this.queueVoiceTrigger(channel);
      channel.samplePosition = 0;
      channel.sampleDirection = 1;
      channel.mixMmxRemaining = 0;
      channel.mixScalarRemaining = 0;
      channel.active = !!channel.sample;
    }
    if (channel.sample) {
      if (!keepVolume) channel.volume = channel.sample.volume;
      if (!keepPanning) channel.panning = channel.sample.panning;
    }
    if (!keepEnvelope) this.resetInstrumentState(channel);
    if (!keepPeriod && channel.sample && channel.note) {
      channel.period = this.periodFor(channel.note, channel.sample);
      // triggerNote() writes both FT2's real and output period.
      channel.vibratoOffset = 0;
    }
    channel.quickRampPending = true;
  }

  keyOff(channel) {
    channel.keyOn = false;
    if (!channel.instrument || !(channel.instrument.volumeEnvelope.type & 1)) {
      channel.volume = 0;
      channel.quickRampPending = true;
    }
  }

  handleNoteAndInstrument(channel, event) {
    const tonePortamento = event.effect === 3;

    if (event.instrument) {
      channel.selectedInstrument = this.module.instruments[event.instrument - 1] || null;
    }

    if (tonePortamento) {
      if (event.instrument && channel.instrument) {
        // FT2 changes the selected instrument number, but an instrument on a
        // portamento row resets the current instrument state and sample
        // defaults without changing pitch or sample position.
        this.trigger(channel, { keepPeriod: true, keepPosition: true });
      }
      if (event.note > 0 && event.note < 97 && channel.sample) {
        channel.targetPeriod = this.periodFor(event.note, channel.sample);
      }
      return;
    }

    if (event.note > 0 && event.note < 97) {
      const instrument = channel.selectedInstrument || channel.instrument;
      const sample = this.selectSample(instrument, event.note);
      channel.instrument = instrument;
      // Capture the outgoing voice before replacing its sample pointer. The
      // ramp tail must continue the old sample, not reinterpret the old
      // position/direction through the newly selected sample.
      this.queueVoiceTrigger(channel);
      channel.sample = sample;
      channel.note = event.note;
      this.trigger(channel);
    } else if (event.note === 97) {
      this.keyOff(channel);
    }
  }

  handleVolumeColumn(channel, volume, tickZero) {
    if (!volume) return 0;
    const command = volume >> 4;
    const value = volume & 0x0f;
    if (tickZero) {
      if (volume >= 0x10 && volume <= 0x50) {
        channel.volume = volume - 0x10;
        channel.quickRampPending = true;
        return channel.volume;
      }
      if (command === 0x0c) {
        channel.panning = value << 4;
        return channel.panning;
      }
      return volume;
    }
    if (command === 0x06) channel.volume = clamp(channel.volume - value, 0, 64);
    else if (command === 0x07) channel.volume = clamp(channel.volume + value, 0, 64);
    return volume;
  }

  applyVolumeSlide(channel) {
    const up = channel.volumeSlide >> 4;
    const down = channel.volumeSlide & 0x0f;
    channel.volume = clamp(channel.volume + up - down, 0, 64);
  }

  applyTonePortamento(channel) {
    if (!channel.targetPeriod || !channel.tonePortamento) return;
    const amount = channel.tonePortamento * 4;
    if (channel.period < channel.targetPeriod) {
      channel.period = Math.min(channel.targetPeriod, channel.period + amount);
    } else if (channel.period > channel.targetPeriod) {
      channel.period = Math.max(channel.targetPeriod, channel.period - amount);
    }
  }

  applyVibrato(channel) {
    const phase = channel.vibratoPosition & 0xff;
    const index = (phase >> 2) & 31;
    let wave = FT2_VIBRATO_TABLE[index];
    // XMPlay performs the sign change before its arithmetic shift.  On the
    // negative half-cycle that is observably different from shifting the
    // magnitude and then negating it: discarded low bits round toward -inf.
    if (phase & 0x80) wave = -wave;
    channel.vibratoOffset = (wave * channel.vibratoDepth) >> 5;
    channel.vibratoPosition = (phase + channel.vibratoSpeed * 4) & 0xff;
  }

  handleExtendedTickZero(channel, param) {
    const command = param >> 4;
    const value = param & 0x0f;
    switch (command) {
      case 0x06:
        if (!value) {
          channel.loopStart = this.row;
          this.patternEndRow = this.row; // FT2's E60-at-pattern-end quirk.
        } else if (channel.loopCount === value) {
          channel.loopCount = 0;
        } else {
          channel.loopCount++;
          this.pendingPosition = { order: this.order, row: channel.loopStart };
        }
        break;
      case 0x0a:
        channel.volume = clamp(channel.volume + value, 0, 64);
        break;
      case 0x0b:
        channel.volume = clamp(channel.volume - value, 0, 64);
        break;
      // ED1 is handled at its delayed tick.
    }
  }

  handleImmediateEffect(channel, event, volumeColumnResult = event.volume) {
    const value = event.param;
    switch (event.effect) {
      case 0x01: if (value) channel.slideUp = value; break;
      case 0x02: if (value) channel.slideDown = value; break;
      case 0x03: if (value) channel.tonePortamento = value; break;
      case 0x04:
        if (value >> 4) channel.vibratoSpeed = value >> 4;
        if (value & 0x0f) channel.vibratoDepth = value & 0x0f;
        break;
      case 0x0a:
        if (value) channel.volumeSlide = value;
        break;
      case 0x08: channel.panning = value; break;
      case 0x09:
        if (value) channel.sampleOffset = value;
        if (channel.sample && event.note > 0 && event.note < 97) {
          // 9xx is measured in 256 decoded sample frames in FT2. The XM file
          // stores 16-bit lengths in bytes, but parseXM has already converted
          // them to frames, so the multiplier is identical for 8/16-bit data.
          channel.samplePosition = channel.sampleOffset * 256;
          channel.sampleDirection = 1;
          channel.mixMmxRemaining = 0;
          channel.mixScalarRemaining = 0;
          // BASS validates 9xx against the complete decoded sample.  A valid
          // offset beyond a loop endpoint is folded into that loop by the
          // voice driver before its first fetch.
          if (channel.samplePosition >= channel.sample.length) {
            channel.active = false;
            channel.samplePosition = -1;
          }
        }
        break;
      case 0x0c:
        channel.volume = Math.min(64, value);
        channel.quickRampPending = true;
        break;
      case 0x0d:
        this.pendingPosition = {
          order: this.order + 1,
          row: 0,
        };
        break;
      case 0x0e: this.handleExtendedTickZero(channel, value); break;
      case 0x0f:
        if (value > 0 && value <= 0x1f) this.speed = value;
        else if (value >= 0x20) this.bpm = value;
        break;
      case 0x1b:
        channel.retrigger = value;
        // FT2 advances Rxy on tick zero only when the transformed volume
        // column value is zero (including no volume command, C0 and 10).
        if (volumeColumnResult === 0) this.processRetrigger(channel);
        break;
    }
  }

  processEvent(channel, event) {
    this.handleNoteAndInstrument(channel, event);
    const volumeColumnResult = this.handleVolumeColumn(channel, event.volume, true);
    this.handleImmediateEffect(channel, event, volumeColumnResult);
  }

  processRow() {
    this.normalizePosition();
    const patternNumber = this.module.orders[this.order];
    const pattern = this.module.patterns[patternNumber];
    if (this.row >= pattern.rows) this.row = 0;
    this.pendingPosition = null;

    for (let i = 0; i < this.channels.length; i++) {
      const channel = this.channels[i];
      const event = this.readEvent(pattern, this.row, i);
      channel.event = event;
      channel.arpeggioOffset = 0;
      if (event.effect !== 4) {
        channel.vibratoOffset = 0;
      }
      if (event.effect === 0x0e && (event.param >> 4) === 0x0d && (event.param & 0x0f)) {
        // FT2 updates the selected instrument number on tick zero, but defers
        // the note/sample and instrument-state trigger for ED1.
        if (event.instrument) {
          channel.selectedInstrument = this.module.instruments[event.instrument - 1] || null;
        }
        channel.noteDelay = event.param & 0x0f;
      } else {
        channel.noteDelay = -1;
        this.processEvent(channel, event);
      }
    }
    this.finishTrackerTick();
  }

  processRetrigger(channel) {
    const interval = channel.retrigger;
    channel.retriggerCounter++;
    if (channel.retriggerCounter < interval) return false;
    channel.retriggerCounter = 0;

    if (channel.event.volume >= 0x10 && channel.event.volume <= 0x50) {
      channel.volume = channel.event.volume - 0x10;
    }

    const instrument = channel.selectedInstrument || channel.instrument;
    const sample = this.selectSample(instrument, channel.note);
    this.queueVoiceTrigger(channel);
    channel.instrument = instrument;
    channel.sample = sample;
    this.trigger(channel, {
      keepVolume: true,
      keepPanning: true,
      keepEnvelope: true,
    });
    return true;
  }

  processDelayedEvent(channel, event) {
    const instrument = channel.selectedInstrument;
    const sample = this.selectSample(instrument, event.note);
    this.queueVoiceTrigger(channel);
    channel.instrument = instrument;
    channel.sample = sample;
    channel.note = event.note;
    this.trigger(channel);

    // Tick-zero volume processing is skipped for ED1. FT2 explicitly
    // applies the fixed volume after the delayed trigger.
    channel.volume = event.volume - 0x10;
  }

  processNonzeroTick() {
    for (const channel of this.channels) {
      const event = channel.event;
      channel.arpeggioOffset = 0;

      if (channel.noteDelay === this.tick) {
        this.processDelayedEvent(channel, event);
        channel.noteDelay = -1;
      } else {
        this.handleVolumeColumn(channel, event.volume, false);
      }

      switch (event.effect) {
        case 0x00:
          if (event.param) {
            // FT2 indexes the arpeggio from its per-row tick countdown, so
            // speeds divisible by three start high/low rather than low/high.
            const phase = FT2_ARPEGGIO_TABLE[(this.speed - this.tick) & 31];
            if (phase === 1) channel.arpeggioOffset = event.param >> 4;
            else if (phase !== 0) channel.arpeggioOffset = event.param & 0x0f;
          }
          break;
        case 0x01: channel.period = Math.max(0, channel.period - channel.slideUp * 4); break;
        case 0x02: channel.period += channel.slideDown * 4; break;
        case 0x03: this.applyTonePortamento(channel); break;
        case 0x04: this.applyVibrato(channel); break;
        case 0x0a: this.applyVolumeSlide(channel); break;
        case 0x1b: {
          this.processRetrigger(channel);
          break;
        }
      }
    }
    this.finishTrackerTick();
  }

  tickEnvelope(channel, envelope, positionProperty, valueProperty, fallback) {
    const envelopeObject = channel.instrument ? channel.instrument[envelope] : null;
    if (!envelopeObject) {
      channel[valueProperty] = fallback;
      return;
    }
    let position = channel[positionProperty];
    if ((envelopeObject.type & 4) && envelopeObject.points.length &&
        envelopeObject.loopStart < envelopeObject.points.length &&
        envelopeObject.loopEnd < envelopeObject.points.length) {
      const start = envelopeObject.points[envelopeObject.loopStart].frame;
      const end = envelopeObject.points[envelopeObject.loopEnd].frame;
      if (end > start && position >= end) position -= end - start;
    }
    channel[valueProperty] = envelopeValue(envelopeObject, position, fallback);
    channel[positionProperty] = advanceEnvelope(envelopeObject, position, channel.keyOn);
  }

  finishTrackerTick() {
    for (const channel of this.channels) {
      if (!channel.instrument) continue;
      this.tickEnvelope(channel, 'volumeEnvelope', 'volumeEnvelopePosition', 'envelopeVolume', 64);
      this.tickEnvelope(channel, 'panningEnvelope', 'panningEnvelopePosition', 'envelopePanning', 32);

      if (!channel.keyOn && (channel.instrument.volumeEnvelope.type & 1)) {
        channel.fadeout = Math.max(0, channel.fadeout - channel.instrument.fadeout);
      }

      const instrument = channel.instrument;
      if (instrument.vibratoDepth && instrument.vibratoRate) {
        channel.autoVibratoPosition =
          (channel.autoVibratoPosition + instrument.vibratoRate) & 0xff;
        const wave = BASS_AUTO_VIBRATO_HALF_SINE[
          channel.autoVibratoPosition & 0x7f];
        let offset = (instrument.vibratoDepth * wave) >> 8;
        if (!(channel.autoVibratoPosition & 0x80)) offset = -offset;
        channel.autoVibratoOffset = offset;
      } else {
        channel.autoVibratoOffset = 0;
      }

      if (channel.sample && channel.active) {
        channel.step = bassStepQ15(this.frequencyFor(channel), this.outputRate) / 32768;
      }
      this.updateTargetGains(channel);
    }
  }

  updateTargetGains(channel) {
    let targetLeft = 0;
    let targetRight = 0;
    if (!channel.active || !channel.sample || channel.fadeout <= 0) {
      targetLeft = 0;
      targetRight = 0;
    } else {
      let volume = Math.imul(channel.volume * 64, channel.fadeout) >> 13;
      volume = Math.imul(volume, channel.envelopeVolume) >> 6;
      const panDistance = 128 - Math.abs(channel.panning - 128);
      const panAdd = Math.imul(channel.envelopePanning - 32, panDistance) >> 5;
      const finalPan = clamp(channel.panning + panAdd, 0, 255);
      // The executable leaves BASS 0.8 at PanSep=50. Its generated lookup is
      // therefore the exact identity table 0..255 used by this linear formula.
      targetLeft = Math.imul(Math.imul(255 - finalPan, BASS_MUSIC_MASTER), volume);
      targetRight = Math.imul(Math.imul(finalPan, BASS_MUSIC_MASTER), volume);
    }

    channel.targetGainLeft = targetLeft;
    channel.targetGainRight = targetRight;

    if (channel.voiceTriggerPending) {
      if (channel.triggerSnapshot) channel.tail = channel.triggerSnapshot;
      channel.triggerSnapshot = null;
      channel.voiceTriggerPending = false;
      channel.gainLeft = 0;
      channel.gainRight = 0;
      this.scheduleGainRamp(channel, this.quickRampSamples);
    } else if (channel.active && channel.sample) {
      // The native target builder runs on every active tracker tick. Integer
      // division leaves a small endpoint remainder, which is deliberately
      // retained and becomes the next tick's ramp origin.
      const length = channel.quickRampPending
        ? this.quickRampSamples
        : this.tickSamples();
      this.scheduleGainRamp(channel, length);
    }
    channel.quickRampPending = false;
  }

  scheduleGainRamp(channel, length) {
    channel.gainDeltaLeft = Math.trunc((channel.targetGainLeft - channel.gainLeft) / length);
    channel.gainDeltaRight = Math.trunc((channel.targetGainRight - channel.gainRight) / length);
    channel.gainRampRemaining = channel.gainDeltaLeft || channel.gainDeltaRight ? length : 0;
  }

  advanceGainRamp(channel, frames) {
    if (channel.gainRampRemaining <= 0 || frames <= 0) return;
    const count = Math.min(frames, channel.gainRampRemaining);
    channel.gainLeft = (channel.gainLeft + Math.imul(channel.gainDeltaLeft, count)) | 0;
    channel.gainRight = (channel.gainRight + Math.imul(channel.gainDeltaRight, count)) | 0;
    channel.gainRampRemaining -= count;
    if (channel.gainRampRemaining <= 0) {
      channel.gainDeltaLeft = 0;
      channel.gainDeltaRight = 0;
    }
  }

  advanceRow() {
    if (this.pendingPosition) {
      this.order = this.pendingPosition.order;
      this.row = this.pendingPosition.row;
      this.pendingPosition = null;
      // libxm/FT2 clear the E60 scratch jump row whenever an explicit
      // loop/break position is consumed. Without this, a completed E6 loop
      // can incorrectly make the following pattern start halfway through.
      this.patternEndRow = 0;
      return;
    }
    const pattern = this.patternAtCurrentOrder();
    this.row++;
    if (this.row >= pattern.rows) {
      this.order++;
      this.row = this.patternEndRow;
      this.patternEndRow = 0;
    }
  }

  processTrackerTick() {
    if (this.tick === 0) {
      this.processRow();
    } else {
      this.processNonzeroTick();
    }

    this.tick++;
    if (this.tick >= this.speed) {
      this.tick = 0;
      this.advanceRow();
    }
  }

  tickSamples() {
    // BASS/XMPlay truncates every tick independently. Do not retain the
    // fractional half-sample at 44.1 kHz/100 BPM: carrying it into the next
    // tick delays order 1 by 462 samples and then shifts every later trigger.
    return Math.max(1, Math.floor(this.outputRate * 2.5 / this.bpm));
  }

  prepareMixerSpan() {
    if (this.samplesUntilTick <= 0) {
      this.processTrackerTick();
      this.samplesUntilTick += this.tickSamples();
    }
    if (this.samplesUntilOuterMix <= 0) {
      // The native periodic fill is driven by a 100 ms multimedia timer. Its
      // real cursor deltas jitter with Windows scheduling; 4410 is the exact
      // intended cadence at 44.1 kHz and gives the browser a canonical run.
      this.samplesUntilOuterMix = BASS_STEADY_MIX_FRAMES;
    }
    if (this.samplesUntilMixerChunk <= 0) {
      this.samplesUntilMixerChunk = Math.min(
        this.samplesUntilTick,
        this.samplesUntilOuterMix,
        BASS_MIXER_CHUNK_FRAMES,
      );
    }
  }

  consumeVoiceFrames(voice, frames, maximumFrames, gainRemaining,
                     positionKey = 'position', directionKey = 'direction') {
    let remaining = frames;
    let mixerRemaining = maximumFrames;
    let rampRemaining = gainRemaining;
    while (remaining > 0) {
      if (!this.prepareVoiceChunk(voice, mixerRemaining, rampRemaining,
        positionKey, directionKey)) break;
      const available = voice.mixMmxRemaining + voice.mixScalarRemaining;
      const count = Math.min(remaining, available);
      voice[positionKey] += voice.step * voice[directionKey] * count;
      const mmx = Math.min(count, voice.mixMmxRemaining);
      voice.mixMmxRemaining -= mmx;
      voice.mixScalarRemaining -= count - mmx;
      remaining -= count;
      mixerRemaining -= count;
      if (rampRemaining > 0) rampRemaining = Math.max(0, rampRemaining - count);
    }
    return frames - remaining;
  }

  advanceMixedState(frames, maximumFrames) {
    for (const channel of this.channels) {
      if (channel.active && channel.sample && channel.samplePosition >= 0) {
        this.consumeVoiceFrames(channel, frames, maximumFrames,
          channel.gainRampRemaining, 'samplePosition', 'sampleDirection');
        if (channel.samplePosition < 0) {
          channel.active = false;
          channel.targetGainLeft = 0;
          channel.targetGainRight = 0;
        }
      }
      this.advanceGainRamp(channel, frames);
      if (channel.tail) {
        const tailFrames = Math.min(frames, channel.tail.remaining);
        this.consumeVoiceFrames(channel.tail, tailFrames, maximumFrames,
          channel.tail.remaining);
        channel.tail.gainLeft = (channel.tail.gainLeft +
          Math.imul(channel.tail.gainDeltaLeft, tailFrames)) | 0;
        channel.tail.gainRight = (channel.tail.gainRight +
          Math.imul(channel.tail.gainDeltaRight, tailFrames)) | 0;
        channel.tail.remaining -= tailFrames;
        if (channel.tail.remaining <= 0 || channel.tail.position < 0) channel.tail = null;
      }
    }
  }

  fastForward(frames) {
    let remaining = Math.max(0, Math.floor(frames));
    while (remaining > 0) {
      this.prepareMixerSpan();
      const span = Math.min(remaining, Math.ceil(this.samplesUntilTick),
        this.samplesUntilMixerChunk);
      this.advanceMixedState(span, this.samplesUntilMixerChunk);
      this.samplesUntilTick -= span;
      this.samplesUntilMixerChunk -= span;
      this.samplesUntilOuterMix -= span;
      this.generatedFrames += span;
      remaining -= span;
    }

    // If the requested frame is exactly a tick edge, establish the state that
    // will produce that frame now rather than waiting for the next quantum.
    if (this.samplesUntilTick <= 0) {
      this.processTrackerTick();
      this.samplesUntilTick += this.tickSamples();
      this.samplesUntilMixerChunk = 0;
    }
  }

  normalizeVoiceBoundary(voice, positionKey, directionKey) {
    const sample = voice.sample;
    let position = voice[positionKey];
    let direction = voice[directionKey];
    if (!sample || position < 0) return false;

    // FUN_10014d30 checks the integer index only when a new native mixer
    // chunk begins. A chunk is therefore allowed to consume the synthesized
    // guard at index mixEnd before this normalization runs again.
    if (!sample.loopType) {
      if (Math.floor(position) >= sample.mixEnd) {
        voice[positionKey] = -1;
        return false;
      }
    } else if (sample.loopType === 1) {
      while (Math.floor(position) >= sample.mixEnd) position -= sample.loopLength;
    } else {
      while (true) {
        const index = Math.floor(position);
        if (direction > 0 && index >= sample.mixEnd) {
          position = 2 * sample.mixEnd - position - 1 / BASS_PHASE_SCALE;
          direction = -1;
        } else if (direction < 0 && index < sample.loopStart) {
          position = 2 * sample.loopStart - position - 1 / BASS_PHASE_SCALE;
          direction = 1;
        } else {
          break;
        }
      }
    }

    voice[positionKey] = position;
    voice[directionKey] = direction;
    return true;
  }

  framesToVoiceBoundary(voice, positionKey, directionKey) {
    const sample = voice.sample;
    const position = voice[positionKey];
    const direction = voice[directionKey];
    const stepQ15 = Math.round(voice.step * BASS_PHASE_SCALE);
    if (!sample || position < 0 || stepQ15 <= 0) return Number.MAX_SAFE_INTEGER;
    const index = Math.floor(position);
    const fraction = Math.round((position - index) * BASS_PHASE_SCALE);
    const distance = direction > 0
      ? (sample.mixEnd - index) * BASS_PHASE_SCALE - fraction
      : (index - sample.loopStart) * BASS_PHASE_SCALE + fraction;
    return Math.max(1, Math.trunc(distance / stepQ15) + 1);
  }

  prepareVoiceChunk(voice, maximumFrames, gainRemaining,
                    positionKey = 'position', directionKey = 'direction') {
    if (voice.mixMmxRemaining > 0 || voice.mixScalarRemaining > 0) return true;
    if (!this.normalizeVoiceBoundary(voice, positionKey, directionKey)) return false;
    let length = Math.max(1, Math.floor(maximumFrames));
    length = Math.min(length, this.framesToVoiceBoundary(voice, positionKey, directionKey));
    if (gainRemaining > 0) length = Math.min(length, gainRemaining);
    voice.mixMmxRemaining = length & ~3;
    voice.mixScalarRemaining = length & 3;
    return true;
  }

  interpolateVoice(voice, positionKey = 'position', directionKey = 'direction') {
    const sample = voice.sample;
    const position = voice[positionKey];
    const index = Math.floor(position);
    const fraction = Math.round((position - index) * BASS_PHASE_SCALE) & 0x7fff;
    const first = sample.data[index];
    const second = sample.data[index + 1];
    let value;
    if (voice.mixMmxRemaining > 0) {
      value = (Math.imul(first, 0x7fff - fraction) +
        Math.imul(second, fraction)) >> 15;
      voice.mixMmxRemaining--;
    } else {
      value = first + (Math.imul(second - first, fraction) >> 15);
      voice.mixScalarRemaining--;
    }
    voice[positionKey] = position + voice.step * voice[directionKey];
    return value;
  }

  sampleVoice(voice, maximumFrames) {
    if (!this.prepareVoiceChunk(voice, maximumFrames, voice.remaining)) return 0;
    return this.interpolateVoice(voice);
  }

  sampleChannelVoice(channel, maximumFrames) {
    if (!this.prepareVoiceChunk(channel, maximumFrames, channel.gainRampRemaining,
      'samplePosition', 'sampleDirection')) return 0;
    return this.interpolateVoice(channel, 'samplePosition', 'sampleDirection');
  }

  mixChannel(channel, maximumFrames) {
    let mixedLeft = 0;
    let mixedRight = 0;
    if (channel.active && channel.sample && channel.samplePosition >= 0) {
      const value = this.sampleChannelVoice(channel, maximumFrames);
      mixedLeft = Math.imul(value, channel.gainLeft >> 15);
      mixedRight = Math.imul(value, channel.gainRight >> 15);
      if (channel.samplePosition < 0) {
        channel.active = false;
        channel.targetGainLeft = 0;
        channel.targetGainRight = 0;
      }
    }

    if (channel.tail && channel.tail.remaining > 0) {
      const tailValue = this.sampleVoice(channel.tail, maximumFrames);
      mixedLeft = (mixedLeft + Math.imul(tailValue, channel.tail.gainLeft >> 15)) | 0;
      mixedRight = (mixedRight + Math.imul(tailValue, channel.tail.gainRight >> 15)) | 0;
      channel.tail.gainLeft = (channel.tail.gainLeft + channel.tail.gainDeltaLeft) | 0;
      channel.tail.gainRight = (channel.tail.gainRight + channel.tail.gainDeltaRight) | 0;
      channel.tail.remaining--;
      if (channel.tail.remaining <= 0 || channel.tail.position < 0) channel.tail = null;
    }
    this.advanceGainRamp(channel, 1);
    channel.mixedLeft = mixedLeft;
    channel.mixedRight = mixedRight;
  }

  render(left, right) {
    if (!this.playing) {
      left.fill(0);
      right.fill(0);
      return;
    }

    for (let frame = 0; frame < left.length; frame++) {
      this.prepareMixerSpan();

      let mixedLeft = 0;
      let mixedRight = 0;
      for (const channel of this.channels) {
        this.mixChannel(channel, this.samplesUntilMixerChunk);
        mixedLeft = (mixedLeft + channel.mixedLeft) | 0;
        mixedRight = (mixedRight + channel.mixedRight) | 0;
      }
      const leftPcm = clamp(mixedLeft >> (16 - BASS_MUSIC_OUTPUT_SHIFT), -32768, 32767);
      const rightPcm = clamp(mixedRight >> (16 - BASS_MUSIC_OUTPUT_SHIFT), -32768, 32767);
      left[frame] = leftPcm / 32768;
      right[frame] = rightPcm / 32768;
      this.samplesUntilTick--;
      this.samplesUntilMixerChunk--;
      this.samplesUntilOuterMix--;
      this.generatedFrames++;
    }
  }
}

// Seeking must not monopolize an AudioWorklet message callback: Chrome queues
// every missed render quantum and then advances AudioContext.currentTime while
// draining that backlog. Advance at most one second of source state per live
// quantum instead, emitting silence until the exact requested frame is ready.
const WORKLET_SEEK_FRAMES_PER_QUANTUM = 44100;
const SEEK_CHECKPOINT_SECONDS = 5;
// One full interval beyond the last recovered visual callback at 331.275 s.
const INITIAL_SEEK_CHECKPOINT_SECONDS = 335;
const MAX_ROLLING_SEEK_CHECKPOINTS = 64;

class XMWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = null;
    this.generation = 0;
    this.pendingSeek = null;
    this.pendingPlayAck = null;
    this.seekCheckpoints = [];
    this.fixedSeekCheckpointCount = 0;
    if (this.port) this.port.onmessage = event => this.onMessage(event.data);
  }

  clearPendingSeek() {
    this.pendingSeek = null;
  }

  saveSeekCheckpoint(fixed = false) {
    const state = this.engine.captureState();
    const last = this.seekCheckpoints[this.seekCheckpoints.length - 1];
    if (!last || state.generatedFrames > last.generatedFrames) {
      this.seekCheckpoints.push(state);
    }
    if (fixed) {
      this.fixedSeekCheckpointCount = this.seekCheckpoints.length;
      return;
    }
    while (this.seekCheckpoints.length >
        this.fixedSeekCheckpointCount + MAX_ROLLING_SEEK_CHECKPOINTS) {
      this.seekCheckpoints.splice(this.fixedSeekCheckpointCount, 1);
    }
  }

  buildInitialSeekCheckpoints() {
    this.seekCheckpoints = [this.engine.captureState()];
    this.fixedSeekCheckpointCount = 1;
    const checkpointFrames = Math.round(
      this.engine.outputRate * SEEK_CHECKPOINT_SECONDS);
    const targetFrame = Math.round(
      this.engine.outputRate * INITIAL_SEEK_CHECKPOINT_SECONDS);
    while (this.engine.generatedFrames < targetFrame) {
      this.engine.fastForward(Math.min(
        checkpointFrames, targetFrame - this.engine.generatedFrames));
      this.saveSeekCheckpoint(true);
    }
    this.engine.restoreState(this.seekCheckpoints[0]);
  }

  discardRollingCheckpointsAfter(targetFrame) {
    let length = this.seekCheckpoints.length;
    while (length > this.fixedSeekCheckpointCount &&
        this.seekCheckpoints[length - 1].generatedFrames > targetFrame) {
      length--;
    }
    this.seekCheckpoints.length = length;
  }

  checkpointForFrame(targetFrame) {
    let low = 0;
    let high = this.seekCheckpoints.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.seekCheckpoints[middle].generatedFrames <= targetFrame) low = middle;
      else high = middle - 1;
    }
    return this.seekCheckpoints[low];
  }

  extendSeekCheckpoints() {
    const last = this.seekCheckpoints[this.seekCheckpoints.length - 1];
    const interval = Math.round(this.engine.outputRate * SEEK_CHECKPOINT_SECONDS);
    if (this.engine.generatedFrames - last.generatedFrames >= interval) {
      this.saveSeekCheckpoint();
    }
  }

  onMessage(message) {
    try {
      switch (message.type) {
        case 'load': {
          this.generation = message.generation ?? (this.generation + 1);
          this.clearPendingSeek();
          this.pendingPlayAck = null;
          this.engine = null;
          const module = parseXM(message.buffer);
          this.engine = new XMReplayEngine(module, sampleRate);
          this.buildInitialSeekCheckpoints();
          this.port.postMessage({
            type: 'ready',
            generation: this.generation,
          });
          break;
        }
        case 'play':
          if (message.generation === this.generation && this.engine) {
            this.pendingPlayAck = { id: message.id, generation: this.generation };
            this.engine.playing = true;
          }
          break;
        case 'pause':
          if (message.generation === this.generation && this.engine) {
            this.pendingPlayAck = null;
            this.engine.playing = false;
            this.port.postMessage({
              type: 'paused',
              id: message.id,
              generation: this.generation,
              state: { time: this.engine.generatedFrames / this.engine.outputRate },
            });
          }
          break;
        case 'stop':
          this.generation = message.generation ?? (this.generation + 1);
          this.clearPendingSeek();
          this.pendingPlayAck = null;
          if (this.engine) {
            this.engine.playing = false;
            this.engine.reset();
          }
          break;
        case 'seek':
          if (message.generation === this.generation && this.engine) {
            this.pendingPlayAck = null;
            this.clearPendingSeek();
            this.engine.playing = false;
            const seconds = Number(message.seconds);
            const targetFrame = Math.max(0, Math.round(
              (Number.isFinite(seconds) ? seconds : 0) * this.engine.outputRate));
            this.discardRollingCheckpointsAfter(targetFrame);
            this.engine.restoreState(this.checkpointForFrame(targetFrame));
            this.pendingSeek = {
              id: message.id,
              generation: this.generation,
              targetFrame,
            };
          }
          break;
      }
    } catch (error) {
      this.port.postMessage({
        type: 'error',
        generation: message.generation ?? this.generation,
        message: error && error.message ? error.message : String(error),
      });
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || !output.length) return true;
    const left = output[0];
    const right = output[1] || output[0];
    if (!this.engine) {
      left.fill(0);
      if (right !== left) right.fill(0);
      return true;
    }

    if (this.pendingSeek) {
      const pending = this.pendingSeek;
      const remaining = pending.targetFrame - this.engine.generatedFrames;
      if (remaining > 0) {
        this.engine.fastForward(Math.min(remaining, WORKLET_SEEK_FRAMES_PER_QUANTUM));
        this.extendSeekCheckpoints();
      }
      left.fill(0);
      if (right !== left) right.fill(0);
      if (this.engine.generatedFrames >= pending.targetFrame) {
        this.pendingSeek = null;
        this.port.postMessage({
          type: 'seeked',
          id: pending.id,
          generation: pending.generation,
        });
      }
      return true;
    }

    if (this.pendingPlayAck && this.engine.playing) {
      const pending = this.pendingPlayAck;
      this.pendingPlayAck = null;
      this.port.postMessage({
        type: 'played',
        id: pending.id,
        generation: pending.generation,
        state: { audioTime: currentFrame / sampleRate },
      });
    }
    this.engine.render(left, right);
    this.extendSeekCheckpoints();
    return true;
  }
}

registerProcessor('xm-replayer', XMWorkletProcessor);
