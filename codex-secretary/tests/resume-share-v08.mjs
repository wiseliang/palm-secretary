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
const serviceWorker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
assert.match(
  serviceWorker,
  /url\.pathname\.startsWith\('\/__native_share\/'\)/,
  'Service Worker 必须绕过 Android 原生分享流，避免请求被发送到公网服务器',
);
assert.match(manifest, /android\.intent\.action\.SEND/, 'Android 必须注册单文件分享');
assert.match(manifest, /android\.intent\.action\.SEND_MULTIPLE/, 'Android 必须注册多文件分享');
assert.match(android, /shouldInterceptRequest/, 'Android 必须提供受控文件流');
assert.match(android, /ServiceWorkerController\.getInstance\(\)\.setServiceWorkerClient/, 'Android 必须同时拦截 Service Worker 发起的原生分享请求');
assert.match(android, /interceptSharedRequest\(request\.getUrl\(\)\)/, 'WebView 与 Service Worker 必须复用同一分享流处理逻辑');
assert.match(android, /dispatchSharedFiles/, 'Android 必须把分享事件交给网页');
assert.match(android, /cacheSharedFile/, 'Android 必须在分享授权失效前复制到私有缓存');
assert.match(android, /new FileInputStream\(shared\.cacheFile\)/, 'WebView 必须读取稳定的私有缓存文件');
assert.match(android, /intent\.getData\(\)/, 'Android 必须兼容通过 Intent.data 分享的文件 URI');
assert.match(android, /MAX_SHARED_FILE_BYTES/, '原生分享必须限制文件大小');
assert.doesNotMatch(android, /openInputStream\(shared\.uri\)/, '网页请求阶段不得继续依赖外部临时 URI');
assert.match(page, /__PALM_SHARE_ERROR__/, '网页必须接收页面加载前发生的原生分享错误');
assert.match(page, /id="share-target-title"/, '外部分享必须先显示目标选择界面');
assert.match(page, /目标项目/, '外部分享必须允许选择项目');
assert.match(page, /目标对话/, '外部分享必须允许选择已有对话或新任务');
assert.match(page, /targetProjectId: shareDialog\.projectId/, '上传请求必须使用用户选择的项目，不能沿用旧项目闭包');
assert.match(page, /setPendingNavigation\(\{[\s\S]{0,180}threadId: shareDialog\.threadId/, '跨项目分享必须精确导航到所选对话');
assert.match(android, /discardSharedFiles/, '取消分享目标选择后必须清理原生私有缓存');
assert.match(page, /discardSharedFiles\?\.\(JSON\.stringify\(\[item\.id\]\)\)/, '只有服务端上传成功后才能确认清理原生缓存');
assert.doesNotMatch(android, /DeletingInputStream/, '读取原生缓存不得立即删除，上传失败必须可以重试');
assert.match(page, /setShareDialog\(\(current\) => current \? \{ \.\.\.current, files: failedFiles \}/, '失败的分享文件必须保留在目标选择界面供重试');
assert.match(android, /palm-resume/, 'Android 恢复时必须触发网页同步');

console.log('PALM_V08_RESUME_SHARE_OK');
