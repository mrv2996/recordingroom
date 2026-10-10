import { existsSync, mkdirSync, openSync, closeSync, statSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appFolder = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://localhost:5173';
const runtimeFolder = join(appFolder, '.sites-runtime');
const logPath = join(runtimeFolder, 'desktop-server.log');
const lockPath = join(runtimeFolder, 'desktop-launch.lock');

function browserPath() {
  const candidates = [
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find(p => existsSync(p));
}

async function serverState() {
  try {
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
    const info = await response.json().catch(() => null);
    if (response.ok && info?.app === 'consulting-voice-coach') return 'ready';
    return 'other';
  } catch (error) {
    const codes = [error.cause?.code, ...(error.cause?.errors || []).map(e => e.code)];
    return codes.includes('ECONNREFUSED') ? 'offline' : 'starting';
  }
}

async function waitForServer() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await serverState();
    if (state === 'ready') return;
    if (state === 'other') throw new Error('Another app is using localhost:5173. Close that app before opening this coach.');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`The coach did not start in time. Details are in ${logPath}`);
}

async function ensureServer() {
  const state = await serverState();
  if (state === 'ready') return;
  if (state === 'other') throw new Error('Another app is using localhost:5173. Close that app before opening this coach.');
  if (state === 'starting') { await waitForServer(); return; }
  mkdirSync(runtimeFolder, { recursive: true });
  // Avoid starting two local servers when the launcher is double-clicked twice.
  if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 150_000) unlinkSync(lockPath);
  let lock;
  try { lock = openSync(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') { await waitForServer(); return; } throw error; }
  try {
    console.log('Starting your local consulting coach…');
    const log = openSync(logPath, 'a');
    try {
      const child = spawn(process.execPath, [join(appFolder, 'scripts', 'run-framework.mjs'), 'dev', '--hostname', 'localhost'], {
        cwd: appFolder, detached: true, windowsHide: true,
        stdio: ['ignore', log, log], env: { ...process.env, PATH: `${dirname(process.execPath)};${process.env.PATH || ''}` },
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } finally { closeSync(log); }
    await waitForServer();
  } finally { closeSync(lock); if (existsSync(lockPath)) unlinkSync(lockPath); }
}

try {
  if (process.platform !== 'win32') throw new Error('This launcher is for Windows. Use npm run dev on other platforms.');
  if (!existsSync(join(appFolder, 'node_modules', 'vinext'))) throw new Error('The project dependencies are missing. Run npm install in the work folder first.');
  const browser = browserPath();
  if (!browser && !process.argv.includes('--no-open')) throw new Error(`Microsoft Edge or Chrome was not found. Open ${origin} in your browser after starting the local server.`);
  await ensureServer();
  console.log(`Consulting coach ready at ${origin}`);
  if (process.argv.includes('--no-open')) {
    console.log(`Desktop browser available: ${Boolean(browser)}`);
  } else {
    const child = spawn(browser, [`--app=${origin}/`], { detached: true, windowsHide: false, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  }
} catch (error) {
  console.error(error.message || 'The coach could not be opened.');
  process.exitCode = 1;
}
