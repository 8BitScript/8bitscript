'use strict';

const { copyRuntimeFiles } = require('../src/devReload.cjs');

copyRuntimeFiles(process.cwd());
