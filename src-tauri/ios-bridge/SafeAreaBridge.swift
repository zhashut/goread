import UIKit
import WebKit

/// iOS 安全区桥。
///
/// 对齐前端（layout.ts）：前端 iOS 分支**只用标准 CSS `env(safe-area-inset-top/bottom, 0px)`**
/// 读取安全区（见 getSafeAreaInsets()），并不读取 `window.__SAFE_AREA_INSETS__`，也不依赖注入的
/// CSS 变量。`__SAFE_AREA_INSETS__` 是 Android 专属（MainActivity.kt）。
///
/// 因此 iOS 安全区的**主路径**是 WebKit 自动求值 `env()`，前置条件仅为 HTML 的
/// `<meta name="viewport" content="...viewport-fit=cover">`（前端 index.html 已具备，
/// WebKit 据此把页面延伸到刘海屏并把 safe-area env() 变为非零），无需任何 JS 注入。
///
/// 本桥仅作为**保险层**：把 `webView.safeAreaInsets` 写入与 Android 相同的
/// `--safe-area-inset-*` CSS 变量，并在横竖屏旋转（viewport 尺寸变化）时刷新，
/// 供前端将来若读这些变量时也能拿到值；它不是 iOS 前端的主依赖。
///
/// 注意：不要向 iOS 注入 Android 专属的 `window.__SAFE_AREA_INSETS__`，以免误导消费方。
class SafeAreaBridge {
    static let shared = SafeAreaBridge()
    weak var webView: WKWebView?

    func setup(webView: WKWebView) {
        self.webView = webView
        // 安全区随界面方向/尺寸变化而变，监听尺寸变化以在旋转时刷新
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleViewportChange),
            name: NSNotification.Name("UIDeviceOrientationDidChangeNotification"),
            object: nil
        )
        injectSafeAreaInsets()
    }

    @objc private func handleViewportChange() {
        // 旋转动画结束后 webView.safeAreaInsets 才稳定，延迟到主线程下一帧取
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.injectSafeAreaInsets()
        }
    }

    func injectSafeAreaInsets() {
        guard let webView = webView else { return }

        let insets = webView.safeAreaInsets
        let top = Int(insets.top.rounded())
        let bottom = Int(insets.bottom.rounded())
        let left = Int(insets.left.rounded())
        let right = Int(insets.right.rounded())

        let js = """
        (function() {
            function apply() {
                if (!document.documentElement) return false;
                document.documentElement.style.setProperty('--safe-area-inset-top', '\(top)px');
                document.documentElement.style.setProperty('--safe-area-inset-bottom', '\(bottom)px');
                document.documentElement.style.setProperty('--safe-area-inset-left', '\(left)px');
                document.documentElement.style.setProperty('--safe-area-inset-right', '\(right)px');
                return true;
            }
            if (!apply()) {
                document.addEventListener('DOMContentLoaded', apply);
            }
        })();
        """
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
