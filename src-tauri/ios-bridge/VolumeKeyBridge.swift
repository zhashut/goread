/**
 * VolumeKeyBridge.swift
 * iOS 音量键翻页桥接实现
 * 
 * 使用说明：
 * 1. 将此文件添加到 iOS 项目中
 * 2. 在 AppDelegate 或 SceneDelegate 中初始化 VolumeKeyBridge
 * 3. 需要配合 WKWebView 使用
 * 
 * 注意：此实现监听系统音量变化，不会拦截音量 HUD 显示
 * 如需完全拦截音量键（无 HUD），需使用 MPVolumeView 隐藏方案
 */

import UIKit
import AVFoundation
import MediaPlayer
import WebKit

class VolumeKeyBridge: NSObject {
    
    // 单例
    static let shared = VolumeKeyBridge()
    
    // WebView 引用（弱引用避免循环引用）
    weak var webView: WKWebView?
    
    // 启用状态
    private var isVolumeKeyEnabled = false
    
    // 记录上一次音量值，用于判断音量变化方向
    private var lastVolume: Float = 0.5
    
    // 隐藏的 MPVolumeView（用于拦截音量 HUD）
    private var hiddenVolumeView: MPVolumeView?
    
    // 音量变化观察者
    private var volumeObserver: NSKeyValueObservation?
    
    private override init() {
        super.init()
    }
    
    // MARK: - 公开接口
    
    /// 初始化桥接，需传入 WKWebView 实例
    func setup(webView: WKWebView) {
        self.webView = webView
        
        // 配置音频会话
        setupAudioSession()
        
        // 创建隐藏的音量视图（可选，用于隐藏音量 HUD）
        setupHiddenVolumeView()
        
        // 注入 JavaScript 接口
        injectJavaScriptInterface()
        
        // 获取初始音量
        lastVolume = AVAudioSession.sharedInstance().outputVolume
        
        // 开始监听音量变化
        startVolumeObservation()
        
        // 通知前端桥接已就绪
        notifyBridgeReady()
    }
    
    /// 设置启用状态
    func setEnabled(_ enabled: Bool) {
        isVolumeKeyEnabled = enabled
        
        if enabled {
            // 启用时，记录当前音量
            lastVolume = AVAudioSession.sharedInstance().outputVolume
        }
    }
    
    /// 获取启用状态
    func getEnabled() -> Bool {
        return isVolumeKeyEnabled
    }
    
    /// 清理资源
    func cleanup() {
        volumeObserver?.invalidate()
        volumeObserver = nil
        hiddenVolumeView?.removeFromSuperview()
        hiddenVolumeView = nil
    }
    
    // MARK: - 私有方法
    
    /// 配置音频会话
    private func setupAudioSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, options: .mixWithOthers)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            print("[VolumeKey:iOS] Failed to setup audio session: \(error)")
        }
    }
    
    /// 创建隐藏的音量视图（隐藏系统音量 HUD）
    private func setupHiddenVolumeView() {
        // 创建一个在屏幕外的 MPVolumeView
        let volumeView = MPVolumeView(frame: CGRect(x: -1000, y: -1000, width: 1, height: 1))
        volumeView.alpha = 0.01
        
        // 添加到窗口
        if let window = UIApplication.shared.windows.first {
            window.addSubview(volumeView)
        }
        
        hiddenVolumeView = volumeView
    }
    
    /// 注入 JavaScript 接口
    private func injectJavaScriptInterface() {
        guard let webView = webView else { return }
        
        // 注入 VolumeKeyBridge 对象
        let js = """
        window.VolumeKeyBridge = {
            _enabled: false,
            setEnabled: function(enabled) {
                this._enabled = enabled;
                window.webkit.messageHandlers.volumeKeyBridge.postMessage({
                    action: 'setEnabled',
                    value: enabled
                });
            },
            isEnabled: function() {
                return this._enabled;
            }
        };
        window.__VOLUME_KEY_BRIDGE_READY__ = true;
        window.dispatchEvent(new Event('volumeKeyBridgeReady'));
        """
        
        webView.evaluateJavaScript(js) { _, error in
            if let error = error {
                print("[VolumeKey:iOS] Failed to inject JS interface: \(error)")
            }
        }
        
        // 添加消息处理器
        webView.configuration.userContentController.add(self, name: "volumeKeyBridge")
    }
    
    /// 开始监听音量变化
    private func startVolumeObservation() {
        volumeObserver = AVAudioSession.sharedInstance().observe(
            \.outputVolume,
            options: [.new, .old]
        ) { [weak self] session, change in
            self?.handleVolumeChange(session.outputVolume)
        }
    }
    
    /// 处理音量变化
    private func handleVolumeChange(_ newVolume: Float) {
        guard isVolumeKeyEnabled else { return }
        
        let direction: String
        if newVolume > lastVolume {
            direction = "up"
        } else if newVolume < lastVolume {
            direction = "down"
        } else {
            return // 音量未变化
        }
        
        // 记录当前音量
        lastVolume = newVolume
        
        // 调用前端回调
        notifyVolumeKey(direction: direction)
        
        // 可选：恢复原音量（真正拦截音量变化）
        // restoreVolume()
    }
    
    /// 恢复音量（可选，用于真正拦截音量键）
    private func restoreVolume() {
        // 通过 MPVolumeView 的滑块设置音量
        if let slider = hiddenVolumeView?.subviews.first(where: { $0 is UISlider }) as? UISlider {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { [weak self] in
                slider.value = self?.lastVolume ?? 0.5
            }
        }
    }
    
    /// 通知前端音量键事件
    private func notifyVolumeKey(direction: String) {
        let js = "window.__onVolumeKey__ && window.__onVolumeKey__('\(direction)');"
        
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js) { _, error in
                if let error = error {
                    print("[VolumeKey:iOS] Failed to notify volume key: \(error)")
                }
            }
        }
    }
    
    /// 通知前端桥接已就绪
    private func notifyBridgeReady() {
        print("[VolumeKey:iOS] Bridge ready")
    }
}

// MARK: - WKScriptMessageHandler

extension VolumeKeyBridge: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "volumeKeyBridge",
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            return
        }
        
        switch action {
        case "setEnabled":
            if let enabled = body["value"] as? Bool {
                setEnabled(enabled)
            }
        default:
            break
        }
    }
}

// MARK: - 使用示例
/*
 
 在 AppDelegate 或 SceneDelegate 中：
 
 class AppDelegate: UIResponder, UIApplicationDelegate {
     func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
         // ... 其他初始化代码
         return true
     }
 }
 
 在创建 WKWebView 后：
 
 let webView = WKWebView(frame: .zero, configuration: config)
 VolumeKeyBridge.shared.setup(webView: webView)
 
 在 App 退出或 WebView 销毁时：
 
 VolumeKeyBridge.shared.cleanup()
 
 */
