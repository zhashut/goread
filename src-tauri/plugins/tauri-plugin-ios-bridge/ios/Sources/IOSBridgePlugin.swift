import Foundation
import Tauri
import UIKit
import WebKit

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
/// 注意：tauri-api 的 `Plugin` 基类不暴露 `webView` 属性，唯一入口是
/// `load(webview:)` 回调（Tauri 在 WebView 创建后经 `onWebviewCreated` 调用）。
/// 本插件在该回调中缓存 webView 并触发 `wireBridgesIfReady()`。
class IOSBridgePlugin: Plugin {
  private static var openUrlForwardingInstalled = false
  private static var exceptionHandlerInstalled = false
  private var wired = false
  private weak var bridgedWebView: WKWebView?

  /// Tauri 在 WebView 创建后回调（tauri-api `Plugin` 基类唯一入口），
  /// 缓存 webView 并触发接线。
  override public func load(webview: WKWebView) {
    Self.installUncaughtExceptionHandlerIfNeeded()
    bridgedWebView = webview
    wireBridgesIfReady()
  }

  // MARK: - ObjC NSException 取证（R12/fix4）

  /// 未捕获异常处理器：ObjC 层 NSException 不经过 Rust panic hook（lib.rs
  /// install_ios_panic_hook 只覆盖 Rust panic），崩溃 .ips 中仅有 `abort() called`，
  /// 拿不到异常 name/reason。本 handler 在异常 abort 前截获，把 name/reason/调用栈
  /// 写入沙盒 Documents/panic.log（与 Rust panic hook 同文件，AFC 可拉）并 NSLog。
  /// 必须在可能抛异常的启动链（wireBridgesIfReady → StatusBarBridge.setup 的
  /// addChild 包装）之前安装；handler 为 C 函数指针，禁止捕获上下文，全部 IO 失败静默。
  private static func installUncaughtExceptionHandlerIfNeeded() {
    guard !exceptionHandlerInstalled else { return }
    exceptionHandlerInstalled = true
    NSSetUncaughtExceptionHandler { exception in
      let text = """
      [NSException] name=\(exception.name.rawValue)
      reason: \(exception.reason ?? "<nil>")
      stack:
      \(exception.callStackSymbols.joined(separator: "\n"))
      """
      if let home = ProcessInfo.processInfo.environment["HOME"] {
        let path = home + "/Documents/panic.log"
        if !FileManager.default.fileExists(atPath: path) {
          FileManager.default.createFile(atPath: path, contents: nil)
        }
        if let fh = FileHandle(forWritingAtPath: path) {
          fh.seekToEndOfFile()
          fh.write(text.data(using: .utf8) ?? Data())
          try? fh.close()
        }
      }
      NSLog("%@", text)
    }
  }

  func wireBridgesIfReady() {
    guard !wired, let webView = bridgedWebView else { return }
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
