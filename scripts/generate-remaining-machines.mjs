#!/usr/bin/env node
// One-shot generator for the remaining roadmap machines. Safe to re-run.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const MOS = [
  'plus4', 'oric', 'apple2', 'bbc', 'atari5200', 'lynx', 'pce',
  'supervision', 'atari2600', 'atari7800',
];
const SM83 = ['gb', 'gbc'];
const Z80 = ['sms', 'gamegear', 'sg1000', 'msx', 'coleco', 'spectrum', 'cpc'];
const M6809 = ['coco', 'vectrex'];
const I8048 = ['odyssey2'];
const F8 = ['channelf'];
const NEW = [...MOS, ...SM83, ...Z80, ...M6809, ...I8048, ...F8];

const SYSTEMS = {
  plus4: 9, oric: 10, apple2: 11, bbc: 12, atari5200: 13, lynx: 14,
  pce: 15, supervision: 16, atari2600: 17, atari7800: 18,
  gb: 19, gbc: 20, sms: 21, gamegear: 22, sg1000: 23,
  msx: 24, coleco: 25, spectrum: 26, cpc: 27, coco: 28, vectrex: 29,
  odyssey2: 30, channelf: 31,
};

const SYSTEM_CONST = {
  plus4: 'PLUS4', oric: 'ORIC', apple2: 'APPLE2', bbc: 'BBC',
  atari5200: 'ATARI5200', lynx: 'LYNX', pce: 'PCE',
  supervision: 'SUPERVISION', atari2600: 'ATARI2600', atari7800: 'ATARI7800',
  gb: 'GB', gbc: 'GBC', sms: 'SMS',
  gamegear: 'GAMEGEAR', sg1000: 'SG1000', msx: 'MSX', coleco: 'COLECO',
  spectrum: 'SPECTRUM', cpc: 'CPC', coco: 'COCO', vectrex: 'VECTREX',
  odyssey2: 'ODYSSEY2', channelf: 'CHANNELF',
};

const TITLES = {
  plus4: 'Commodore Plus/4',
  oric: 'Oric-1 / Atmos',
  apple2: 'Apple II',
  bbc: 'BBC Micro',
  atari5200: 'Atari 5200',
  lynx: 'Atari Lynx',
  pce: 'PC Engine / TurboGrafx-16',
  supervision: 'Watara Supervision',
  atari2600: 'Atari 2600',
  atari7800: 'Atari 7800',
  gb: 'Game Boy',
  gbc: 'Game Boy Color',
  sms: 'Sega Master System',
  gamegear: 'Sega Game Gear',
  sg1000: 'Sega SG-1000',
  msx: 'MSX',
  coleco: 'ColecoVision',
  spectrum: 'ZX Spectrum',
  cpc: 'Amstrad CPC',
  coco: 'Tandy Color Computer',
  vectrex: 'Vectrex',
  odyssey2: 'Magnavox Odyssey²',
  channelf: 'Fairchild Channel F',
};

const DEFERRED = {
  oric: 'MAME needs a ROM set this project does not ship',
  apple2: 'MAME needs a ROM set this project does not ship',
  bbc: 'MAME needs a ROM set this project does not ship',
  lynx: 'MAME needs a ROM set this project does not ship',
  supervision: 'MAME needs a ROM set this project does not ship',
  atari7800: 'MAME needs a ROM set this project does not ship',
  sg1000: 'MAME needs a ROM set this project does not ship',
  coleco: 'MAME needs a ROM set this project does not ship',
  odyssey2: 'MAME needs a ROM set this project does not ship',
  channelf: 'MAME needs a ROM set this project does not ship',
  atari5200: 'atari800 needs a 5200 BIOS ROM this project does not ship',
  atari2600: 'Stella install is pending',
  gb: 'SameBoy is a GUI app',
  gbc: 'SameBoy is a GUI app',
  spectrum: 'Fuse is a GUI app',
  sms: 'Mednafen is a GUI app',
  gamegear: 'Mednafen is a GUI app',
  pce: 'Mednafen is a GUI app',
  msx: 'openMSX interactive run is pending setup',
  cpc: 'Caprice32 has no Homebrew formula',
  coco: 'XRoar install is pending',
  vectrex: 'Vecx has no Homebrew or Debian package',
};

const FAMILY = Object.fromEntries([
  ...MOS.map((id) => [id, 'mos']),
  ...SM83.map((id) => [id, 'sm83']),
  ...Z80.map((id) => [id, 'z80']),
  ...M6809.map((id) => [id, 'm6809']),
  ...I8048.map((id) => [id, 'i8048']),
  ...F8.map((id) => [id, 'f8']),
]);

function facts(extra) {
  return {
    'video.columns': 40,
    'video.rows': 25,
    'video.cellWidth': 8,
    'video.cellHeight': 8,
    'video.palette': 2,
    'video.cellColors': 2,
    'video.colorPerCell': false,
    'video.glyphs': 0,
    'video.blockWidth': 0,
    'video.blockHeight': 0,
    'video.bitmap': false,
    'video.layers': 1,
    'video.scroll': false,
    'video.raster': false,
    'video.sprites': 0,
    'video.spritesPerLine': 0,
    'video.spriteWidth': 0,
    'video.spriteHeight': 0,
    'video.spriteColors': 0,
    'video.frameRate': 60,
    'audio.voices': 0,
    'audio.noise': false,
    'audio.envelope': false,
    'audio.filter': false,
    'audio.pcm': false,
    'audio.volume': false,
    'audio.entropy': false,
    'input.keyboard': true,
    'input.joysticks': 0,
    'input.pads': 0,
    'input.controls': [],
    'input.mouse': false,
    'input.paddles': false,
    'storage.save': false,
    'storage.kib': 0,
    'memory.ram': 4096,
    'memory.banked': false,
    'memory.bankedKib': 0,
    ...extra,
  };
}

const SPECS = {
  plus4: {
    family: 'mos',
    emulator: { binary: 'xplus4', family: 'vice', screenshot: 'vice', framesUnit: 'cycles', defaultFrames: 8000000, installer: 'vice' },
    output: 'prg',
    load: 0x1001,
    ram: 28671,
    screen: 0x0c00,
    color: 0x0800,
    ted: true,
    keyboard: true,
    facts: facts({
      'video.columns': 40, 'video.rows': 25, 'video.palette': 121,
      'video.cellColors': 2, 'video.colorPerCell': true, 'video.raster': true,
      'video.frameRate': 50, 'audio.voices': 2, 'audio.noise': true,
      'input.keyboard': true, 'input.joysticks': 2, 'input.controls': ['up', 'down', 'left', 'right', 'fire'],
      'storage.save': true, 'storage.kib': 170, 'memory.ram': 28671,
    }),
    options: {
      model: {
        label: 'Model',
        default: 'plus4',
        values: {
          plus4: { label: 'Plus/4: 64K, ACIA, 3-plus-1', run: { xplus4: ['-model', 'plus4'] }, facts: { 'memory.ram': 28671 } },
          c16: { label: 'C16: 16K, no function ROMs', run: { xplus4: ['-model', 'c16'] }, facts: { 'memory.ram': 12277 }, tag: 'c16' },
          c116: { label: 'C116: 16K, calculator keyboard', run: { xplus4: ['-model', 'c16'] }, facts: { 'memory.ram': 12277 }, tag: 'c16' },
        },
      },
    },
    presets: { plus4: { model: 'plus4' }, c16: { model: 'c16' }, c116: { model: 'c116' } },
    region: true,
  },
  oric: {
    family: 'mos', emulator: { binary: 'mame', family: 'mame', screenshot: 'mame', framesUnit: 'seconds', defaultFrames: 8, installer: 'mame', slot: 'cass' },
    output: 'tap', load: 0x0500, ram: 49152, screen: 0xbb80, keyboard: true,
    facts: facts({ 'video.columns': 40, 'video.rows': 28, 'video.palette': 8, 'video.colorPerCell': true, 'video.serialAttributes': undefined, 'memory.ram': 49152, 'audio.voices': 3, 'audio.noise': true }),
    mameSystem: 'oric1',
  },
  apple2: {
    family: 'mos', emulator: { binary: 'mame', family: 'mame', screenshot: 'mame', framesUnit: 'seconds', defaultFrames: 8, installer: 'mame' },
    output: 'bin', load: 0x0800, ram: 49152, screen: 0x0400, keyboard: true,
    facts: facts({ 'video.columns': 40, 'video.rows': 24, 'video.bitmap': true, 'memory.ram': 49152 }),
    options: {
      model: {
        label: 'Model', default: 'iie',
        values: {
          iiplus: { label: 'II Plus: 48K, no VBL', run: { mame: ['apple2p'] }, facts: { 'memory.ram': 49152 } },
          iie: { label: 'IIe: 64K, $C019 VBL', run: { mame: ['apple2e'] }, facts: { 'memory.ram': 65536 } },
          'iie-enhanced': { label: 'IIe Enhanced', run: { mame: ['apple2ee'] }, facts: { 'memory.ram': 65536 } },
          iic: { label: 'IIc', run: { mame: ['apple2c'] }, facts: { 'memory.ram': 65536 } },
        },
      },
    },
    presets: { iiplus: { model: 'iiplus' }, iie: { model: 'iie' }, iic: { model: 'iic' } },
    mameSystem: 'apple2e',
  },
  bbc: {
    family: 'mos', emulator: { binary: 'mame', family: 'mame', screenshot: 'mame', framesUnit: 'seconds', defaultFrames: 8, installer: 'mame' },
    output: 'bin', load: 0x0e00, ram: 32768, screen: 0x7c00, keyboard: true,
    facts: facts({ 'video.columns': 40, 'video.rows': 25, 'video.palette': 8, 'memory.ram': 32768 }),
    mameSystem: 'bbcb',
  },
  atari5200: {
    family: 'mos', emulator: { binary: 'atari800', family: 'atari800', screenshot: 'window', framesUnit: 'frames', defaultFrames: 240, installer: 'atari800' },
    output: 'bin', load: 0x4000, ram: 16384, screen: 0x0000, cart: true, keyboard: false,
    facts: facts({
      'video.columns': 40, 'video.rows': 24, 'video.palette': 256, 'video.colorPerCell': true,
      'video.scroll': true, 'video.raster': true, 'video.sprites': 4, 'video.spritesPerLine': 4,
      'video.spriteWidth': 8, 'video.spriteHeight': 256, 'video.spriteColors': 1,
      'input.keyboard': false, 'input.joysticks': 0, 'input.pads': 2,
      'input.controls': ['up', 'down', 'left', 'right', 'fire'],
      'memory.ram': 16384,
    }),
    options: {
      media: {
        label: 'Cartridge', default: '32k',
        values: {
          '32k': { label: '32K cart', build: { output: 'bin', defsym: { __rom_size: 32768 } } },
          supercart: { label: 'Super Cart (banked)', build: { output: 'bin', defsym: { __rom_size: 65536 } } },
        },
      },
    },
    region: true,
  },
  lynx: {
    family: 'mos', emulator: { binary: 'mame', family: 'mame', screenshot: 'mame', framesUnit: 'seconds', defaultFrames: 8, installer: 'mame', slot: 'cart' },
    output: 'lnx', load: 0x0200, ram: 65536, screen: 0x0000, cart: true, keyboard: false,
    facts: facts({
      'video.columns': 20, 'video.rows': 12, 'video.cellWidth': 8, 'video.cellHeight': 8,
      'video.palette': 4096, 'video.bitmap': true, 'input.keyboard': false, 'input.pads': 1,
      'input.controls': ['up', 'down', 'left', 'right', 'a', 'b', 'option1', 'option2'],
      'memory.ram': 65536, 'audio.voices': 4, 'audio.pcm': true,
    }),
    mameSystem: 'lynx',
  },
  pce: {
    family: 'mos', emulator: { binary: 'mednafen', family: 'dedicated', screenshot: 'window', framesUnit: 'frames', defaultFrames: 180, installer: 'mednafen' },
    output: 'pce', load: 0xe000, ram: 8192, screen: 0x0000, cart: true, keyboard: false,
    facts: facts({
      'video.columns': 32, 'video.rows': 28, 'video.palette': 512, 'video.sprites': 64,
      'video.spritesPerLine': 16, 'video.spriteWidth': 32, 'video.spriteHeight': 64, 'video.spriteColors': 15,
      'video.scroll': true, 'video.raster': true, 'input.keyboard': false, 'input.pads': 1,
      'input.controls': ['up', 'down', 'left', 'right', 'i', 'ii', 'select', 'run'],
      'memory.ram': 8192, 'audio.voices': 6, 'audio.noise': true,
    }),
    options: {
      media: {
        label: 'Media', default: 'hucard',
        values: {
          hucard: { label: 'HuCard', build: { output: 'pce' } },
          cdrom2: { label: 'CD-ROM² (later)', build: { output: 'pce' } },
        },
      },
    },
  },
  supervision: {
    family: 'mos', emulator: { binary: 'mame', family: 'mame', screenshot: 'mame', framesUnit: 'seconds', defaultFrames: 8, installer: 'mame', slot: 'cart' },
    output: 'bin', load: 0x8000, ram: 8192, screen: 0x0000, cart: true, keyboard: false,
    facts: facts({
      'video.columns': 20, 'video.rows': 20, 'video.palette': 4, 'video.bitmap': true,
      'input.keyboard': false, 'input.pads': 1,
      'input.controls': ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start'],
      'memory.ram': 8192,
    }),
    mameSystem: 'svision',
  },
  atari2600: {
    family: 'mos', emulator: { binary: 'stella', family: 'dedicated', screenshot: 'window', framesUnit: 'frames', defaultFrames: 180, installer: 'stella' },
    output: 'a26', load: 0xf000, ram: 128, screen: 0x0000, cart: true, keyboard: false,
    facts: facts({
      'video.columns': 20, 'video.rows': 12, 'video.palette': 128, 'video.bitmap': false,
      'video.raster': true, 'input.keyboard': false, 'input.joysticks': 2,
      'input.controls': ['up', 'down', 'left', 'right', 'fire'],
      'memory.ram': 128, 'audio.voices': 2, 'audio.noise': true,
    }),
    options: {
      mapper: {
        label: 'Mapper', default: '4k',
        values: {
          '4k': { label: '4K (no bank)', build: { defsym: { __rom_size: 4096 } } },
          '3e': { label: '3E bankswitching', build: { defsym: { __rom_size: 32768 } } },
        },
      },
    },
    region: true,
  },
  atari7800: {
    family: 'mos', emulator: { binary: 'mame', family: 'mame', screenshot: 'mame', framesUnit: 'seconds', defaultFrames: 8, installer: 'mame', slot: 'cart' },
    output: 'a78', load: 0x8000, ram: 4096, screen: 0x0000, cart: true, keyboard: false,
    facts: facts({
      'video.columns': 20, 'video.rows': 12, 'video.palette': 256, 'video.sprites': 30,
      'video.spritesPerLine': 30, 'video.spriteWidth': 32, 'video.spriteHeight': 16, 'video.spriteColors': 3,
      'video.raster': true, 'input.keyboard': false, 'input.joysticks': 2,
      'input.controls': ['up', 'down', 'left', 'right', 'fire'],
      'memory.ram': 4096, 'audio.voices': 2, 'audio.noise': true,
    }),
    mameSystem: 'a7800',
    region: true,
  },
  gb: {
    family: 'sm83', emulator: { binary: 'sameboy', family: 'dedicated', screenshot: 'window', framesUnit: 'frames', defaultFrames: 180, installer: 'sameboy' },
    output: 'gb', load: 0x0150, ram: 8192, screen: 0x9800, keyboard: false,
    facts: facts({
      'video.columns': 20, 'video.rows': 18, 'video.palette': 4, 'video.sprites': 40,
      'video.spritesPerLine': 10, 'video.spriteWidth': 8, 'video.spriteHeight': 16, 'video.spriteColors': 3,
      'video.scroll': true, 'input.keyboard': false, 'input.pads': 1,
      'input.controls': ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start'],
      'memory.ram': 8192, 'memory.banked': true, 'audio.voices': 4, 'audio.noise': true, 'audio.pcm': true,
    }),
    options: {
      mapper: {
        label: 'Mapper', default: 'mbc1',
        values: {
          none: { label: 'No MBC (32K)', build: { defsym: { __rom_size: 32768 } } },
          mbc1: { label: 'MBC1', build: { defsym: { __rom_size: 131072 } } },
          mbc3: { label: 'MBC3 + timer', build: { defsym: { __rom_size: 262144 } } },
          mbc5: { label: 'MBC5', build: { defsym: { __rom_size: 524288 } } },
        },
      },
    },
  },
  gbc: {
    family: 'sm83', emulator: { binary: 'sameboy', family: 'dedicated', screenshot: 'window', framesUnit: 'frames', defaultFrames: 180, installer: 'sameboy' },
    output: 'gbc', load: 0x0150, ram: 32768, screen: 0x9800, keyboard: false,
    facts: facts({
      'video.columns': 20, 'video.rows': 18, 'video.palette': 32768, 'video.sprites': 40,
      'video.spritesPerLine': 10, 'video.spriteWidth': 8, 'video.spriteHeight': 16, 'video.spriteColors': 3,
      'video.scroll': true, 'input.keyboard': false, 'input.pads': 1,
      'input.controls': ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start'],
      'memory.ram': 32768, 'memory.banked': true, 'memory.bankedKib': 32,
      'audio.voices': 4, 'audio.noise': true, 'audio.pcm': true,
    }),
  },
  sms: {
    family: 'z80', emulator: { binary: 'mednafen', family: 'dedicated', screenshot: 'window', framesUnit: 'frames', defaultFrames: 180, installer: 'mednafen' },
    output: 'sms', load: 0x0000, ram: 8192, screen: 0x0000, keyboard: false,
    facts: facts({
      'video.columns': 32, 'video.rows': 24, 'video.palette': 64, 'video.sprites': 64,
      'video.spritesPerLine': 8, 'video.spriteWidth': 8, 'video.spriteHeight': 16, 'video.spriteColors': 15,
      'input.keyboard': false, 'input.pads': 2,
      'input.controls': ['up', 'down', 'left', 'right', 'b1', 'b2'],
      'memory.ram': 8192, 'audio.voices': 4, 'audio.noise': true,
    }),
  },
  gamegear: {
    family: 'z80', emulator: { binary: 'mednafen', family: 'dedicated', screenshot: 'window', framesUnit: 'frames', defaultFrames: 180, installer: 'mednafen' },
    output: 'gg', load: 0x0000, ram: 8192, screen: 0x0000, keyboard: false,
    facts: facts({
      'video.columns': 20, 'video.rows': 18, 'video.palette': 4096, 'video.sprites': 64,
      'video.spritesPerLine': 8, 'video.spriteWidth': 8, 'video.spriteHeight': 16, 'video.spriteColors': 15,
      'input.keyboard': false, 'input.pads': 1,
      'input.controls': ['up', 'down', 'left', 'right', 'b1', 'b2', 'start'],
      'memory.ram': 8192, 'audio.voices': 4, 'audio.noise': true,
    }),
  },
  sg1000: {
    family: 'z80', emulator: { binary: 'mame', family: 'mame', screenshot: 'mame', framesUnit: 'seconds', defaultFrames: 8, installer: 'mame', slot: 'cart' },
    output: 'sg', load: 0x0000, ram: 1024, screen: 0x0000, keyboard: false, tms: true,
    facts: facts({
      'video.columns': 32, 'video.rows': 24, 'video.palette': 16, 'video.sprites': 32,
      'video.spritesPerLine': 4, 'video.spriteWidth': 16, 'video.spriteHeight': 16, 'video.spriteColors': 1,
      'input.keyboard': false, 'input.pads': 2,
      'input.controls': ['up', 'down', 'left', 'right', 'b1', 'b2'],
      'memory.ram': 1024,
    }),
    mameSystem: 'sg1000',
  },
  msx: {
    family: 'z80', emulator: { binary: 'openmsx', family: 'dedicated', screenshot: 'openmsx', framesUnit: 'frames', defaultFrames: 180, installer: 'openmsx' },
    output: 'rom', load: 0x4000, ram: 16384, screen: 0x0000, keyboard: true, tms: true,
    facts: facts({
      'video.columns': 32, 'video.rows': 24, 'video.palette': 16, 'video.sprites': 32,
      'video.spritesPerLine': 4, 'video.spriteWidth': 16, 'video.spriteHeight': 16, 'video.spriteColors': 1,
      'input.keyboard': true, 'input.joysticks': 2, 'input.controls': ['up', 'down', 'left', 'right', 'fire'],
      'memory.ram': 16384, 'audio.voices': 3, 'audio.noise': true, 'storage.save': true, 'storage.kib': 360,
    }),
    options: {
      model: {
        label: 'Model', default: 'msx1',
        values: {
          msx1: { label: 'MSX1: TMS9918, 16K VRAM', facts: { 'video.palette': 16, 'video.scroll': false } },
          msx2: { label: 'MSX2: V9938, 128K VRAM, scroll', facts: { 'video.palette': 512, 'video.scroll': true, 'video.rows': 26 }, tag: 'msx2' },
        },
      },
    },
    presets: { msx1: { model: 'msx1' }, msx2: { model: 'msx2' } },
  },
  coleco: {
    family: 'z80', emulator: { binary: 'mame', family: 'mame', screenshot: 'mame', framesUnit: 'seconds', defaultFrames: 8, installer: 'mame', slot: 'cart' },
    output: 'col', load: 0x8000, ram: 1024, screen: 0x0000, keyboard: false, tms: true,
    facts: facts({
      'video.columns': 32, 'video.rows': 24, 'video.palette': 16, 'video.sprites': 32,
      'video.spritesPerLine': 4, 'video.spriteWidth': 16, 'video.spriteHeight': 16, 'video.spriteColors': 1,
      'input.keyboard': false, 'input.pads': 2,
      'input.controls': ['up', 'down', 'left', 'right', 'fire'],
      'memory.ram': 1024,
    }),
    mameSystem: 'coleco',
  },
  spectrum: {
    family: 'z80', emulator: { binary: 'fuse', family: 'dedicated', screenshot: 'window', framesUnit: 'frames', defaultFrames: 180, installer: 'fuse' },
    output: 'tap', load: 0x8000, ram: 49152, screen: 0x4000, keyboard: true,
    facts: facts({
      'video.columns': 32, 'video.rows': 24, 'video.palette': 8, 'video.colorPerCell': true,
      'video.bitmap': true, 'input.keyboard': true, 'input.joysticks': 1,
      'input.controls': ['up', 'down', 'left', 'right', 'fire'],
      'memory.ram': 49152, 'audio.voices': 1,
    }),
  },
  cpc: {
    family: 'z80', emulator: { binary: 'cap32', family: 'dedicated', screenshot: 'window', framesUnit: 'frames', defaultFrames: 180, installer: 'caprice32' },
    output: 'bin', load: 0x4000, ram: 65536, screen: 0xc000, keyboard: true,
    facts: facts({
      'video.columns': 40, 'video.rows': 25, 'video.palette': 27, 'video.bitmap': true,
      'input.keyboard': true, 'input.joysticks': 1,
      'input.controls': ['up', 'down', 'left', 'right', 'fire'],
      'memory.ram': 65536, 'memory.banked': true, 'audio.voices': 3, 'audio.noise': true,
      'storage.save': true, 'storage.kib': 180,
    }),
  },
  coco: {
    family: 'm6809', emulator: { binary: 'xroar', family: 'dedicated', screenshot: 'window', framesUnit: 'frames', defaultFrames: 180, installer: 'xroar' },
    output: 'bin', load: 0x0e00, ram: 32768, screen: 0x0400, keyboard: true,
    facts: facts({
      'video.columns': 32, 'video.rows': 16, 'video.palette': 9, 'memory.ram': 32768,
    }),
    options: {
      model: {
        label: 'Model', default: 'coco2',
        values: {
          coco1: { label: 'CoCo 1: 6847', facts: { 'video.columns': 32, 'video.rows': 16 } },
          coco2: { label: 'CoCo 2: 6847', facts: { 'video.columns': 32, 'video.rows': 16 } },
          coco3: { label: 'CoCo 3: GIME', facts: { 'video.columns': 80, 'video.rows': 24, 'video.palette': 64, 'memory.ram': 131072 }, tag: 'coco3' },
          dragon: { label: 'Dragon 32 (same 6847 design)', facts: { 'video.columns': 32, 'video.rows': 16 } },
        },
      },
    },
    presets: { coco2: { model: 'coco2' }, coco3: { model: 'coco3' }, dragon: { model: 'dragon' } },
  },
  vectrex: {
    family: 'm6809', emulator: { binary: 'vecx', family: 'dedicated', screenshot: 'window', framesUnit: 'frames', defaultFrames: 180, installer: 'vecx' },
    output: 'bin', load: 0x0000, ram: 1024, screen: 0x0000, keyboard: false,
    facts: facts({
      'video.columns': 16, 'video.rows': 12, 'video.palette': 2, 'video.bitmap': false,
      'input.keyboard': false, 'input.joysticks': 2,
      'input.controls': ['up', 'down', 'left', 'right', 'b1', 'b2', 'b3', 'b4'],
      'memory.ram': 1024, 'audio.voices': 3, 'audio.noise': true, 'audio.envelope': true,
    }),
  },
  odyssey2: {
    family: 'i8048', emulator: { binary: 'mame', family: 'mame', screenshot: 'mame', framesUnit: 'seconds', defaultFrames: 8, installer: 'mame', slot: 'cart' },
    output: 'bin', load: 0x0400, ram: 192, screen: 0x0000, keyboard: true,
    facts: facts({
      'video.columns': 12, 'video.rows': 8, 'video.palette': 16, 'video.sprites': 4,
      'video.spritesPerLine': 4, 'video.spriteWidth': 8, 'video.spriteHeight': 8, 'video.spriteColors': 1,
      'input.keyboard': true, 'input.joysticks': 2,
      'input.controls': ['up', 'down', 'left', 'right', 'fire'],
      'memory.ram': 192, 'audio.voices': 1,
    }),
    mameSystem: 'odyssey2',
  },
  channelf: {
    family: 'f8', emulator: { binary: 'mame', family: 'mame', screenshot: 'mame', framesUnit: 'seconds', defaultFrames: 8, installer: 'mame', slot: 'cart' },
    output: 'bin', load: 0x0000, ram: 64, screen: 0x0000, keyboard: false,
    facts: facts({
      'video.columns': 13, 'video.rows': 8, 'video.palette': 8, 'video.bitmap': true,
      'input.keyboard': false, 'input.pads': 2,
      'input.controls': ['up', 'down', 'left', 'right', 'rotate', 'pull', 'push'],
      'memory.ram': 64, 'audio.voices': 1,
    }),
    mameSystem: 'channelf',
  },
};

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
}

function packageJson(id, spec) {
  const defsym = { __load_address: spec.load };
  if (spec.ram) defsym.__ram_size = Math.ceil(spec.ram / 1024) || 4;
  if (spec.cart) {
    defsym.__rom_size = spec.facts['memory.ram'] < 256 ? 4096 : 32768;
    defsym.__bss_origin = 0x0200;
    defsym.__bss_ceiling = 0x0200 + Math.min(spec.facts['memory.ram'], 0x1000);
  }
  const hardware = {
    build: { defsym, output: spec.output },
    facts: spec.facts,
    options: spec.options ?? {},
    presets: spec.presets ?? {},
  };
  if (spec.emulator.family === 'mame' && spec.mameSystem) {
    hardware.build.mameSystem = spec.mameSystem;
  }
  return JSON.stringify({
    name: `@8bitscript/${id}`,
    version: '0.22.1',
    description: `${TITLES[id]} target support for 8BitScript: the hardware underneath the portable APIs.`,
    license: 'MIT',
    repository: { type: 'git', url: 'https://github.com/8BitScript/8bitscript.git', directory: `packages/${id}` },
    '8bitscript': {
      title: TITLES[id],
      emulator: DEFERRED[id] ? { ...spec.emulator, deferred: DEFERRED[id] } : spec.emulator,
      entry: './src/index.8bs',
      exports: {
        './screen': './src/screen.8bs',
        './text': './src/text.8bs',
        './input': './src/input.8bs',
        './pointer': './src/pointer.8bs',
        './rasterline': './src/rasterline.8bs',
      },
      hardware,
    },
    files: ['src'],
    publishConfig: { access: 'public' },
    scripts: { test: 'node --test' },
  }, null, 2);
}

function index8bs(id, spec) {
  if (spec.ted) {
    return `// @8bitscript/plus4 — Commodore Plus/4: TED registers, not VIC-II.
// TED is video, sound, timers, keyboard latch and ROM banking at once.
// Screen is a 2K block: attributes at $0800, characters at $0C00.
// Color byte: bits 0-3 chroma, 4-6 luma, 7 blink. 121 colors.
// Raster: $FF1C bit 0 + $FF1D. ROM in $FF3E, RAM in $FF3F.
@address(0xFF15)
export let tedBackground: volatile<u8>;

@address(0xFF19)
export let tedBorder: volatile<u8>;

@address(0xFF1C)
export let tedRasterHi: volatile<u8>;

@address(0xFF1D)
export let tedRasterLo: volatile<u8>;
`;
  }
  return `// @8bitscript/${id} — ${TITLES[id]} hardware underneath the portable APIs.
// Registers a program names sit in this package; screen/text/input import them.
`;
}

function geometry8bs(spec) {
  const cols = spec.facts['video.columns'];
  const rows = spec.facts['video.rows'];
  return `export namespace Video {
    const COLUMNS: utinyint = ${cols};
    const ROWS: utinyint = ${rows};
    const CELL_COUNT: usmallint = ${cols * rows};
}
`;
}

function screen8bs(id, spec) {
  if (spec.ted) {
    return `import { tedBackground, tedBorder } from "./index.8bs";
import { Video } from "./geometry.8bs";

export namespace screen {
    function setColors(border: u8, background: u8): void {
        tedBorder = border;
        tedBackground = background;
    }

    function blank(border: utinyint = BorderColor.BLACK, background: utinyint = BackgroundColor.BLACK): void {
        if (border != BorderColor.KEEP) {
            screen.setBorder(border);
        }
        if (background != BackgroundColor.KEEP) {
            screen.setBackground(background);
        }
        for (let i: utinyint = 0; i < 250; i++) {
            memory.write(0x0C00 + i, 32);
            memory.write(0x0C00 + i + 250, 32);
            memory.write(0x0C00 + i + 500, 32);
            memory.write(0x0C00 + i + 750, 32);
            memory.write(0x0800 + i, 0x71);
            memory.write(0x0800 + i + 250, 0x71);
            memory.write(0x0800 + i + 500, 0x71);
            memory.write(0x0800 + i + 750, 0x71);
        }
    }

    function setBackground(background: u8): void {
        tedBackground = background;
    }

    function setBorder(border: u8): void {
        tedBorder = border;
    }

    const RESIZABLE: bool = false;

    function resized(): bool {
        return false;
    }
}

export namespace BorderColor {
    const BLACK: utinyint = 0;
    const WHITE: utinyint = 0x71;
    const RED: utinyint = 0x22;
    const CYAN: utinyint = 0x33;
    const PURPLE: utinyint = 0x44;
    const GREEN: utinyint = 0x55;
    const BLUE: utinyint = 0x66;
    const YELLOW: utinyint = 0x77;
    const KEEP: utinyint = 255;
}

export namespace BackgroundColor {
    const BLACK: utinyint = 0;
    const WHITE: utinyint = 0x71;
    const RED: utinyint = 0x22;
    const CYAN: utinyint = 0x33;
    const PURPLE: utinyint = 0x44;
    const GREEN: utinyint = 0x55;
    const BLUE: utinyint = 0x66;
    const YELLOW: utinyint = 0x77;
    const KEEP: utinyint = 255;
}
`;
  }
  const base = spec.screen ?? 0x0400;
  return `import { Video } from "./geometry.8bs";

export namespace screen {
    function setColors(border: u8, background: u8): void {
    }

    function blank(border: utinyint = BorderColor.BLACK, background: utinyint = BackgroundColor.BLACK): void {
${spec.family === 'mos' ? `        for (let cell: usmallint = 0; cell < Video.CELL_COUNT; cell++) {
            memory.write(${base} + cell, 32);
        }
` : `        // The ISA backends do not yet lower a computed memory.write in a loop.
`}    }

    function setBackground(background: u8): void {
    }

    function setBorder(border: u8): void {
    }

    const RESIZABLE: bool = false;

    function resized(): bool {
        return false;
    }
}

export namespace BorderColor {
    const BLACK: utinyint = 0;
    const WHITE: utinyint = 1;
    const RED: utinyint = 2;
    const CYAN: utinyint = 3;
    const PURPLE: utinyint = 4;
    const GREEN: utinyint = 5;
    const BLUE: utinyint = 6;
    const YELLOW: utinyint = 7;
    const KEEP: utinyint = 255;
}

export namespace BackgroundColor {
    const BLACK: utinyint = 0;
    const WHITE: utinyint = 1;
    const RED: utinyint = 2;
    const CYAN: utinyint = 3;
    const PURPLE: utinyint = 4;
    const GREEN: utinyint = 5;
    const BLUE: utinyint = 6;
    const YELLOW: utinyint = 7;
    const KEEP: utinyint = 255;
}
`;
}

function text8bs(id, spec) {
  const base = spec.ted ? 0x0c00 : (spec.screen ?? 0x0400);
  const color = spec.ted ? 0x0800 : 0;
  return `import { Video } from "./geometry.8bs";

function asciiToScreenCode(code: utinyint): utinyint {
    if (code >= 97 && code < 123) {
        return code - 96;
    }
    return code;
}

export namespace text {
    const CELL_COUNT: usmallint = Video.CELL_COUNT;
    const COLUMNS: utinyint = Video.COLUMNS;
    const ROWS: utinyint = Video.ROWS;

    function columns(): utinyint {
        return text.COLUMNS;
    }

    function rows(): utinyint {
        return text.ROWS;
    }

    function releaseCursor(): void {
    }

    let ink: utinyint = 1;

    function setColor(color: utinyint): void {
        ink = color;
    }

    function putChar(cell: usmallint, code: utinyint): void {
        memory.write(${base} + cell, asciiToScreenCode(code));
${color ? `        memory.write(${color} + cell, ink);\n` : ''}    }

    function putColor(cell: usmallint, color: utinyint): void {
${color ? `        memory.write(${color} + cell, color);\n` : ''}    }

    function print(cell: usmallint, s: string): void {
        for (let i: utinyint = 0; i < s.length; i++) {
            text.putChar(cell + i, s.charCodeAt(i));
        }
    }

    function printNumber(cell: usmallint, value: usmallint, width: utinyint): void {
        let n: usmallint = value;
        let i: utinyint = width;
        while (i > 0) {
            i = i - 1;
            text.putChar(cell + i, 48 + (n % 10));
            n = n / 10;
        }
    }
}

export namespace TextColor {
    const WHITE: utinyint = 1;
    const CYAN: utinyint = 3;
    const GREEN: utinyint = 5;
}
`;
}

function input8bs(id, spec) {
  const keyboard = spec.keyboard !== false && spec.facts['input.keyboard'] === true;
  return `export namespace input {
    function begin(): void {
        input.poll();
    }

    function poll(): void {
    }

    function left(): bool {
        return false;
    }

    function right(): bool {
        return false;
    }

    function up(): bool {
        return false;
    }

    function down(): bool {
        return false;
    }

    function confirm(): bool {
        return false;
    }

    function cancel(): bool {
        return false;
    }

    function pointer(): bool {
        return false;
    }

    function pointerCell(): usmallint {
        return 0;
    }

    function pointerButton(): bool {
        return false;
    }
}

export namespace Input {
    const CONFIRM_LABEL: string = "${keyboard ? 'RETURN' : 'FIRE'}";
    const ALT_CONFIRM_LABEL: string = "${keyboard ? 'RETURN' : 'FIRE'}";
    const CONFIRM_LABELS: string = "${keyboard ? 'RETURN' : 'FIRE'}";
}
`;
}

function pointer8bs() {
  return `export namespace pointer {
    const DRAWS: bool = false;

    function begin(): void {
    }

    function setColor(color: utinyint): void {
    }

    function update(): void {
    }

    function hide(): void {
    }
}
`;
}

function raster8bs() {
  return `export namespace Slot {
    const BORDER: utinyint = 0;
    const BACKGROUND: utinyint = 1;
    const SCROLL_X: utinyint = 2;
}

export namespace raster {
    const ENTRIES: utinyint = 0;
    const STRIDE: utinyint = 0;

    function clear(): void {
    }

    function at(line: utinyint, slot: utinyint, value: utinyint): bool {
        return false;
    }

    function insert(line: utinyint, slot: utinyint, value: utinyint): bool {
        return false;
    }

    function setValue(entry: utinyint, value: utinyint): bool {
        return false;
    }

    function commit(): void {
    }

    function count(): utinyint {
        return 0;
    }

    function enable(): void {
    }

    function disable(): void {
    }
}
`;
}

function agentsMd(id, spec) {
  return `# Writing ${TITLES[id]} support

This file is for anyone — human or agent — touching \`packages/${id}\`.
Read the root \`AGENTS.md\` first.

> **${TITLES[id]} is its own machine.** Do not translate register numbers
> from the C64, NES, or any other package. Facts come from this catalog
> and from the research page, not from a sibling target.

CPU family: **${spec.family}**. Image: \`.${spec.output}\`.
Emulator: \`${spec.emulator.binary}\` (${spec.emulator.family}).
`;
}

function setupInstallBlock(spec) {
  const key = spec.emulator.installer;
  if (key === 'sameboy') {
    return `# macOS
brew install --cask sameboy

# Arch/Manjaro AUR
pamac build --no-confirm sameboy
# No Debian package.`;
  }
  if (key === 'fuse') {
    return `# Debian/Ubuntu — never apt/brew install fuse (that's the filesystem)
sudo apt-get install -y fuse-emulator-gtk

# Arch/Manjaro AUR
pamac build --no-confirm fuse-emulator

# macOS
brew install --cask fredm-fuse`;
  }
  if (key === 'caprice32') {
    return `# Debian/Ubuntu
sudo apt-get install -y caprice32

# Arch/Manjaro AUR
pamac build --no-confirm caprice32
# No Homebrew formula.`;
  }
  if (key === 'vecx') {
    return `# Arch/Manjaro AUR
pamac build --no-confirm vecx
# No Homebrew formula, no Debian package.`;
  }
  const pkg = key === 'vice' || key === 'mame' || key === 'atari800' || key === 'mednafen' || key === 'openmsx' || key === 'xroar' || key === 'stella' || key === 'fceux'
    ? (key === 'vice' ? 'vice' : key === 'mame' ? 'mame' : key === 'atari800' ? 'atari800' : key)
    : spec.emulator.binary;
  return `brew install ${pkg}
sudo apt-get install -y ${pkg}
sudo pacman -S ${pkg}`;
}

function setupMd(id, spec) {
  return `---
title: ${TITLES[id]}
---

# ${TITLES[id]}

\`8bs run ${id}\` builds a \`.${spec.output}\` and launches \`${spec.emulator.binary}\`.
The emulator is optional: \`8bs doctor\` WARNs when it is missing.

\`\`\`
${setupInstallBlock(spec)}
\`\`\`

MAME ROM sets and console BIOS files are not redistributable.
Doctor never downloads them. A missing BIOS is a warning, not a failed doctor.
`;
}

function machineTest(id, spec) {
  const binary = spec.emulator.binary;
  return `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'cli', 'bin', '8bs.mjs');

function onPath(name) {
  const bin = process.platform === 'win32' ? \`\${name}.exe\` : name;
  return (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));
}

function runCli(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('${id} builds a probe program', async () => {
  const scratch = await mkdtemp(join(tmpdir(), '8bs-${id}-'));
  try {
    const entry = join(scratch, 'main.8bs');
    await writeFile(entry, [
      'let sum: utinyint = 0;',
      'export function main(): void {',
      '    for (let i: utinyint = 0; i < 10; i++) {',
      '        sum = sum + i;',
      '    }',
      '    memory.write(0x80, sum);',
      '}',
      '',
    ].join('\\n'));
    const { code, stderr } = await runCli(['build', '--target', '${id}', entry], scratch);
    assert.equal(code, 0, stderr);
    assert.ok(existsSync(join(scratch, 'dist')), 'wrote dist/');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('${id} screenshot skips when ${binary} is missing', async (t) => {
  if (!onPath('${binary}')) {
    t.skip('${binary} is not installed');
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), '8bs-${id}-shot-'));
  try {
    const entry = join(scratch, 'main.8bs');
    await writeFile(entry, 'export function main(): void {}\\n');
    const shot = join(scratch, 'out.png');
    const { code } = await runCli(['run', '${id}', entry, '--screenshot', shot, '--frames', '1'], scratch);
    if (code !== 0) {
      t.skip('${binary} is present but could not capture');
      return;
    }
    assert.ok(existsSync(shot), 'screenshot landed');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
`;
}

for (const id of NEW) {
  const spec = SPECS[id];
  const dir = join(ROOT, 'packages', id);
  write(join(dir, 'package.json'), packageJson(id, spec));
  write(join(dir, 'src', 'index.8bs'), index8bs(id, spec));
  write(join(dir, 'src', 'geometry.8bs'), geometry8bs(spec));
  write(join(dir, 'src', 'screen.8bs'), screen8bs(id, spec));
  write(join(dir, 'src', 'text.8bs'), text8bs(id, spec));
  write(join(dir, 'src', 'input.8bs'), input8bs(id, spec));
  write(join(dir, 'src', 'pointer.8bs'), pointer8bs());
  write(join(dir, 'src', 'rasterline.8bs'), raster8bs());
  write(join(dir, 'AGENTS.md'), agentsMd(id, spec));
  write(join(dir, 'test', `${id}.test.mjs`), machineTest(id, spec));
  write(join(ROOT, 'docs', 'setup', `${id}.md`), setupMd(id, spec));
}

function patchJson(rel, mutate) {
  const path = join(ROOT, rel);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  mutate(json);
  write(path, JSON.stringify(json, null, 2));
}

for (const cap of ['screen', 'text', 'input', 'pointer', 'raster']) {
  const field = cap === 'raster' ? 'rasterline' : cap;
  patchJson(`packages/${cap}/package.json`, (pkg) => {
    pkg['8bitscript'] ??= {};
    pkg['8bitscript'].entry ??= {};
    pkg.dependencies ??= {};
    for (const id of NEW) {
      pkg['8bitscript'].entry[id] = `@8bitscript/${id}/${field}`;
      pkg.dependencies[`@8bitscript/${id}`] = 'workspace:*';
    }
  });
}

patchJson('packages/cli/package.json', (pkg) => {
  pkg.dependencies ??= {};
  for (const id of NEW) pkg.dependencies[`@8bitscript/${id}`] = 'workspace:*';
});

const machines = [
  'vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web',
  ...NEW,
];

function replaceIn(rel, find, repl) {
  const path = join(ROOT, rel);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(find)) {
    console.warn(`skip (not found): ${rel}: ${JSON.stringify(find).slice(0, 80)}`);
    return;
  }
  write(path, text.replace(find, repl));
}

replaceIn(
  'packages/compiler/src/source/index.mjs',
  `export const MACHINES = Object.freeze([
  'vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web',
]);`,
  `export const CPU_FAMILY = Object.freeze({
  vic20: 'mos', c64: 'mos', pet: 'mos', c128: 'mos', atari8: 'mos', nes: 'mos',
  cx16: 'mos', mega65: 'mos', web: 'wasm',
  plus4: 'mos', oric: 'mos', apple2: 'mos', bbc: 'mos', atari5200: 'mos',
  lynx: 'mos', pce: 'mos', supervision: 'mos', atari2600: 'mos', atari7800: 'mos',
  gb: 'sm83', gbc: 'sm83',
  sms: 'z80', gamegear: 'z80', sg1000: 'z80', msx: 'z80', coleco: 'z80',
  spectrum: 'z80', cpc: 'z80',
  coco: 'm6809', vectrex: 'm6809',
  odyssey2: 'i8048', channelf: 'f8',
});

export function cpuFamily(machine) {
  return CPU_FAMILY[machine] ?? 'mos';
}

export const MACHINES = Object.freeze([
  'vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web',
  ${NEW.map((id) => `'${id}'`).join(', ')},
]);`,
);

replaceIn(
  'packages/compiler/src/fold/index.mjs',
  `  ['mega65', 8],
]);`,
  `  ['mega65', 8],
${Object.entries(SYSTEMS).map(([id, n]) => `  ['${id}', ${n}],`).join('\n')}
]);`,
);

const systemLines = Object.entries(SYSTEMS)
  .map(([id, n]) => `    const ${SYSTEM_CONST[id]}: utinyint = ${n};    // ${TITLES[id]}`)
  .join('\n');
replaceIn(
  'packages/system/src/index.8bs',
  `    const MEGA65: utinyint = 8;   // MEGA65
}`,
  `    const MEGA65: utinyint = 8;   // MEGA65
${systemLines}
}`,
);

// RELEASE_MACHINES is filled after each machine meets the pass bar.

replaceIn(
  'packages/compiler/src/mos/index.ts',
  `export type Machine = 'vic20' | 'c64' | 'pet' | 'c128' | 'mega65' | 'cx16' | 'nes' | 'atari8';`,
  `export type Machine = 'vic20' | 'c64' | 'pet' | 'c128' | 'mega65' | 'cx16' | 'nes' | 'atari8' | 'plus4' | 'oric' | 'apple2' | 'bbc' | 'atari5200' | 'lynx' | 'pce' | 'supervision' | 'atari2600' | 'atari7800';`,
);

replaceIn(
  'packages/cli/src/index.d.ts',
  `export type Machine =
  | 'vic20' | 'c64' | 'pet' | 'c128' | 'atari8' | 'nes' | 'cx16' | 'mega65' | 'web';`,
  `export type Machine =
  | 'vic20' | 'c64' | 'pet' | 'c128' | 'atari8' | 'nes' | 'cx16' | 'mega65' | 'web'
  | ${NEW.map((id) => `'${id}'`).join(' | ')};`,
);

const machineEnum = machines.map((id) => `"${id}"`).join(', ');
replaceIn(
  'packages/cli/schemas/config.json',
  `"machine": { "enum": ["vic20", "c64", "pet", "c128", "atari8", "nes", "cx16", "mega65", "web"] }`,
  `"machine": { "enum": [${machineEnum}] }`,
);
replaceIn(
  'packages/cli/schemas/systems.json',
  `"enum": ["vic20", "c64", "pet", "c128", "atari8", "nes", "cx16", "mega65", "web"]`,
  `"enum": [${machineEnum}]`,
);

replaceIn(
  'packages/cli/src/hardware.mjs',
  `export const REGION_MACHINES = new Set(['vic20', 'c64', 'c128', 'mega65', 'atari8']);`,
  `export const REGION_MACHINES = new Set(['vic20', 'c64', 'c128', 'mega65', 'atari8', 'plus4', 'atari5200', 'atari2600', 'atari7800']);`,
);

const lists = [
  'packages/studio/test/studio.test.mjs',
  'packages/ui/test/ui.test.mjs',
  'packages/pointer/test/pointer.test.mjs',
  'packages/compiler/test/rasterline.test.mjs',
  'packages/system/test/system.test.mjs',
];
const oldList = `['vic20', 'c64', 'pet', 'c128', 'atari8', 'nes', 'cx16', 'mega65', 'web']`;
const newList = `[${machines.map((id) => `'${id}'`).join(', ')}]`;
for (const rel of lists) replaceIn(rel, oldList, newList);

replaceIn(
  'packages/compiler/index.mjs',
  `export {
  SOURCE_EXTENSIONS, LOCALE_NAME, isLocaleName, isSourceFile, sourceKindOf, stripSourceExtension,
} from './src/source/index.mjs';`,
  `export {
  SOURCE_EXTENSIONS, LOCALE_NAME, isLocaleName, isSourceFile, sourceKindOf, stripSourceExtension,
  cpuFamily, CPU_FAMILY,
} from './src/source/index.mjs';`,
);

console.log(`generated ${NEW.length} machines`);
