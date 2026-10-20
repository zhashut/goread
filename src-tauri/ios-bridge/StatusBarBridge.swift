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

    func setup(webView: WKWebView) {
        self.webView = webView
        wrapRootViewController()
        injectJavaScriptInterface()
        notifyBridgeReady()
    }

    // MARK: - 根视图控制器包装（使 prefersStatusBarHidden 生效）

    /// 把 window 的根 VC 用 StatusBarAwareViewController 包一层。
    /// 采用"保留旧 VC 作为 child 子 VC"的方式，不影响已有 VC 的功能与层级。
    private func wrapRootViewController() {
        guard !rootVCWrapped else { return }
        guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = windowScene.windows.first,
              let currentRoot = window.rootViewController else { return }

        // 已经是我们自己的容器，或当前 VC 已经自己实现了状态栏隐藏，则跳过
        if currentRoot is StatusBarAwareViewController { rootVCWrapped = true; return }

        let container = StatusBarAwareViewController(statusBarBridge: self)
        container.view.frame = currentRoot.view.bounds
        container.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        // 迁移旧的根 VC 为容器 child
        container.addChild(currentRoot)
        container.view.addSubview(currentRoot.view)
        currentRoot.didMove(toParent: container)

        // 新的根
        window.rootViewController = container
        rootVCWrapped = true
    }

    /// 状态栏更新（改变 isHidden 后由本方法触发重新求值）
    private func applyStatusBarUpdate() {
        DispatchQueue.main.async {
            guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
                  let rootVC = windowScene.windows.first?.rootViewController else { return }
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
