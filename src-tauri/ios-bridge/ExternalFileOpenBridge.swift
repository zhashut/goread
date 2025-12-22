import Foundation
import WebKit

class ExternalFileOpenBridge {
    static let shared = ExternalFileOpenBridge()
    
    weak var webView: WKWebView?
    
    private init() {}
    
    func setup(webView: WKWebView) {
        self.webView = webView
    }
    
    func handleIncomingFile(url: URL, fromNewIntent: Bool) {
        let fileName = url.lastPathComponent
        let path = url.path
        
        let payload: [String: Any] = [
            "uri": url.absoluteString,
            "mimeType": "",
            "displayName": fileName,
            "fromNewIntent": fromNewIntent,
            "platform": "ios",
            "path": path
        ]
        
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let jsonString = String(data: data, encoding: .utf8) else {
            return
        }
        
        let escaped = jsonString
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        
        let js = """
        (function() {
          try {
            var payload = JSON.parse('\(escaped)');
            window.dispatchEvent(new CustomEvent('goread:external-file-open', { detail: payload }));
          } catch (e) {
            console.error('[ExternalOpen:iOS] Invalid payload', e);
          }
        })();
        """
        
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}

