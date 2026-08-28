import { webview } from '@kit.ArkWeb';

const APP_URL: string = 'https://ai.wiseliang.cloud/';

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  @State loading: boolean = true;
  @State progress: number = 0;
  @State failed: boolean = false;
  @State errorText: string = '暂时无法连接掌心助理';
  @StorageLink('sharedUri') sharedUri: string = '';
  @StorageLink('shareRevision') shareRevision: number = 0;

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
