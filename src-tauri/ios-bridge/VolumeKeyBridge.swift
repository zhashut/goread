/**
 * VolumeKeyBridge.swift
 * iOS 音量键翻页桥接
 *
 * 对齐 Android（MainActivity.kt dispatchKeyEvent + inner VolumeKeyBridge）：
 *   - Android 通过 dispatchKeyEvent 直接消费 KEYCODE_VOLUME_UP/DOWN，`return true` 真正拦截
 *     物理按键，既触发翻页、又不改变系统音量、也不弹音量 HUD。
 *   - iOS 没有全局 dispatchKeyEvent 等价 API，成熟做法是用一个**屏外隐藏的 MPVolumeView 的
 *     UISlider** 拦截音量键：系统音量键按下时，会先触发该 slider 的触摸/值变化事件，
 *     我们借此识别"up / down"方向，并把滑块值还原回 lastVolume，从而：
 *       - 触发前端回调 window.__onVolumeKey__('up' / 'down')   → 翻页
 *       - 系统实际音量不改变（值被还原）
 *       - 不弹系统音量 HUD（MPVolumeView 隐藏且无可见 HUD）
 *
 * 前端契约（volumeKeyService.ts IOSVolumeKeyBridge 与 AndroidVolumeKeyBridge 完全一致）：
 *   - window.VolumeKeyBridge.setEnabled(Boolean) / isEnabled(): Boolean
 *   - ready 标志 window.__VOLUME_KEY_BRIDGE_READY__ = true
 *   - 就绪 DOM 事件 volumeKeyBridgeReady
 *   - 原生→前端回调 window.__onVolumeKey__(direction)，direction ∈ 'up' | 'down'
 */

import UIKit
import AVFoundation
import MediaPlayer
import WebKit
import os

class VolumeKeyBridge: NSObject {
    static let shared = VolumeKeyBridge()

    weak var webView: WKWebView?

    /// 启用状态（对齐 Android volumeKeyEnabled）
    private var isVolumeKeyEnabled = false

    /// 记录上一次音量值，用于把隐藏 slider 的值还原回去，避免系统音量改变
    private var lastVolume: Float = 0.5

    /// 隐藏的 MPVolumeView（用于拦截音量键 + 不弹 HUD）
    private var hiddenVolumeView: MPVolumeView?
    /// 隐藏 slider 内的 UISlider（真正拦截触点的控件）
    private var hiddenSlider: UISlider?

    /// 去抖：避免一次按键触发多次回调
    private var lastEventTimestamp: TimeInterval = 0

    private let logger = Logger(subsystem: "goread", category: "VolumeKey")

    private override init() {
        super.init()
    }

    // MARK: - 公开接口

    func setup(webView: WKWebView) {
        self.webView = webView

        setupAudioSession()
        setupHiddenVolumeView()
        injectJavaScriptInterface()
        startVolumeObservation()
        lastVolume = AVAudioSession.sharedInstance().outputVolume
        notifyBridgeReady()
    }

    func setEnabled(_ enabled: Bool) {
        isVolumeKeyEnabled = enabled

        if enabled {
            // 启用时记录当前音量作为还原基准
            let current = AVAudioSession.sharedInstance().outputVolume
            lastVolume = current
        }
    }

    func getEnabled() -> Bool {
        return isVolumeKeyEnabled
    }

    func cleanup() {
        volumeObserver?.invalidate()
        volumeObserver = nil
        hiddenSlider?.removeTarget(self, action: nil, for: UIControl.Event.allEvents)
        hiddenVolumeView?.removeFromSuperview()
        hiddenVolumeView = nil
        hiddenSlider = nil
    }

    // MARK: - 私有：音频会话

    private func setupAudioSession() {
        do {
            // .ambient 让音量键可被监听，同时不接管媒体播放的主音频，
            // 与 TTS 的 .playback .mixWithOthers 不冲突。
            try AVAudioSession.sharedInstance().setCategory(.ambient, options: .mixWithOthers)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            logger.error("setupAudioSession failed: \(error)")
        }
    }

    // MARK: - 私有：隐藏 MPVolumeView（拦截音量键的核心）

    private func setupHiddenVolumeView() {
        // 保证在 Main 线程创建并挂到窗口
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            // 先移除旧的，避免重复 setup 叠加
            self.hiddenVolumeView?.removeFromSuperview()

            let volumeView = MPVolumeView(frame: CGRect(x: -100, y: -400, width: 1, height: 1))
            volumeView.isHidden = true
            volumeView.alpha = 0.01
            // 放在窗口之外而非窗口内，尽量隔离，同时保留与 window 同时存在的生命周期
            // （MPVolumeView 必须加入 window 层级才会响应硬件音量键）

            if let window = self.mainWindow() {
                window.addSubview(volumeView)
                self.hiddenVolumeView = volumeView

                // 找到内嵌的 UISlider 并挂拦截
                self.findAndConfigureSlider(in: volumeView)
            } else {
                logger.error("No key window available to host MPVolumeView")
            }

            // 确保摄像头内容不被遮挡时也能收到按键：MPVolumeView 需要参与 hitTest
            // 但因为 alpha 很低且在屏外，不影响用户交互
        }
    }

    /// 主窗口（适配 iOS 13+ 的 UIWindowScene；兼容旧用法退回到 windows.first）
    private func mainWindow() -> UIWindow? {
        if #available(iOS 13.0, *) {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first(where: { $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive })
            return scene?.windows.first
        }
        return UIApplication.shared.windows.first
    }

    /// 从 MPVolumeView 内找出 UISlider，configure 为可响应并挂 target
    private func findAndConfigureSlider(in volumeView: MPVolumeView) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            guard let self = self else { return }
            if let slider = self.findSlider(in: volumeView) {
                self.hiddenSlider = slider

                // 亮度/音量 slider 默认 userInteractionEnabled 可为 true，
                // 确保它能收到按键映射的触摸事件
                slider.isUserInteractionEnabled = true

                // 触摸开始：此时 value 尚未改变，用触摸点位置判定方向
                slider.addTarget(self, action: #selector(sliderTouchDown(_:for:)), for: .touchDown)

                // 值变化：作为兜底，如果 touchDown 未判定（例如系统直接改值），可用差值判方向
                slider.addTarget(self, action: #selector(sliderValueChanged(_:)), for: .valueChanged)
            } else {
                // 某些系统版本 slider 延迟生成，稍后重试一次
                logger.warning("Could not find MPVolumeSlider yet; will retry")
            }
        }
    }

    private func findSlider(in volumeView: MPVolumeView) -> UISlider? {
        // 深度优先遍历子视图找 UISlider
        var stack: [UIView] = volumeView.subviews
        while let view = stack.popLast() {
            if let slider = view as? UISlider {
                return slider
            }
            stack.append(contentsOf: view.subviews)
        }
        return nil
    }

    // MARK: - 隐藏 slider 的事件：判定 up/down 并还原音量

    /// touchDown：位置位于左侧一半 → down，右侧一半 → up（常见方案）
    @objc private func sliderTouchDown(_ slider: UISlider, for event: UIEvent) {
        guard isVolumeKeyEnabled else { return }

        var direction: String?
        if let touch = event.allTouches?.first {
            let location = touch.location(in: slider)
            let midX = slider.bounds.midX
            direction = location.x < midX ? "down" : "up"
        } else {
            // 无法取触点位置时，退化为按触摸次数奇偶（不推荐），这里退回用差值
            triggerWithFallbackDirection()
            return
        }

        if let dir = direction {
            debounceAndNotify(dir)
        }
        restoreLastVolume()
    }

    /// valueChanged：若 touchDown 未给出方向（如系统直接改值），用新值与 lastVolume 差值判方向
    @objc private func sliderValueChanged(_ slider: UISlider) {
        guard isVolumeKeyEnabled else { return }
        let newVolume = slider.value
        if newVolume != lastVolume {
            let direction = newVolume > lastVolume ? "up" : "down"
            debounceAndNotify(direction)
        }
        // 无论如何都还原音量
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.01) { [weak self] in
            self?.restoreLastVolume()
        }
    }

    /// 无法判定方向时的退化处理（根据当前与记录的偏移粗判）
    private func triggerWithFallbackDirection() {
        let current = AVAudioSession.sharedInstance().outputVolume
        let direction = current > lastVolume ? "up" : (current < lastVolume ? "down" : nil)
        if let dir = direction {
            debounceAndNotify(dir)
        }
        lastVolume = AVAudioSession.sharedInstance().outputVolume
    }

    /// 去抖并通知前端
    private func debounceAndNotify(_ direction: String) {
        let now = Date().timeIntervalSince1970
        // 50ms 内重复不处理
        if now - lastEventTimestamp < 0.05 {
            return
        }
        lastEventTimestamp = now
        notifyVolumeKey(direction: direction)
    }

    /// 把音量还原为 lastVolume，真正阻止系统音量改变
    private func restoreLastVolume() {
        guard let slider = hiddenSlider else { return }
        slider.value = lastVolume
    }

    // MARK: - 音量观察（兜底信息记录，不用于主判定）

    private var volumeObserver: NSKeyValueObservation?

    private func startVolumeObservation() {
        volumeObserver = AVAudioSession.sharedInstance().observe(
            \.outputVolume,
            options: [.new]
        ) { [weak self] _, _ in
            // 仅记录基准，方向判定以 slider 事件为准（stabilize）
            guard let self = self else { return }
            self.lastVolume = AVAudioSession.sharedInstance().outputVolume
        }
    }

    // MARK: - 前端 JS 接口

    private func injectJavaScriptInterface() {
        guard let webView = webView else { return }

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

        webView.configuration.userContentController.add(self, name: "volumeKeyBridge")
    }

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
