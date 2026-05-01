#!/usr/bin/env node
import {resolve as resolvePath, dirname, basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {watch} from 'node:fs';
import {launch} from './chrome.js';
import {connect} from './cdp.js';
import {start} from './intercept.js';

const replacePath = process.argv[2];
if (!replacePath) {
  console.error('usage: node src/index.js <replace-module.js>');
  process.exit(1);
}

const abs = resolvePath(replacePath);
const fileUrl = pathToFileURL(abs).href;
const mod = {replace: null, resolve: null};

async function load() {
  try {
    const m = await import(`${fileUrl}?t=${Date.now()}`);
    if (typeof m.replace !== 'function') {
      throw new Error(`'replace' must be a function`);
    }
    mod.replace = m.replace;
    mod.resolve = m.resolve;
    console.log(`loaded ${replacePath}`);
  } catch (e) {
    console.error(`failed to load ${replacePath}: ${e.message}`);
  }
}

await load();
if (!mod.replace) {
  process.exit(1);
}

let timer;
watch(dirname(abs), (_, filename) => {
  if (filename && filename !== basename(abs)) {
    return;
  }
  clearTimeout(timer);
  timer = setTimeout(load, 50);
});

const {child, wsUrl} = await launch();
const cdp = await connect(wsUrl);
await start(cdp, mod);

const shutdown = () => {
  try {
    child.kill();
  } catch {
    /* empty */
  }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', () => process.exit(0));

console.log('Running. Use the Chrome window; Ctrl-C to quit.');
