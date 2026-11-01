import UIKit
import WebKit

/// iOS 状态栏桥。
///
/// 对齐前端（statusBarService.ts）：前端 iOS 与 Android 共用同一桥契约，无 iOS 专属分支。
/// 前端期望：
///   - `window.StatusBarBridge`（show()/hide()/isVisible()）
///   - ready 标志 `window.__STATUS_BAR_BRIDGE_READY__ = true`
///   - 就绪 DOM 事件 `statusBarBridgeReady`
///
/// 对齐 Android（MainActivity.kt）：Android 通过 `windowInsetsController?.show/hide(statusBars())`
/// 真正隐藏/显示状态栏。iOS 没有等价的 WindowInsets 控制器，状态栏显隐的唯一开关是
/// **根视图控制器的 `prefersStatusBarHidden`**。因此仅调 `setNeedsStatusBarAppearanceUpdate()`
/// 是不够的（旧实现隐藏不掉）；本桥把 window 的根 VC 包进一个
/// `StatusBarAwareViewController` 容器，由它按 `isHidden` 返回 `prefersStatusBarHidden`，
/// 从而真正实现隐藏/显示。
class StatusBarBridge: NSObject {
    static let shared = StatusBarBridge()
    weak var webView: WKWebView?
    private(set) var isHidden = false

    /// 是否已执行过根 VC 包装（避免重复包装导致循环嵌套）
    private var rootVCWrapped = false
    /// 包装重试计数（webView 未挂载到 window 时的时序兜底，上限 3 次）
    private var wrapRetryCount = 0

    func setup(webView: WKWebView) {
        self.webView = webView
        // R12/fix4：包装必须延迟到 didFinishLaunching 场景 transition 结束之后。
        // 此前在 tauri setup 同步链（didFinishLaunching → scene transition 事务链
        // 内部）直接对根 VC addChild，iOS 27.0.1 断言抛 NSException → SIGABRT
        // （fix3 真机 88 帧栈实锤崩溃点位于 _UISceneSettingsDiffAction transition
        // 事务链内）。主 runloop 双跳：第一跳出 didFinishLaunching 同步链，第二跳
        // 避开场景 transition 的后续排队工作。injectJavaScriptInterface 不动 UIKit
        // 层级，保持同步无碍。
        DispatchQueue.main.async { [weak self] in
            DispatchQueue.main.async {
                self?.wrapRootViewController()
            }
        }
        injectJavaScriptInterface()
        notifyBridgeReady()
    }

    // MARK: - 根视图控制器包装（使 prefersStatusBarHidden 生效）

    /// 把 window 的根 VC 用 StatusBarAwareViewController 包一层。
    /// 采用"保留旧 VC 作为 child 子 VC"的方式，不影响已有 VC 的功能与层级。
    ///
    /// 执行时机（R12/fix4）：由 setup 经主 runloop 双跳延迟调用——绝不能在
    /// didFinishLaunching 同步链（场景 transition 进行中）执行，iOS 27.0.1 对该
    /// 状态下的根 VC addChild 会抛 UIKit 断言 NSException → SIGABRT（fix3 真机
    /// 88 帧栈实锤）。窗口来源用 `webView.window`（tao 应用窗口）并保留 parent
    /// 防御（T30 加固），对其他异常路径仍然有效。
    ///
    /// R12/fix5：fix4 真机仍崩，syslog 实锤异常为
    /// `UIViewControllerHierarchyInconsistency: adding a root view controller
    /// <TaoUIViewController> as a child of <StatusBarAwareViewController>`。
    /// 根因是 UIKit 断言禁止把"当前 window.rootViewController" addChild 为他人
    /// child（与 parent==nil 断言是两条独立检查，fix4 只防御了后者）。修复：
    /// addChild 前先解除旧根 VC 的 root 身份并摘除其 view，再走标准 VC 迁移四步。
    private func wrapRootViewController() {
        guard !rootVCWrapped else { return }
        // 权威窗口：webView 所属 window。wry iOS 在触发插件 load 前已完成
        // addSubview，正常时序下 webView.window 非空；极端时序（未挂载）延迟重试。
        guard let webView = webView,
              let window = webView.window,
              let currentRoot = window.rootViewController else {
            retryWrapOnNextRunloop()
            return
        }

        // 已经是我们自己的容器，或当前 VC 已经自己实现了状态栏隐藏，则跳过
        if currentRoot is StatusBarAwareViewController { rootVCWrapped = true; return }

        // 防御：UIKit 断言禁止对已有 parent 的 VC 执行 addChild（必抛异常）。
        // 满足此条件说明拿到的不是可包装的应用根 VC，放弃包装并保持功能静默。
        guard currentRoot.parent == nil else {
            rootVCWrapped = true
            NSLog("[StatusBar:iOS] skip wrap: rootVC %@ already has parent: %@",
                  NSStringFromClass(type(of: currentRoot)),
                  NSStringFromClass(type(of: currentRoot.parent!)))
            return
        }

        // R12/fix5：先解除旧根 VC 的 root 身份——root VC 被addChild 为他人 child
        // 会触发 UIViewControllerHierarchyInconsistency 断言（fix5 真机 syslog
        // 实锤）。摘 view + 清 root 后，旧 VC 变为普通无 parent VC，可安全迁移。
        currentRoot.view.removeFromSuperview()
        window.rootViewController = nil

        let container = StatusBarAwareViewController(statusBarBridge: self)
        container.view.frame = window.bounds
        container.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        // 标准迁移四步：addChild → addSubview → didMove(toParent:) → 设新根
        container.addChild(currentRoot)
        container.view.addSubview(currentRoot.view)
        currentRoot.didMove(toParent: container)

        // 新的根（setter 内部会把 container.view addSubview 到 window 并铺满）
        window.rootViewController = container
        rootVCWrapped = true
    }

    /// 下一轮主 runloop 重试包装（webView 尚未挂载到 window 时的时序兜底）。
    /// 最多重试 3 次（约 1-2 帧），仍失败则放弃，避免无限循环。
    private func retryWrapOnNextRunloop() {
        guard wrapRetryCount < 3 else {
            NSLog("[StatusBar:iOS] give up wrap: webView.window still nil after 3 retries")
            rootVCWrapped = true
            return
        }
        wrapRetryCount += 1
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.rootVCWrapped else { return }
            self.wrapRootViewController()
        }
    }

    /// 状态栏更新（改变 isHidden 后由本方法触发重新求值）
    private func applyStatusBarUpdate() {
        DispatchQueue.main.async { [weak self] in
            // 与 wrapRootViewController 同源：webView 所属 window，保证打在应用根 VC 上
            guard let rootVC = self?.webView?.window?.rootViewController else { return }
            rootVC.setNeedsStatusBarAppearanceUpdate()
        }
    }

    // MARK: - 前端接口

    func show() {
        isHidden = false
        applyStatusBarUpdate()
    }

    func hide() {
        isHidden = true
        applyStatusBarUpdate()
    }

    // MARK: - JS 注入

    private func injectJavaScriptInterface() {
        let js = """
        window.StatusBarBridge = {
            _hidden: \(isHidden),
            show: function() {
                this._hidden = false;
                window.webkit.messageHandlers.statusBarBridge.postMessage({action: 'show'});
            },
            hide: function() {
                this._hidden = true;
                window.webkit.messageHandlers.statusBarBridge.postMessage({action: 'hide'});
            },
            isVisible: function() {
                return !this._hidden;
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
}

/// 状态栏感知容器 VC：托管真正的状态栏隐藏状态。
/// 作为 window.rootViewController 时，系统通过它询问 prefersStatusBarHidden；
/// 它把非状态栏相关的接口全部委托给被包装的子 VC。
class StatusBarAwareViewController: UIViewController {
    private weak var bridge: StatusBarBridge?

    init(statusBarBridge: StatusBarBridge) {
        self.bridge = statusBarBridge
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var prefersStatusBarHidden: Bool {
        // 真正的隐藏开关：与 StatusBarBridge 的 isHidden 同步
        return bridge?.isHidden ?? false
    }

    /// 注意：不实现 childForStatusBarHidden，避免系统把状态栏决策委托给被包裹的
    /// Tauri 子 VC（它不知道我们的隐藏状态，会覆盖 prefersStatusBarHidden）。
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        return children.first?.supportedInterfaceOrientations ?? .all
    }

    override var shouldAutorotate: Bool {
        return children.first?.shouldAutorotate ?? true
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
