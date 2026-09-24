// Media module → IR. Host decode (PNG, WAV, FLAC) happens here, in the
// linker, because this is the first stage that reads the disk. The bytes
// become a const array plus a bind function; the handle is an exported
// const. Array parameters are not lowered yet, so bind copies one byte at
// a time through graphics.bind / audio.bind.
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

import { decodePng, sliceFrames } from '@8bitscript/graphics-tools';
import { decodeWav, decodeFlac, encodeDpcm } from '@8bitscript/audio-tools';
import { Codes, diagnostic } from '../diagnostics/index.mjs';
import { resolveSpecifier } from '../resolver/index.mjs';
import { lowerGraphicsDefault, lowerAudioDefault } from './lower-default.mjs';

function resolveMediaPath(specifier, fromFile) {
  if (!specifier) return null;
  if (isAbsolute(specifier)) return specifier;
  return join(dirname(fromFile), specifier);
}

function loadMachineMedia(machine, fromFile, options) {
  if (!machine) return null;
  const resolved = resolveSpecifier(`@8bitscript/${machine}`, fromFile, { ...options, machine });
  if (!resolved?.path) return null;
  let dir = dirname(resolved.path);
  for (let i = 0; i < 6; i += 1) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const rel = pkg['8bitscript']?.media;
        if (!rel) return null;
        const require = createRequire(pkgPath);
        return require(join(dir, rel));
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function emptyIr() {
  return { imports: [], globals: [], functions: [], namespaces: [], strings: [], consts: [], chrPatches: [] };
}

function constHandle(name, value, node) {
  return {
    name, type: 'utinyint', value, exported: true,
    start: node.start ?? 0, length: node.length ?? name.length,
  };
}

function dataGlobal(name, bytes) {
  const data = bytes.length ? bytes : [0];
  return {
    name,
    type: 'utinyint',
    array: data.length,
    constant: true,
    volatile: false,
    address: null,
    init: data,
    exported: false,
    start: 0,
    length: name.length,
  };
}

function bindFunction(name, ns, memberBind, memberMeta, slot, dataName, length, metaArgs, bindPrefix = []) {
  const idxType = length > 255 ? 'usmallint' : 'utinyint';
  const body = [];
  if (length > 0 && dataName) {
    body.push({
      kind: 'for',
      init: { kind: 'local', name: 'i', type: idxType, init: { kind: 'const', value: 0, type: idxType }, start: 0, length: 1 },
      test: {
        kind: 'binop', operator: '<',
        left: { kind: 'ref', name: 'i', type: idxType },
        right: { kind: 'const', value: length, type: idxType },
        type: 'bool',
      },
      update: {
        kind: 'assign', target: 'i',
        value: {
          kind: 'binop', operator: '+',
          left: { kind: 'ref', name: 'i', type: idxType },
          right: { kind: 'const', value: 1, type: idxType },
          type: idxType,
        },
      },
      body: [{
        kind: 'namespaceCall',
        namespace: ns,
        member: memberBind,
        args: [
          ...bindPrefix.map((v) => ({ kind: 'const', value: v, type: 'utinyint' })),
          { kind: 'const', value: slot, type: 'utinyint' },
          { kind: 'ref', name: 'i', type: idxType },
          {
            kind: 'index',
            array: { kind: 'ref', name: dataName },
            index: { kind: 'ref', name: 'i', type: idxType },
            elementType: 'utinyint',
            type: 'utinyint',
          },
        ],
        type: 'void',
      }],
    });
  }
  body.push({
    kind: 'namespaceCall',
    namespace: ns,
    member: memberMeta,
    args: metaArgs.map((v) => ({ kind: 'const', value: v, type: 'utinyint' })),
    type: 'void',
  });
  return {
    name,
    exported: false,
    mediaBind: true,
    params: [],
    returnType: 'void',
    body,
    start: 0,
    length: name.length,
  };
}

function decodeSpriteSource(sprite, file, diagnostics) {
  const path = resolveMediaPath(sprite.source, file);
  if (!path || !existsSync(path)) {
    diagnostics.push(diagnostic(
      Codes.GFX_MISSING_SOURCE,
      `cannot find source '${sprite.source}'`,
      file, sprite.sourceStart ?? sprite.start, sprite.sourceLength ?? sprite.length,
    ));
    return [];
  }
  let decoded;
  try {
    decoded = decodePng(readFileSync(path));
  } catch (error) {
    diagnostics.push(diagnostic(
      Codes.GFX_MISSING_SOURCE,
      `cannot decode '${sprite.source}': ${error.message}`,
      file, sprite.sourceStart ?? sprite.start, sprite.sourceLength ?? sprite.length,
    ));
    return [];
  }
  if (decoded.width < sprite.width || decoded.height < sprite.height) {
    diagnostics.push(diagnostic(
      Codes.GFX_SOURCE_TOO_SMALL,
      `source '${sprite.source}' is ${decoded.width}x${decoded.height}, smaller than size ${sprite.width}x${sprite.height}`,
      file, sprite.sizeStart ?? sprite.start, sprite.sizeLength ?? sprite.length,
    ));
    return [];
  }
  const sliced = sliceFrames(decoded.rgba, decoded.width, decoded.height, sprite.width, sprite.height);
  return sliced.map((rgba) => ({ rgba, width: sprite.width, height: sprite.height }));
}

function decodeSampleSource(sample, file, diagnostics) {
  const path = resolveMediaPath(sample.source, file);
  if (!path || !existsSync(path)) {
    diagnostics.push(diagnostic(
      Codes.AUD_MISSING_SOURCE,
      `cannot find source '${sample.source}'`,
      file, sample.sourceStart ?? sample.start, sample.sourceLength ?? sample.length,
    ));
    return null;
  }
  const lower = path.toLowerCase();
  try {
    if (lower.endsWith('.flac')) {
      const pcm = decodeFlac(path);
      return { ...pcm, dpcm: encodeDpcm(pcm.samples, pcm.sampleRate) };
    }
    const pcm = decodeWav(readFileSync(path));
    return { ...pcm, dpcm: encodeDpcm(pcm.samples, pcm.sampleRate) };
  } catch (error) {
    if (error.code === 'FLAC_NEEDS_FFMPEG') {
      diagnostics.push(diagnostic(
        Codes.AUD_FLAC_NEEDS_FFMPEG,
        `FLAC source '${sample.source}' needs ffmpeg on PATH`,
        file, sample.sourceStart ?? sample.start, sample.sourceLength ?? sample.length,
      ));
      return null;
    }
    diagnostics.push(diagnostic(
      Codes.AUD_MISSING_SOURCE,
      `cannot decode '${sample.source}': ${error.message}`,
      file, sample.sourceStart ?? sample.start, sample.sourceLength ?? sample.length,
    ));
    return null;
  }
}

function wrapDiagnostic(code, message, file, start, length, severity = 'error') {
  return diagnostic(code, message, file, start, length, severity);
}

/**
 * @param {object} module  parseMediaModule's result (media.gir / media.air)
 * @param {object[]} diagnostics
 * @param {{ machine?: string, facts?: object, checkout?: string|null }} options
 */
export function elaborateMedia(module, diagnostics, options = {}) {
  const { file, media } = module;
  const machine = options.machine;
  const facts = options.facts ?? {};
  const lowering = loadMachineMedia(machine, file, options);
  const ir = emptyIr();
  const chrPatches = [];

  if (media.kind === '.8bg') {
    ir.imports.push({
      source: '@8bitscript/graphics',
      specifiers: [{ imported: 'graphics', local: 'graphics', start: 0, length: 8 }],
      start: 0, length: 0,
    });
    const gir = media.gir;
    gir.sprites.forEach((sprite, slot) => {
      ir.consts.push(constHandle(sprite.name, slot, sprite));
      const frames = decodeSpriteSource(sprite, file, diagnostics);
      const result = lowering?.lowerGraphics
        ? lowering.lowerGraphics(sprite, frames, facts, file, wrapDiagnostic)
        : lowerGraphicsDefault(sprite, frames, file);
      diagnostics.push(...(result.diagnostics ?? []));
      const dataName = `__8bg_${sprite.name}`;
      ir.globals.push(dataGlobal(dataName, result.data ?? []));
      ir.functions.push(bindFunction(
        `__8bs_media_bind_${sprite.name}`,
        'graphics', 'bind', 'meta',
        slot, dataName, (result.data ?? []).length,
        [slot, result.frames ?? 1, result.every ?? 8, result.kind ?? 0, result.width ?? 8, result.height ?? 8],
      ));
      for (const patch of result.chrPatches ?? []) chrPatches.push(patch);
    });
  } else {
    ir.imports.push({
      source: '@8bitscript/audio',
      specifiers: [{ imported: 'audio', local: 'audio', start: 0, length: 5 }],
      start: 0, length: 0,
    });
    const air = media.air;
    const pcmBySample = new Map();
    for (const sample of air.samples) {
      const pcm = decodeSampleSource(sample, file, diagnostics);
      if (pcm) pcmBySample.set(sample.name, pcm);
    }
    const voices = Number(facts['audio.voices'] ?? 0);
    const pcm = facts['audio.pcm'] === true;
    const result = lowering?.lowerAudio
      ? lowering.lowerAudio(air, pcmBySample, facts, file, wrapDiagnostic)
      : lowerAudioDefault(air, pcmBySample, file, { machine: machine ?? '(none)', voices, pcm });
    diagnostics.push(...(result.diagnostics ?? []));
    result.samples.forEach((sample, slot) => {
      ir.consts.push(constHandle(sample.name, slot, air.samples[slot] ?? { start: 0, length: sample.name.length }));
      const dataName = `__8ba_sfx_${sample.name}`;
      if (sample.data?.length) {
        ir.globals.push(dataGlobal(dataName, sample.data));
        ir.functions.push(bindFunction(
          `__8bs_media_bind_${sample.name}`,
          'audio', 'bind', 'meta',
          slot, dataName, sample.data.length,
          [0, slot, sample.data.length, 0, 0, 0],
          [0],
        ));
      }
    });
    result.songs.forEach((song, slot) => {
      ir.consts.push(constHandle(song.name, slot, air.songs[slot] ?? { start: 0, length: song.name.length }));
      const dataName = `__8ba_song_${song.name}`;
      if (song.data?.length) {
        ir.globals.push(dataGlobal(dataName, song.data));
        ir.functions.push(bindFunction(
          `__8bs_media_bind_${song.name}`,
          'audio', 'bind', 'meta',
          slot, dataName, song.data.length,
          [1, slot, song.data.length, 0, 0, 0],
          [1],
        ));
      }
    });
    for (const inst of air.instruments) {
      if (ir.consts.some((c) => c.name === inst.name)) continue;
      ir.consts.push(constHandle(inst.name, 0, inst));
    }
  }

  ir.chrPatches = chrPatches;
  module.ir = ir;
  module.ast = null;
  module.tokens = module.tokens ?? [];
  return module;
}
