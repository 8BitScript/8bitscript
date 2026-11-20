// Loaded with `node --import <this file>`: installs the front tap's resolve hook.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
