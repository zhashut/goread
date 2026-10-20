import WebKit
import UIKit

/// iOS 存储权限桥。
///
/// 语义：iOS 采用沙盒模型，App 通过系统文件选择器（UIDocumentPicker）获取文件时
/// 得到的是带沙盒授权的书签/云盘引用，**不需要也不存在** Android 那种"全局存储权限"。
/// 因此这里恒返回"已授权"（`hasPermission() -> true`），并直接回调成功，这是符合
/// iOS 语义的正确行为，不是待办缺陷。
///
/// 对齐前端（storagePermission.ts）：
///   - 前端 `detectPlatform()` 探测的 iOS 全局对象名是 `window.IOSStoragePermissionBridge`
///     （注意与 Android 的 `window.StoragePermissionBridge` 不同），故这里必须注入这个名字。
///   - 前端 `IOSStoragePermissionHandler.checkPermission()/requestPermission()` 恒返回 true，
///     不调用本桥任何方法；本桥提供的 `requestPermission()/hasPermission()` 仅作占位，
///     供前端若走通用调用路径时也能正确工作。
///
/// 说明：不要照搬 Android 的权限弹窗（MainActivity 的 MANAGE_EXTERNAL_STORAGE / 运行时权限），
/// iOS 语义不同。
class StoragePermissionBridge: NSObject {
    static let shared = StoragePermissionBridge()

    func setup(webView: WKWebView) {
        injectJavaScriptInterface(into: webView)
    }

    private func injectJavaScriptInterface(into webView: WKWebView) {
        let js = """
        window.IOSStoragePermissionBridge = {
            requestPermission: function() {
                // iOS 沙盒模型无需权限弹窗，直接回调成功
                if (typeof window.__onPermissionResult__ === 'function') {
                    try {
                        window.__onPermissionResult__(true);
                    } catch (e) {
                        console.error('[StoragePermission:iOS] __onPermissionResult__ failed', e);
                    }
                }
            },
            hasPermission: function() {
                return true;
            }
        };
        console.log('[StoragePermission:iOS] IOSStoragePermissionBridge injected');
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }
}
