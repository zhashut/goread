import UIKit
import WebKit

class SafeAreaBridge {
    static let shared = SafeAreaBridge()
    weak var webView: WKWebView?
    
    func setup(webView: WKWebView) {
        self.webView = webView
        injectSafeAreaInsets()
    }
    
    func injectSafeAreaInsets() {
        guard let webView = webView else { return }
        
        let insets = webView.safeAreaInsets
        let top = Int(insets.top)
        let bottom = Int(insets.bottom)
        let left = Int(insets.left)
        let right = Int(insets.right)
        
        let js = """
        (function() {
            document.documentElement.style.setProperty('--safe-area-inset-top', '\(top)px');
            document.documentElement.style.setProperty('--safe-area-inset-bottom', '\(bottom)px');
            document.documentElement.style.setProperty('--safe-area-inset-left', '\(left)px');
            document.documentElement.style.setProperty('--safe-area-inset-right', '\(right)px');
            window.__SAFE_AREA_INSETS__ = { top: \(top), bottom: \(bottom), left: \(left), right: \(right) };
            console.log('[SafeArea:iOS] Insets set: top=\(top)px, bottom=\(bottom)px');
        })();
        """
        
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}

