import Foundation
import Tauri
import UIKit

/// iOS 原生桥接插件。
///
/// 作用：作为 iOS 原生入口载体，在 WKWebView 就绪后把 `src-tauri/ios-bridge/`
/// 下的 5 个桥接（外部文件打开 / 安全区 / 状态栏 / 存储权限 / 音量键）逐个
/// `setup(webView:)` 接上，让前端通过 `window.*` 全局对象直接消费。
///
/// 前端契约（已存在，无需改动）：
///   - ExternalFileOpenBridge  → `goread:external-file-open` 事件（useExternalFileOpen.ts）
///   - SafeAreaBridge          → CSS `env(safe-area-inset-*)`（layout.ts，iOS 主路径）+ `--safe-area-inset-*` 保险
///   - StatusBarBridge         → `window.StatusBarBridge` + `statusBarBridgeReady`
///   - StoragePermissionBridge → `window.IOSStoragePermissionBridge`（storagePermission.ts detectPlatform）
///   - VolumeKeyBridge         → `window.VolumeKeyBridge` + `volumeKeyBridgeReady`
///
/// 注意：本插件依赖 Tauri iOS `Plugin` 基类在 WebView 加载后提供的 `webView`
/// 引用。Tauri 的 `tauri-api`（Swift 包）不在本仓库内，而是由 `tauri ios` 生成
/// 工程时写入各插件 `ios/.tauri/tauri-api`。接入时须以实际解析到的
/// `tauri-api` 中 `Plugin.webView` 的获取时机/名称（可能为 `webView`、`window`
/// 或 `load(webView:)` 回调）为准，必要时微调下面 `wireBridges()` 的触发点。
class IOSBridgePlugin: Plugin {
  private static var openUrlForwardingInstalled = false
  private var wired = false

  /// WebView 就绪后调用开关（具体触发点见文件头注释，接入时核对 tauri-api）。
  func wireBridgesIfReady() {
    guard !wired, let webView = self.webView else { return }
    wired = true

    ExternalFileOpenBridge.shared.setup(webView: webView)
    SafeAreaBridge.shared.setup(webView: webView)
    StatusBarBridge.shared.setup(webView: webView)
    StoragePermissionBridge.shared.setup(webView: webView)
    VolumeKeyBridge.shared.setup(webView: webView)

    installOpenUrlForwardingIfNeeded()
  }

  // MARK: - 外部文件打开：拦截 UIApplicationDelegate 的 openURL

  /// 通过 `imp_implementationWithBlock` + `method_setImplementation`，把 App Delegate 的
  /// `application(_:open:options:)` 实现替换成我们的 block，从而拿到系统外部文件打开意图，
  /// 转发给 `ExternalFileOpenBridge.shared.handleIncomingFile`。
  ///
  /// 为什么选这条路而不是用 UIApplication（非 delegate 定制）：Tauri 生成的 iOS 工程
  /// 没有我们可控制的 AppDelegate，而 `UIApplication.shared.delegate` 一定存在；
  /// 用 block 替换其 `openURL` IMP 是自持、不侵入 Tauri 工程文件的可靠做法。
  private func installOpenUrlForwardingIfNeeded() {
    guard !Self.openUrlForwardingInstalled else { return }
    guard let delegate = UIApplication.shared.delegate else { return }
    Self.openUrlForwardingInstalled = true

    let cls: AnyClass = type(of: delegate)
    let openSelector = #selector(UIApplicationDelegate.application(_:open:options:))
    guard let originalOpenMethod = class_getInstanceMethod(cls, openSelector) else {
      // delegate 未实现该方法：为其动态补一个我们的转发实现（IMP）。
      let imp = imp_implementationWithBlock(Self.blockImplementingOpenURL(original: nil))
      class_addMethod(cls, openSelector, imp, "#@:@@@")
      return
    }

    let newIMP = imp_implementationWithBlock(Self.blockImplementingOpenURL(original: originalOpenMethod))
    method_setImplementation(originalOpenMethod, newIMP)
  }

  private static func blockImplementingOpenURL(
    original: Method?
  ) -> @convention(block) (AnyObject, UIApplication, URL, [UIApplication.OpenURLOptionsKey: Any]) -> Bool {
    return { (selfObj, application, url, options) in
      // 说明：`application(_:open:options:)` 仅在 App 已运行（热启动）时被调用；
      // 冷启动经 `didFinishLaunchingWithOptions` 走另一条路径（本插件暂不拦截）。
      // 因此这里始终是"重新打开已运行 App" → 对齐 Android 的 onNewIntent（fromNewIntent=true）。
      _ = options
      if url.scheme == "file" {
        ExternalFileOpenBridge.shared.handleIncomingFile(url: url, fromNewIntent: true)
      }

      // 调用被替换的原始实现（若存在）
      if let orig = original {
        typealias OpenURLFunc = @convention(c) (AnyObject, Selector, UIApplication, URL, [UIApplication.OpenURLOptionsKey: Any]) -> Bool
        let originalImp = unsafeBitCast(
          method_getImplementation(orig),
          to: OpenURLFunc.self
        )
        let sel = sel_registerName("application:open:options:")
        return originalImp(selfObj, sel, application, url, options)
      }
      return true
    }
  }
}

@_cdecl("init_plugin_ios_bridge")
func initPluginIOSBridge() -> Plugin {
  IOSBridgePlugin()
}
