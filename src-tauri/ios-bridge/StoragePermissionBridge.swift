import WebKit

class StoragePermissionBridge: NSObject, WKScriptMessageHandler {
    static let shared = StoragePermissionBridge()
    weak var webView: WKWebView?
    
    func setup(webView: WKWebView) {
        self.webView = webView
        injectJavaScriptInterface()
        webView.configuration.userContentController.add(self, name: "storagePermissionBridge")
    }
    
    private func injectJavaScriptInterface() {
        let js = """
        window.StoragePermissionBridge = {
            requestPermission: function() {
                if (typeof window.__onPermissionResult__ === 'function') {
                    window.__onPermissionResult__(true);
                }
            },
            hasPermission: function() {
                return true;
            }
        };
        """
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }
    
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
    }
}

