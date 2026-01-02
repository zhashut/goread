import Foundation
import WebKit
import UniformTypeIdentifiers

class ExternalFileOpenBridge {
    static let shared = ExternalFileOpenBridge()
    
    weak var webView: WKWebView?
    
    // 挂起的文件请求（WebView 未就绪时暂存）
    private var pendingPayload: String?
    
    private init() {}
    
    func setup(webView: WKWebView) {
        self.webView = webView
        
        // 如果有挂起的请求，立即发送
        if let payload = pendingPayload {
            pendingPayload = nil
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                self?.notifyExternalFileOpen(payload)
            }
        }
    }
    
    func handleIncomingFile(url: URL, fromNewIntent: Bool) {
        let fileName = url.lastPathComponent
        let mimeType = getMimeType(for: url)
        
        let payload: [String: Any] = [
            "uri": url.absoluteString,
            "mimeType": mimeType,
            "displayName": fileName,
            "fromNewIntent": fromNewIntent,
            "platform": "ios"
        ]
        
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let jsonString = String(data: data, encoding: .utf8) else {
            return
        }
        
        // 如果 WebView 未就绪，挂起请求
        if webView == nil {
            pendingPayload = jsonString
            return
        }
        
        notifyExternalFileOpen(jsonString)
    }
    
    // 通知前端有外部文件需要打开
    private func notifyExternalFileOpen(_ json: String) {
        let escaped = json
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        
        let js = """
        (function() {
          try {
            var payload = JSON.parse('\(escaped)');
            window.dispatchEvent(new CustomEvent('goread:external-file-open', { detail: payload }));
            console.log('[ExternalOpen:iOS] Payload received');
          } catch (e) {
            console.error('[ExternalOpen:iOS] Invalid payload', e);
          }
        })();
        """
        
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }
    
    // 根据文件扩展名获取 MIME 类型
    private func getMimeType(for url: URL) -> String {
        let ext = url.pathExtension.lowercased()
        
        // 优先使用 UTType（iOS 14+）
        if #available(iOS 14.0, *) {
            if let utType = UTType(filenameExtension: ext),
               let mimeType = utType.preferredMIMEType {
                return mimeType
            }
        }
        
        // 回退到常见格式的硬编码映射
        switch ext {
        case "pdf":
            return "application/pdf"
        case "epub":
            return "application/epub+zip"
        case "md", "markdown":
            return "text/markdown"
        case "html", "htm":
            return "text/html"
        case "txt":
            return "text/plain"
        default:
            return ""
        }
    }
}

