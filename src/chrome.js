import {spawn} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
].filter(Boolean);

const PROFILE_DIR = process.env.REPLACER_PROFILE_DIR || join(homedir(), '.cache', 'replacer-profile');

export async function launch() {
  mkdirSync(PROFILE_DIR, {recursive: true});
  rmSync(join(PROFILE_DIR, 'DevToolsActivePort'), {force: true});

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-features=MemorySaver,HighEfficiencyMode',
  ];

  let child, lastErr;
  for (const bin of CANDIDATES) {
    try {
      child = spawn(bin, args, {stdio: 'ignore'});
      await new Promise((ok, fail) => {
        child.once('spawn', ok);
        child.once('error', fail);
      });
      break;
    } catch (e) {
      lastErr = e;
      child = null;
    }
  }
  if (!child) {
    throw new Error(`Could not launch Chrome (set CHROME_PATH). Last error: ${lastErr?.message}`);
  }

  const portFile = join(PROFILE_DIR, 'DevToolsActivePort');
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (port) {
        break;
      }
    } catch {
      /* empty */
    }
    await sleep(50);
  }
  if (!port) {
    child.kill();
    throw new Error('Chrome did not expose DevToolsActivePort');
  }

  const {webSocketDebuggerUrl} = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  return {child, wsUrl: webSocketDebuggerUrl};
}

// Attach to an already-running Chrome (e.g. an Android device reached via
// `adb forward tcp:9222 localabstract:chrome_devtools_remote`). No browser is
// launched or killed; we only borrow its debugging endpoint.
export async function attach(endpoint) {
  const base = new URL(endpoint);
  const {webSocketDebuggerUrl} = await (await fetch(new URL('/json/version', base))).json();
  if (!webSocketDebuggerUrl) {
    throw new Error(`No webSocketDebuggerUrl at ${base.href} — is Chrome running and the port forwarded?`);
  }
  // The device may report a ws host that isn't reachable from here (e.g. its
  // own localhost). Force it through the endpoint we can actually reach.
  const ws = new URL(webSocketDebuggerUrl);
  ws.host = base.host;
  return {child: null, wsUrl: ws.toString()};
}
