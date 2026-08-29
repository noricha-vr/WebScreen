// PoC: Chrome を起動して WHIP publisher ページを開き、指定秒数だけ配信を維持する。
// 使い方: node run-publisher.mjs <秒数> [kbps]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkg = require('../../../web/node_modules/@playwright/test');
const { chromium } = pkg;

const secs = parseInt(process.argv[2] || '60', 10);
const kbps = process.argv[3] || '2000';
const extra = process.argv[4] || '';
const path = process.argv[5] || 'test';
const url = `http://localhost:28080/whip-publisher.html?whip=http://localhost:28889/live/${path}/whip&kbps=${kbps}${extra}`;

const browser = await chromium.launch({
  channel: 'chrome',            // 実物の Google Chrome（H.264 エンコーダを持つ）
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('console', m => { const t = m.text(); if (t.startsWith('[whip]')) console.log(t); });
await page.goto(url);
console.log(`publishing for ${secs}s (kbps=${kbps})`);
await page.waitForTimeout(secs * 1000);
await browser.close();
console.log('publisher stopped');
