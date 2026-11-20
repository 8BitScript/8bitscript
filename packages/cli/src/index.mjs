// The programmatic face of @8bitscript/cli: what a project's
// 8bitscript.config.ts imports.
//
//     import { defineConfig } from '@8bitscript/cli';
//     export default defineConfig({ programs: { main: { entry: 'src/main.8bs' } } });
//
// defineConfig returns what it is given. It exists so an editor can type
// the object (src/index.d.ts) and so the config's shape has one name; a
// plain `export default { … }` is still a config. Validation is the CLI's
// job at load time (programs.mjs, hardware.mjs, systems.mjs), not this
// function's, because a config is read by more than one command and each
// wants to say what is wrong in its own terms.

/**
 * @template {import('./index.d.ts').ProjectConfig} T
 * @param {T} config
 * @returns {T}
 */
export function defineConfig(config) {
  return config;
}
