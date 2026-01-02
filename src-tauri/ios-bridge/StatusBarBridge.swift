import UIKit
import WebKit

class StatusBarBridge: NSObject {
    static let shared = StatusBarBridge()
    weak var webView: WKWebView?
    private(set) var isHidden = false
    
    func setup(webView: WKWebView) {
        self.webView = webView
        injectJavaScriptInterface()
        notifyBridgeReady()
    }
    
    private func injectJavaScriptInterface() {
        let js = """
        window.StatusBarBridge = {
            show: function() {
                window.webkit.messageHandlers.statusBarBridge.postMessage({action: 'show'});
            },
            hide: function() {
                window.webkit.messageHandlers.statusBarBridge.postMessage({action: 'hide'});
            },
            isVisible: function() {
                return !\(isHidden);
            }
        };
        window.__STATUS_BAR_BRIDGE_READY__ = true;
        window.dispatchEvent(new Event('statusBarBridgeReady'));
        """
        webView?.evaluateJavaScript(js, completionHandler: nil)
        webView?.configuration.userContentController.add(self, name: "statusBarBridge")
    }
    
    private func notifyBridgeReady() {
        print("[StatusBar:iOS] Bridge ready")
    }
    
    func show() {
        isHidden = false
        updateStatusBarAppearance()
    }
    
    func hide() {
        isHidden = true
        updateStatusBarAppearance()
    }
    
    private func updateStatusBarAppearance() {
        DispatchQueue.main.async {
            if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
               let rootViewController = windowScene.windows.first?.rootViewController {
                rootViewController.setNeedsStatusBarAppearanceUpdate()
            }
        }
    }
}

extension StatusBarBridge: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "statusBarBridge",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }
        
        DispatchQueue.main.async { [weak self] in
            switch action {
            case "show":
                self?.show()
            case "hide":
                self?.hide()
            default:
                break
            }
        }
    }
}

