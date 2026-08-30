import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const android = await readFile(new URL('../../palm-secretary-android/app/src/main/java/cloud/wiseliang/palmsecretary/MainActivity.java', import.meta.url), 'utf8');
const manifest = await readFile(new URL('../../palm-secretary-android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');

assert.match(css, /\.mobile-tabs \{ position: sticky;/, '移动导航必须 sticky');
assert.match(css, /top: calc\(var\(--mobile-topbar-height\)/, '移动导航必须冻结在顶栏下方');
for (const event of ['visibilitychange', 'focus', 'online', 'pageshow', 'palm-resume']) {
  assert.match(page, new RegExp(event), `缺少前台同步事件 ${event}`);
}
assert.match(page, /window\.setInterval\(syncVisibleView, 4_000\)/, '运行期间需要主动对账');
assert.match(page, /return updated[\s\S]{0,180}\[\s*\.\.\.items/, '漏掉回复首帧时应补建消息');
assert.match(page, /__PALM_SHARED_FILES__/, '网页必须消费原生分享文件');
assert.match(page, /\/__native_share\//, '网页必须读取原生分享流');
assert.match(manifest, /android\.intent\.action\.SEND/, 'Android 必须注册单文件分享');
assert.match(manifest, /android\.intent\.action\.SEND_MULTIPLE/, 'Android 必须注册多文件分享');
assert.match(android, /shouldInterceptRequest/, 'Android 必须提供受控文件流');
assert.match(android, /dispatchSharedFiles/, 'Android 必须把分享事件交给网页');
assert.match(android, /palm-resume/, 'Android 恢复时必须触发网页同步');

console.log('PALM_V08_RESUME_SHARE_OK');
