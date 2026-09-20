// The shape of 8bitscript.config.ts. Every key is optional; a config that
// names nothing builds src/main.8bs for every machine this release
// supports. docs/config.md is the prose version of this file.

/** The machines the toolchain knows. */
export type Machine =
  | 'vic20' | 'c64' | 'pet' | 'c128' | 'atari8' | 'nes' | 'cx16' | 'mega65' | 'web';

/** A thing a hand holds, in the program's terms: matched to a machine's control ports, pad ports, keyboard, mouse or paddles. */
export type InputDevice = 'stick' | 'pad' | 'keyboard' | 'mouse' | 'paddles' | 'touch';

/** Fact floors: a count is the least the program needs, a flag must be true. */
export type Requires = Record<string, number | boolean>;

/** Hardware option values, by option id, as `8bs targets` lists them. */
export type HardwareOptions = Record<string, string>;

/** A locale name: two to eight lower-case letters, optionally `-region` (`de`, `pt-br`). Not a machine's name or a hardware tag. */
export type Locale = string;

/** One artifact a release builds for a target: a preset/profile name, or a composed choice. */
export type ReleaseVariant = string | { profile?: string; hardware?: HardwareOptions; locale?: Locale };

export interface TargetConfig {
  /** The project's own stock for this machine — under every profile and `--hardware`. */
  hardware?: HardwareOptions;
  /** Named option sets `--profile` accepts, beside the catalog's presets. */
  profiles?: Record<string, HardwareOptions>;
  /** What `8bs build --release` builds for this machine; one build with the default hardware when absent. */
  release?: ReleaseVariant[];
  /** This machine's locale, over the project's. `--locale` and a release entry's `locale` are nearer still. */
  locale?: Locale;
}

export interface SystemConfig {
  target: Machine;
  profile?: string;
  hardware?: HardwareOptions;
  region?: 'ntsc' | 'pal';
}

/** One program: its own link, from its own `.8bs` entry. The key it sits under is its output stem. */
export interface ProgramConfig {
  /** The `.8bs` file the program starts from. An `.8bx` is refused: it declares composition and is imported. */
  entry: string;
  /** The machines this program builds for — a subset of the project's `targets`. All of them when absent. */
  targets?: Machine[];
  /** Floors this program raises above the project's `requires`; it may not lower one. */
  requires?: Requires;
}

/** One file inside an image: a program by name, or a file by path, with the name it has on the disk. */
export type ImageFile =
  | { program: string; name: string; type?: 'prg' | 'seq' }
  | { path: string; name: string; type?: 'prg' | 'seq' };

/** A disk image: a container over built programs and data, written after `--release` builds them. */
export interface ImageConfig {
  target: Machine;
  /** Per machine: d64/d71/d81 on the Commodores, atr on the Atari. The NES and the web have none. */
  format: 'd64' | 'd71' | 'd81' | 'atr';
  /** The program written first — what `LOAD "*",8,1` loads. */
  boot: string;
  files: ImageFile[];
}

export interface ProjectConfig {
  /**
   * The `.8bs` file a build starts from — the one-program spelling, and
   * `programs: { main: { entry } }` with the entry's filename as the stem.
   * A `.<machine>.8bs` twin beside it is used on that machine. The older
   * per-machine object (`{ default, nes }`) still works.
   */
  entry?: string | ({ default?: string } & Partial<Record<Machine, string>>);
  /** Several programs in one project. Cannot be given together with `entry`. */
  programs?: Record<string, ProgramConfig>;
  /** Disk images over the programs above. Validated today; written by a later release. */
  images?: Record<string, ImageConfig>;
  /** Logical frames per second for `waitFrame()` and `#frames(...)`. Default 60. */
  frameRate?: number;
  /** The machines this project builds for: names, or per-machine hardware, profiles and release variants. */
  targets?: Machine[] | Partial<Record<Machine, TargetConfig>>;
  /** Advertised named machines, for `--system` and the editor's side bar. */
  systems?: Record<string, SystemConfig>;
  /**
   * The system the program is designed on: the build every fact the
   * program tests is true on, so every other build is the same program
   * folded for a machine without some of them. A machine's name (under
   * the project's own hardware for it), a name from `systems`, or a
   * system's shape. `8bs build` and `8bs run` with no target build it;
   * `8bs build --release` says, per build, which tested facts that build
   * is short of. `requires` is the floor; this is the ceiling.
   */
  baseline?: Machine | string | SystemConfig;
  /** Fact floors every program in the project needs. */
  requires?: Requires;
  /**
   * What the program is designed to be played with (`primary`) and what
   * else it plays on (`also`). A preference, not a floor — `requires` is
   * the floor. `8bs targets --reach` says, per machine, whether each
   * device is standard, optional or absent.
   */
  input?: { primary: InputDevice; also?: InputDevice[] };
  /** 8BX settings. `strict: false` turns the ordinary-code lint in `.8bx` files off; the hard rules stay. */
  bx?: { strict?: boolean };
  /**
   * The locale every build is for unless a target, a release entry or
   * `--locale` says otherwise. With one, a file's `.<locale>` twin
   * (`strings.de.8bs`, `strings.pet.de.8bs`) is read where it exists and
   * the artifact's name carries it (`2048-pet-de.prg`); `#locale("de")`
   * folds to true. Without one — the default — no locale's file is read and
   * nothing is named differently, unless `i18n` (or a catalog directory)
   * is present, in which case the build uses `i18n.defaultLocale` (`en`).
   */
  locale?: Locale;
  /**
   * Message catalogs and the locale a catalog project builds for when
   * nothing nearer says otherwise. Catalogs live under `catalog`
   * (`src/i18n/<locale>.8bs`) and are imported as `@8bitscript/i18n/catalog`.
   * A project without this block and without that directory is unchanged:
   * locale stays optional and no catalog is loaded.
   */
  i18n?: I18nConfig;
  /**
   * Import path aliases: `@lib/game/rules.8bs` → `<project>/src/lib/game/rules.8bs`
   * when `@lib` maps to `src/lib`. Keys are single-segment `@` prefixes; values are
   * directories relative to the config file.
   */
  imports?: Record<string, string>;
}

/** Project message catalogs: one `.8bs` file per locale, folded at compile time. */
export interface I18nConfig {
  /** The locale a build uses when nothing nearer names one. Default `'en'`. */
  defaultLocale?: Locale;
  /** Missing keys are taken from this locale's catalog. Default `defaultLocale`. */
  fallbackLocale?: Locale;
  /** Locales this project ships. When set, those files must exist and extras are refused. */
  locales?: Locale[];
  /** Directory of `<locale>.8bs` catalogs. Default `'src/i18n'`. */
  catalog?: string;
  /**
   * How catalog Unicode is lowered into the portable character set.
   * `transliterate` (default) maps Latin extras (`Ü` → `UE`); `strict`
   * refuses any non-portable source character.
   */
  charset?: 'transliterate' | 'strict';
}

/** Returns `config` unchanged; exists to type it. `export default { … }` is still a config. */
export function defineConfig<T extends ProjectConfig>(config: T): T;
