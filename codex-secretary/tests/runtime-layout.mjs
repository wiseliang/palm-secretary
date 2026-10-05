import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const css = (await Promise.all(['globals.css', 'interaction-polish.css'].map(name => readFile(new URL(`../app/${name}`, import.meta.url), 'utf8')))).join('\n');
const browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_EXECUTABLE});
try {
  await mkdir(new URL('./results/runtime-layout/', import.meta.url), {recursive: true});
  const page = await browser.newPage();
  for (const width of [360, 390, 759, 820, 1440]) {
    await page.setViewportSize({width, height: 700});
    await page.setContent(`<style>${css}</style><section class="model-bar open"><label><span>模型</span><select><option>GPT-6.1 Sol</option></select></label><label><span>推理</span><select><option>非常高</option></select></label><button class="model-refresh">↻</button><strong>Root 运维</strong><button class="quiz-assistant-settings"><span>AI 刷题助手</span><small>在其他应用中使用悬浮 AI 解析题目</small><b>设置</b></button></section>`);
    const boxes = await page.locator('.model-bar').evaluate(bar => {
      const rect = element => { const r = element.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}; };
      return {bar:rect(bar),children:[...bar.children].map(rect),button:rect(bar.querySelector('.quiz-assistant-settings')), overflow:document.documentElement.scrollWidth > innerWidth};
    });
    assert.equal(boxes.overflow, false, `horizontal overflow at ${width}`);
    for (const child of boxes.children) assert.ok(child.right <= boxes.bar.right + 1, `control overflow at ${width}`);
    if (width < 760) assert.ok(boxes.button.y >= boxes.children[0].bottom, `quiz entry must occupy second row at ${width}`);
    await page.screenshot({path:new URL(`./results/runtime-layout/${width}.png`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1')});
  }
  console.log('RUNTIME_LAYOUT_OK');
} finally { await browser.close(); }
