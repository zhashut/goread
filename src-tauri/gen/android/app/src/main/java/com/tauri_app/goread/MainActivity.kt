package com.tauri_app.goread

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class MainActivity : TauriActivity() {
  
  // Hold reference to the WebView for injecting safe area insets
  private var webViewRef: WebView? = null
  private var currentTop = 0
  private var currentBottom = 0
  private var insetsReady = false
  
  // Store the initial status bar height (before any hide/show operations)
  // This ensures consistent safe area insets regardless of status bar visibility
  private var initialStatusBarHeight = 0
  private var initialStatusBarHeightCaptured = false
  
  // Status bar controller
  private var windowInsetsController: WindowInsetsControllerCompat? = null
  private var isStatusBarVisible = true  // Default to visible (only hide in Reader page)
  
  private val requestPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) { permissions ->
    // 检查是否所有权限都已授予
    val allGranted = permissions.values.all { it }
    println("[Permission] Results: $permissions, allGranted: $allGranted")
    
    // 回调通知前端权限结果
    notifyPermissionResult(allGranted)
  }
  
  // 用于处理 MANAGE_EXTERNAL_STORAGE 权限返回（Android 11+）
  private val manageStorageLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { _ ->
    // 从设置页面返回后检查权限状态
    val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      Environment.isExternalStorageManager()
    } else {
      true
    }
    println("[Permission] MANAGE_EXTERNAL_STORAGE result: $granted")
    notifyPermissionResult(granted)
  }
  
  override fun onCreate(savedInstanceState: Bundle?) {
    // Enable edge-to-edge with auto-adapting colors
    // Light mode: White navigation bar (with dark icons)
    // Dark mode: Black navigation bar (with light icons)
    enableEdgeToEdge(
      navigationBarStyle = SystemBarStyle.auto(Color.WHITE, Color.BLACK)
    )
    super.onCreate(savedInstanceState)
    
    // Setup WindowInsets listener
    setupWindowInsetsListener()
    
    // 不再在启动时请求权限，改为按需请求（由前端通过 StoragePermissionBridge 触发）
  }
  
  // This callback is provided by WryActivity when WebView is created
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView
    
    // Initialize WindowInsetsController for status bar control
    windowInsetsController = WindowCompat.getInsetsController(window, window.decorView)
    windowInsetsController?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    
    // Expose status bar control functions to JavaScript
    webView.addJavascriptInterface(StatusBarBridge(), "StatusBarBridge")
    
    // 存储权限控制接口（供前端按需调用）
    webView.addJavascriptInterface(StoragePermissionBridge(), "StoragePermissionBridge")
    
    // Default show status bar (only hide when entering Reader page based on user settings)
    windowInsetsController?.show(WindowInsetsCompat.Type.statusBars())
    
    // Don't replace WebViewClient as it would break Tauri's RustWebViewClient
    // Instead, we'll inject CSS variables via WindowInsets listener and periodic refresh
    
    // Inject initial safe area insets when WebView is ready
    webView.post {
      // Re-trigger insets calculation now that WebView is available
      ViewCompat.requestApplyInsets(window.decorView)
      
      // Also inject with a small delay to ensure DOM is ready
      webView.postDelayed({
        if (insetsReady) {
          injectSafeAreaInsets(currentTop, currentBottom)
        }
      }, 100)
      
      // And again after a longer delay for SPA navigation
      webView.postDelayed({
        if (insetsReady) {
          injectSafeAreaInsets(currentTop, currentBottom)
        }
      }, 500)
      
      // Notify JavaScript that StatusBarBridge is ready
      webView.postDelayed({
        notifyBridgeReady()
      }, 200)
    }
  }
  
  private fun notifyBridgeReady() {
    webViewRef?.post {
      val js = """
        (function() {
          window.__STATUS_BAR_BRIDGE_READY__ = true;
          // Dispatch custom event to notify JavaScript
          if (typeof CustomEvent !== 'undefined') {
            window.dispatchEvent(new CustomEvent('statusBarBridgeReady'));
          }
          console.log('[StatusBar] Android bridge ready');
        })();
      """.trimIndent()
      webViewRef?.evaluateJavascript(js, null)
    }
  }
  
  private fun setupWindowInsetsListener() {
    val decorView = window.decorView
    
    ViewCompat.setOnApplyWindowInsetsListener(decorView) { view, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      val density = resources.displayMetrics.density
      
      // Apply bottom padding to the root view so content sits above the navigation bar and IME
      // We keep top padding 0 because we WANT the status bar to overlap (translucent)
      val bottomPadding = kotlin.math.max(systemBars.bottom, ime.bottom)
      view.setPadding(0, 0, 0, bottomPadding)

      // Convert physical pixels to CSS/dp pixels
      val topPxFromInsets = (systemBars.top / density).toInt()
      
      // Capture the initial status bar height when it's visible (before any hide operation)
      // This ensures we always have a consistent safe area inset for TopBar padding
      if (!initialStatusBarHeightCaptured && topPxFromInsets > 0) {
        initialStatusBarHeight = topPxFromInsets
        initialStatusBarHeightCaptured = true
        println("[SafeArea] Captured initial status bar height: ${initialStatusBarHeight}px")
      }
      
      // Use the initial captured height if status bar is hidden (topPxFromInsets would be 0)
      // This ensures TopBar always has correct padding regardless of status bar visibility
      val topPx = if (initialStatusBarHeightCaptured && topPxFromInsets == 0) {
        initialStatusBarHeight
      } else {
        topPxFromInsets
      }
      
      // Since we applied padding for the bottom bar, the safe area inset for bottom is effectively 0
      val bottomPx = 0 

      // Store current values
      currentTop = topPx
      currentBottom = bottomPx
      insetsReady = true
      
      // Inject if WebView is available
      if (webViewRef != null) {
        injectSafeAreaInsets(topPx, bottomPx)
      }
      
      insets
    }
  }
  
  private fun injectSafeAreaInsets(top: Int, bottom: Int) {
    webViewRef?.post {
      // This JS code sets CSS variables and also retries when DOM is ready
      val js = """
        (function() {
          function setSafeArea() {
            if (document.documentElement) {
              document.documentElement.style.setProperty('--safe-area-inset-top', '${top}px');
              document.documentElement.style.setProperty('--safe-area-inset-bottom', '${bottom}px');
              document.documentElement.style.setProperty('--safe-area-inset-left', '0px');
              document.documentElement.style.setProperty('--safe-area-inset-right', '0px');
              console.log('[SafeArea] Insets set: top=${top}px, bottom=${bottom}px');
              return true;
            }
            return false;
          }
          
          // Try to set immediately
          if (!setSafeArea()) {
            // If document not ready, wait for DOMContentLoaded
            document.addEventListener('DOMContentLoaded', setSafeArea);
          }
          
          // Also store in window for later access by JS
          window.__SAFE_AREA_INSETS__ = { top: ${top}, bottom: ${bottom}, left: 0, right: 0 };
        })();
      """.trimIndent()
      webViewRef?.evaluateJavascript(js, null)
    }
  }
  
  // JavaScript Interface for status bar control
  inner class StatusBarBridge {
    @android.webkit.JavascriptInterface
    fun show() {
      runOnUiThread {
        windowInsetsController?.show(WindowInsetsCompat.Type.statusBars())
        isStatusBarVisible = true
        println("[StatusBar] Shown")
      }
    }
    
    @android.webkit.JavascriptInterface
    fun hide() {
      runOnUiThread {
        windowInsetsController?.hide(WindowInsetsCompat.Type.statusBars())
        isStatusBarVisible = false
        println("[StatusBar] Hidden")
      }
    }
    
    @android.webkit.JavascriptInterface
    fun isVisible(): Boolean {
      return isStatusBarVisible
    }
  }
  
  // 存储权限控制 Bridge（供前端按需调用）
  inner class StoragePermissionBridge {
    @android.webkit.JavascriptInterface
    fun requestPermission() {
      runOnUiThread {
        requestStoragePermissions()
      }
    }
    
    @android.webkit.JavascriptInterface
    fun hasPermission(): Boolean {
      return checkStoragePermissionInternal()
    }
  }
  
  // 内部权限检查方法
  private fun checkStoragePermissionInternal(): Boolean {
    return when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> {
        // Android 11+ 必须使用 MANAGE_EXTERNAL_STORAGE 才能访问文档类文件
        Environment.isExternalStorageManager()
      }
      else -> {
        // Android 10 及以下使用 READ_EXTERNAL_STORAGE
        ContextCompat.checkSelfPermission(
          this,
          Manifest.permission.READ_EXTERNAL_STORAGE
        ) == PackageManager.PERMISSION_GRANTED
      }
    }
  }
  
  // 通知前端权限结果
  private fun notifyPermissionResult(granted: Boolean) {
    webViewRef?.post {
      val js = """
        (function() {
          if (typeof window.__onPermissionResult__ === 'function') {
            window.__onPermissionResult__($granted);
          }
        })();
      """.trimIndent()
      webViewRef?.evaluateJavascript(js, null)
    }
  }

  private fun requestStoragePermissions() {
    // 已有权限则直接返回
    if (checkStoragePermissionInternal()) {
      notifyPermissionResult(true)
      return
    }
    
    when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> {
        // Android 11+ 必须使用 MANAGE_EXTERNAL_STORAGE 才能访问文档类文件（PDF/EPUB等）
        // 此权限需要跳转设置页面手动开启
        println("[Permission] Requesting MANAGE_EXTERNAL_STORAGE via settings")
        try {
          val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
          intent.data = Uri.parse("package:$packageName")
          manageStorageLauncher.launch(intent)
        } catch (e: Exception) {
          val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
          manageStorageLauncher.launch(intent)
        }
      }
      else -> {
        // Android 6-10 使用 READ_EXTERNAL_STORAGE（会触发系统原生弹窗）
        if (ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.READ_EXTERNAL_STORAGE
          ) != PackageManager.PERMISSION_GRANTED
        ) {
          println("[Permission] Requesting Android 6-10 READ_EXTERNAL_STORAGE")
          requestPermissionLauncher.launch(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE))
        } else {
          notifyPermissionResult(true)
        }
      }
    }
  }
}