#!/usr/bin/env node
// Records a browser walk-through of the running app as an MP4 for PR evidence.
// See docs/how-to/record-pr-video.md.
//
//   npm run demo:record -- scripts/demos/sign-in-page.mjs [--out file.mp4] [--base-url URL] [--headed]
//
// A scenario is a module whose default export is `async (page, { baseUrl, pause }) => {}`.
// Playwright records WebM, then ffmpeg turns it into H.264 MP4 and keeps
// re-encoding until the file is under the size limit (GitHub attachments: 10 MB).
// Videos are written outside the repo by default and are gitignored. Never commit them.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const MAX_BYTES = 9.5 * 1024 * 1024; // keep a margin under GitHub's 10 MB
const VIEWPORT = { width: 1280, height: 720 };

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    'base-url': { type: 'string', default: process.env.DEMO_BASE_URL ?? 'http://localhost:4180' },
    headed: { type: 'boolean', default: false },
  },
});

const scenarioPath = positionals[0];
if (!scenarioPath) {
  console.error('usage: npm run demo:record -- <scenario.mjs> [--out file.mp4] [--base-url URL] [--headed]');
  process.exit(2);
}

if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('ffmpeg with libx264 is required on PATH (apt install ffmpeg).');
  process.exit(2);
}

const { chromium } = await import('playwright-core');
const scenario = (await import(pathToFileURL(resolve(scenarioPath)).href)).default;
if (typeof scenario !== 'function') {
  console.error(`${scenarioPath} must default-export async (page, { baseUrl, pause }) => {}`);
  process.exit(2);
}

const baseUrl = values['base-url'].replace(/\/$/, '');
const workDir = mkdtempSync(join(tmpdir(), 'money-demo-'));
const out = resolve(values.out ?? join(tmpdir(), `${basename(scenarioPath, '.mjs')}-${Date.now()}.mp4`));
mkdirSync(dirname(out), { recursive: true });

let browser;
try {
  browser = await chromium.launch({ headless: !values.headed });
} catch (error) {
  console.error(String(error.message).split('\n')[0]);
  console.error('Install the browser and ffmpeg builds this Playwright version pins:');
  console.error('  npx playwright-core install chromium-headless-shell ffmpeg');
  process.exit(1);
}

const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: workDir, size: VIEWPORT } });
const page = await context.newPage();
const pause = (ms = 800) => page.waitForTimeout(ms);
let failed = false;
try {
  await scenario(page, { baseUrl, pause });
  await pause(1000); // let the last frame settle on screen
} catch (error) {
  failed = true;
  console.error(`Scenario failed: ${error.message}`);
} finally {
  await context.close(); // flushes the WebM
  await browser.close();
}

const webm = readdirSync(workDir).map((f) => join(workDir, f)).find((f) => f.endsWith('.webm') && statSync(f).size > 0);
if (!webm) {
  console.error('No video was recorded.');
  process.exit(1);
}

// Screen recordings compress well. Raise the CRF until the file fits.
for (const crf of [28, 32, 36, 40]) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-r', '25', '-movflags', '+faststart', '-an', out], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('ffmpeg failed');
    process.exit(1);
  }
  if (statSync(out).size <= MAX_BYTES) break;
}
rmSync(workDir, { recursive: true, force: true });

const size = statSync(out).size;
console.log(`${out} (${(size / 1024 / 1024).toFixed(2)} MB)`);
if (size > MAX_BYTES) {
  console.error('Still over 10 MB: shorten the scenario.');
  process.exit(1);
}
process.exit(failed ? 1 : 0);
