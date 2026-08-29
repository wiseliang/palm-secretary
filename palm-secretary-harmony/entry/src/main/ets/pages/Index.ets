import { webview } from '@kit.ArkWeb';
import { fileIo } from '@kit.CoreFileKit';

const APP_URL: string = 'https://ai.wiseliang.cloud/';
const NATIVE_SHARE_PREFIX: string = `${APP_URL}__native_share/`;
const MAX_SHARED_FILE_SIZE: number = 32 * 1024 * 1024;

interface SharedResource {
  id: string;
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State loading: boolean = true;
  @State progress: number = 0;
  @State failed: boolean = false;
  @State errorText: string = '暂时无法连接掌心助理';
  @StorageLink('sharedUri') sharedUri: string = '';
  @StorageLink('shareRevision') @Watch('onShareRevisionChanged') shareRevision: number = 0;
  private sharedResources: Map<string, SharedResource> = new Map<string, SharedResource>();

  private fileName(uri: string): string {
    const rawName = uri.split('/').pop() ?? '分享文件';
    try {
      return decodeURIComponent(rawName) || '分享文件';
    } catch (_) {
      return rawName || '分享文件';
    }
  }

  private mimeType(name: string): string {
    const extension = name.toLowerCase().split('.').pop() ?? '';
    const types: Record<string, string> = {
      'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp',
      'pdf': 'application/pdf', 'txt': 'text/plain', 'md': 'text/markdown', 'json': 'application/json',
      'doc': 'application/msword', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel', 'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ppt': 'application/vnd.ms-powerpoint', 'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'zip': 'application/zip', 'mp3': 'audio/mpeg', 'mp4': 'video/mp4'
    };
    return types[extension] ?? 'application/octet-stream';
  }

  private dispatchSharedFile(): void {
    if (!this.sharedUri) return;
    try {
      const opened = fileIo.openSync(this.sharedUri, fileIo.OpenMode.READ_ONLY);
      const size = fileIo.statSync(opened.fd).size;
      fileIo.closeSync(opened);
      if (size > MAX_SHARED_FILE_SIZE) {
        this.controller.runJavaScript("window.dispatchEvent(new CustomEvent('palm-share-error',{detail:'HarmonyOS 系统分享暂支持最大 32MB，更大文件请在掌心助理内选择上传'}));").catch(() => {});
        return;
      }
      const name = this.fileName(this.sharedUri);
      const id = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      const resource: SharedResource = { id: id, uri: this.sharedUri, name: name, mimeType: this.mimeType(name), size: size };
      this.sharedResources.set(id, resource);
      const payload = JSON.stringify([{ id: id, name: name, mimeType: resource.mimeType, size: size }]);
      this.controller.runJavaScript(`window.__PALM_SHARED_FILES__=${payload};window.dispatchEvent(new CustomEvent('palm-share',{detail:${payload}}));`).catch(() => {});
      this.sharedUri = '';
    } catch (_) {
      this.controller.runJavaScript("window.dispatchEvent(new CustomEvent('palm-share-error',{detail:'无法读取分享文件，请重新分享'}));").catch(() => {});
    }
  }

  private onShareRevisionChanged(): void {
    this.dispatchSharedFile();
  }

  private nativeSharedResponse(url: string): WebResourceResponse | null {
    if (!url.startsWith(NATIVE_SHARE_PREFIX)) return null;
    const id = decodeURIComponent(url.substring(NATIVE_SHARE_PREFIX.length).split('?')[0]);
    const resource = this.sharedResources.get(id);
    const response = new WebResourceResponse();
    if (!resource) {
      response.setResponseData('分享文件已失效');
      response.setResponseMimeType('text/plain');
      response.setResponseCode(404);
      response.setReasonMessage('Not Found');
      response.setResponseIsReady(true);
      return response;
    }
    try {
      const opened = fileIo.openSync(resource.uri, fileIo.OpenMode.READ_ONLY);
      const data = new ArrayBuffer(resource.size);
      fileIo.readSync(opened.fd, data);
      fileIo.closeSync(opened);
      response.setResponseData(data);
      response.setResponseMimeType(resource.mimeType);
      response.setResponseEncoding('binary');
      response.setResponseCode(200);
      response.setReasonMessage('OK');
      response.setResponseIsReady(true);
      return response;
    } catch (_) {
      response.setResponseData('无法读取分享文件');
      response.setResponseMimeType('text/plain');
      response.setResponseCode(500);
      response.setReasonMessage('Read Failed');
      response.setResponseIsReady(true);
      return response;
    }
  }

  private notifyResume(): void {
    this.controller.runJavaScript("window.dispatchEvent(new Event('palm-resume'));").catch(() => {});
  }

  private retry(): void {
    this.failed = false;
    this.loading = true;
    this.controller.loadUrl(APP_URL);
  }

  onPageShow(): void {
    this.notifyResume();
  }

  onBackPress(): boolean {
    if (this.controller.accessBackward()) {
      this.controller.backward();
      return true;
    }
    return false;
  }

  @Builder
  private OfflineView() {
    Column({ space: 14 }) {
      Text('掌')
        .width(52)
        .height(52)
        .textAlign(TextAlign.Center)
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
        .fontColor(Color.White)
        .backgroundColor('#172033')
        .borderRadius(14)
      Text(this.errorText).fontSize(20).fontWeight(FontWeight.Bold).fontColor('#172033')
      Text('请检查网络连接后重试。').fontSize(14).fontColor('#667085')
      Button('重新连接').onClick(() => this.retry()).backgroundColor('#275FC5').fontColor(Color.White)
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
    .padding(28)
    .backgroundColor('#F4F6F9')
  }

  build() {
    Stack({ alignContent: Alignment.Top }) {
      if (this.failed) {
        this.OfflineView()
      } else {
        Web({ src: APP_URL, controller: this.controller })
          .width('100%')
          .height('100%')
          .javaScriptAccess(true)
          .domStorageAccess(true)
          .imageAccess(true)
          .onlineImageAccess(true)
          .fileAccess(false)
          .mixedMode(MixedMode.None)
          .onPageBegin(() => {
            this.loading = true;
            this.failed = false;
          })
          .onProgressChange((event) => {
            this.progress = event.newProgress;
          })
          .onPageEnd(() => {
            this.loading = false;
            this.notifyResume();
            this.dispatchSharedFile();
          })
          .onInterceptRequest((event) => {
            if (!event) return null;
            return this.nativeSharedResponse(event.request.getRequestUrl());
          })
          .onErrorReceive((event) => {
            if (event.request.isMainFrame()) {
              this.loading = false;
              this.failed = true;
              this.errorText = '暂时无法连接掌心助理';
            }
          })
      }
      if (this.loading && !this.failed) {
        Progress({ value: this.progress, total: 100, type: ProgressType.Linear })
          .width('100%')
          .height(2)
          .color('#275FC5')
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F4F6F9')
  }
}
