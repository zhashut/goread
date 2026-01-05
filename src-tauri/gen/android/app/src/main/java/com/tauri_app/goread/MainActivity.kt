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
import android.view.KeyEvent
import android.webkit.WebView
import androidx.documentfile.provider.DocumentFile
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
  
  // Volume key page turn control
  private var volumeKeyEnabled = false
  
  // 外部文件打开挂起数据（在 WebView 尚未就绪时暂存）
  private var pendingOpenFilePayload: String? = null
  
  // SAF 目录选择回调
  private val openDocumentTreeLauncher = registerForActivityResult(
    ActivityResultContracts.OpenDocumentTree()
  ) { uri ->
    val selected = uri?.toString() ?: ""
    if (uri != null) {
      try {
        // 持久化授权以便后续访问
        contentResolver.takePersistableUriPermission(
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        )
      } catch (_: Exception) {}
      savePersistedTreeUri(selected)
    }
    notifySafTreeSelected(selected)
  }
  
  private val requestPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) { permissions ->
    val allGranted = permissions.values.all { it }
    println("[Permission] Results: $permissions, allGranted: $allGranted")

    val finalGranted = checkStoragePermissionInternal()
    println("[Permission] checkStoragePermissionInternal after request: $finalGranted")
    notifyPermissionResult(finalGranted)
  }
  
  // 用于处理 MANAGE_EXTERNAL_STORAGE 权限返回（Android 11+）
  private val manageStorageLauncher = registerForActivityResult(
    ActivityResultContracts.StartActivityForResult()
  ) { _ ->
    val granted = checkStoragePermissionInternal()
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
    
    // 处理通过外部应用打开文件的场景（冷启动）
    handleOpenFileIntent(intent, false)
  }
  
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // 处理通过外部应用打开文件的场景（热启动）
    handleOpenFileIntent(intent, true)
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
    
    // 音量键翻页控制接口
    webView.addJavascriptInterface(VolumeKeyBridge(), "VolumeKeyBridge")
    
    // 存储权限控制接口（供前端按需调用）
    webView.addJavascriptInterface(StoragePermissionBridge(), "StoragePermissionBridge")
    // SAF 文件访问接口（目录选择、扫描与复制）
    webView.addJavascriptInterface(SafBridge(), "SafBridge")
    
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
      
      // Notify JavaScript that VolumeKeyBridge is ready
      webView.postDelayed({
        notifyVolumeKeyBridgeReady()
      }, 200)
      
      // 如果存在挂起的外部文件打开请求，注入到前端
      webView.postDelayed({
        val payload = pendingOpenFilePayload
        if (payload != null) {
          pendingOpenFilePayload = null
          notifyExternalFileOpen(payload)
        }
      }, 300)
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
  
  private fun notifyVolumeKeyBridgeReady() {
    webViewRef?.post {
      val js = """
        (function() {
          window.__VOLUME_KEY_BRIDGE_READY__ = true;
          // Dispatch custom event to notify JavaScript
          if (typeof CustomEvent !== 'undefined') {
            window.dispatchEvent(new CustomEvent('volumeKeyBridgeReady'));
          }
          console.log('[VolumeKey] Android bridge ready');
        })();
      """.trimIndent()
      webViewRef?.evaluateJavascript(js, null)
    }
  }
  
  // 通知前端有外部文件需要临时阅读
  private fun notifyExternalFileOpen(json: String) {
    webViewRef?.post {
      val safe = json.replace("\\", "\\\\").replace("'", "\\'")
      val js = """
        (function() {
          try {
            var payload = JSON.parse('$safe');
            window.dispatchEvent(new CustomEvent('goread:external-file-open', { detail: payload }));
            console.log('[ExternalOpen] Payload received from Android');
          } catch (e) {
            console.error('[ExternalOpen] Invalid payload', e);
          }
        })();
      """.trimIndent()
      webViewRef?.evaluateJavascript(js, null)
    }
  }
  
  // 解析外部文件 Intent，并构造传递给前端的 JSON 数据
  private fun handleOpenFileIntent(intent: Intent?, fromNewIntent: Boolean) {
    if (intent == null) return
    
    val action = intent.action
    if (action != Intent.ACTION_VIEW && action != Intent.ACTION_SEND) {
      return
    }
    
    var uri: Uri? = null
    var mimeType: String? = null
    
    if (action == Intent.ACTION_VIEW) {
      uri = intent.data
      mimeType = intent.type
    } else if (action == Intent.ACTION_SEND) {
      uri = intent.getParcelableExtra(Intent.EXTRA_STREAM)
      mimeType = intent.type
    }
    
    if (uri == null) return
    
    val displayName = queryDisplayName(uri) ?: (uri.lastPathSegment ?: "unknown")
    
    val obj = org.json.JSONObject()
    obj.put("uri", uri.toString())
    obj.put("mimeType", mimeType ?: "")
    obj.put("displayName", displayName)
    obj.put("fromNewIntent", fromNewIntent)
    obj.put("platform", "android")
    
    val json = obj.toString()
    
    if (webViewRef == null) {
      pendingOpenFilePayload = json
    } else {
      notifyExternalFileOpen(json)
    }
  }
  
  // 使用 dispatchKeyEvent 拦截音量键事件（比 onKeyDown 更可靠，特别是在 MIUI 系统上）
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (volumeKeyEnabled) {
      // 只处理按下事件，避免重复触发
      if (event.action == KeyEvent.ACTION_DOWN) {
        when (event.keyCode) {
          KeyEvent.KEYCODE_VOLUME_UP -> {
            notifyVolumeKey("up")
            return true  // 消费事件，阻止系统音量改变
          }
          KeyEvent.KEYCODE_VOLUME_DOWN -> {
            notifyVolumeKey("down")
            return true
          }
        }
      } else if (event.action == KeyEvent.ACTION_UP) {
        // 也拦截抬起事件，防止系统处理
        when (event.keyCode) {
          KeyEvent.KEYCODE_VOLUME_UP, KeyEvent.KEYCODE_VOLUME_DOWN -> {
            return true
          }
        }
      }
    }
    return super.dispatchKeyEvent(event)
  }
  
  // 通知前端音量键事件
  private fun notifyVolumeKey(direction: String) {
    webViewRef?.post {
      val js = """
        (function() {
          if (typeof window.__onVolumeKey__ === 'function') {
            window.__onVolumeKey__('$direction');
          }
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
  
  // 音量键翻页控制接口
  inner class VolumeKeyBridge {
    @android.webkit.JavascriptInterface
    fun setEnabled(enabled: Boolean) {
      runOnUiThread {
        volumeKeyEnabled = enabled
        println("[VolumeKey] Enabled: $enabled")
      }
    }
    
    @android.webkit.JavascriptInterface
    fun isEnabled(): Boolean {
      return volumeKeyEnabled
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
  
  // SAF 桥接：目录选择、扫描与复制
  inner class SafBridge {
    @android.webkit.JavascriptInterface
    fun openDocumentTree() {
      runOnUiThread {
        openDocumentTreeLauncher.launch(null)
      }
    }
    
    @android.webkit.JavascriptInterface
    fun getPersistedTreeUri(): String {
      return loadPersistedTreeUri() ?: ""
    }
    
    @android.webkit.JavascriptInterface
    fun clearPersistedTreeUri(): Boolean {
      return try {
        val prefs = getSharedPreferences("saf_prefs", MODE_PRIVATE)
        prefs.edit().remove("tree_uri").apply()
        true
      } catch (_: Exception) {
        false
      }
    }
    
    @android.webkit.JavascriptInterface
    fun scanTree(uriStr: String) {
      if (uriStr.isBlank()) {
        notifySafScanResult("[]")
        return
      }
      Thread {
        try {
          val uri = Uri.parse(uriStr)
          val arr = scanDocumentTree(uri)
          notifySafScanResult(arr.toString())
        } catch (e: Exception) {
          notifySafScanResult("[]")
        }
      }.start()
    }
    
    @android.webkit.JavascriptInterface
    fun copyToAppDir(uriStr: String): String {
      return try {
        val uri = Uri.parse(uriStr)
        copyDocumentToAppDir(uri) ?: ""
      } catch (_: Exception) {
        ""
      }
    }
  }
  
  // 内部权限检查方法
  // 电子书阅读器需要访问文档文件（PDF/EPUB/TXT），不同 Android 版本的权限机制不同
  private fun checkStoragePermissionInternal(): Boolean {
    return when {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> {
        // Android 11+：只有 MANAGE_EXTERNAL_STORAGE 才能访问任意目录的文档文件
        // 细化媒体权限（READ_MEDIA_*）只能访问媒体文件，无法访问文档
        val hasManageAll = Environment.isExternalStorageManager()
        println("[Permission] Android 11+: MANAGE_EXTERNAL_STORAGE=$hasManageAll")
        hasManageAll
      }
      else -> {
        // Android 6-10：需要同时拥有 READ 和 WRITE 权限
        // 某些设备（如 HarmonyOS）需要显式的 WRITE 权限才能写入公共目录
        @Suppress("DEPRECATION")
        val hasRead = ContextCompat.checkSelfPermission(
          this,
          Manifest.permission.READ_EXTERNAL_STORAGE
        ) == PackageManager.PERMISSION_GRANTED
        @Suppress("DEPRECATION")
        val hasWrite = ContextCompat.checkSelfPermission(
          this,
          Manifest.permission.WRITE_EXTERNAL_STORAGE
        ) == PackageManager.PERMISSION_GRANTED
        println("[Permission] Android 6-10: READ=$hasRead, WRITE=$hasWrite")
        hasRead && hasWrite
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
  
  // SAF：通知目录选择结果
  private fun notifySafTreeSelected(uriStr: String) {
    webViewRef?.post {
      val safe = uriStr.replace("\\", "\\\\").replace("'", "\\'")
      val js = """
        (function() {
          if (typeof window.__onSafTreeSelected__ === 'function') {
            window.__onSafTreeSelected__('$safe');
          }
        })();
      """.trimIndent()
      webViewRef?.evaluateJavascript(js, null)
    }
  }
  
  // SAF：通知扫描结果（JSON 数组字符串）
  private fun notifySafScanResult(json: String) {
    webViewRef?.post {
      val safe = json.replace("\\", "\\\\").replace("'", "\\'")
      val js = """
        (function() {
          if (typeof window.__onSafScanResult__ === 'function') {
            window.__onSafScanResult__('$safe');
          }
        })();
      """.trimIndent()
      webViewRef?.evaluateJavascript(js, null)
    }
  }
  
  // SAF：保存持久化的目录 URI
  private fun savePersistedTreeUri(uriStr: String) {
    try {
      val prefs = getSharedPreferences("saf_prefs", MODE_PRIVATE)
      prefs.edit().putString("tree_uri", uriStr).apply()
    } catch (_: Exception) {}
  }
  
  // SAF：读取持久化的目录 URI
  private fun loadPersistedTreeUri(): String? {
    return try {
      val prefs = getSharedPreferences("saf_prefs", MODE_PRIVATE)
      prefs.getString("tree_uri", null)
    } catch (_: Exception) { null }
  }
  
  // SAF：递归扫描选定目录，返回 JSON 数组
  private fun scanDocumentTree(rootUri: Uri): org.json.JSONArray {
    val root = DocumentFile.fromTreeUri(this, rootUri)
    val results = org.json.JSONArray()
    if (root == null) return results
    val stack = java.util.ArrayDeque<DocumentFile>()
    stack.add(root)
    while (!stack.isEmpty()) {
      val current = stack.removeFirst()
      val children = current.listFiles()
      for (child in children) {
        if (child.isDirectory) {
          stack.add(child)
        } else if (child.isFile) {
          val name = child.name ?: "unknown"
          val uri = child.uri.toString()
          val size = try { child.length() } catch (_: Exception) { 0L }
          val mtime = try { child.lastModified() } catch (_: Exception) { 0L }
          val obj = org.json.JSONObject()
          obj.put("name", name)
          obj.put("path", uri)
          obj.put("type", "file")
          obj.put("size", size)
          obj.put("mtime", mtime)
          results.put(obj)
        }
      }
    }
    return results
  }
  
  // SAF：复制单个文件到应用私有目录，返回目标路径
  private fun copyDocumentToAppDir(uri: Uri): String? {
    val name = queryDisplayName(uri) ?: "imported"
    val baseDir = filesDir.resolve("imports")
    if (!baseDir.exists()) { baseDir.mkdirs() }
    var dest = java.io.File(baseDir, sanitizeFileName(name))
    var index = 1
    while (dest.exists()) {
      val dot = dest.name.lastIndexOf('.')
      val prefix = if (dot > 0) dest.name.substring(0, dot) else dest.name
      val ext = if (dot > 0) dest.name.substring(dot) else ""
      dest = java.io.File(baseDir, "${prefix}(${index})${ext}")
      index++
    }
    return try {
      contentResolver.openInputStream(uri).use { `in` ->
        if (`in` == null) return null
        java.io.FileOutputStream(dest).use { out ->
          val buf = ByteArray(1024 * 64)
          while (true) {
            val r = `in`.read(buf)
            if (r <= 0) break
            out.write(buf, 0, r)
          }
          out.flush()
        }
      }
      dest.absolutePath
    } catch (_: Exception) {
      null
    }
  }
  
  // SAF：查询显示名
  private fun queryDisplayName(uri: Uri): String? {
    return try {
      val cursor = contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)
      if (cursor != null) {
        cursor.use {
          if (it.moveToFirst()) {
            val idx = it.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            if (idx >= 0) return it.getString(idx)
          }
        }
      }
      null
    } catch (_: Exception) { null }
  }
  
  // SAF：文件名清理
  private fun sanitizeFileName(name: String): String {
    return name.replace(Regex("[\\\\/:*?\"<>|]"), "_")
  }

  // 应用生命周期：通知前端应用进入后台
  override fun onPause() {
    super.onPause()
    notifyAppPause()
  }
  
  // 应用生命周期：通知前端应用恢复前台
  override fun onResume() {
    super.onResume()
    notifyAppResume()
  }
  
  private fun notifyAppPause() {
    webViewRef?.post {
      val js = """
        (function() {
          window.dispatchEvent(new CustomEvent('goread:app-pause'));
          console.log('[Lifecycle] App paused');
        })();
      """.trimIndent()
      webViewRef?.evaluateJavascript(js, null)
    }
  }
  
  private fun notifyAppResume() {
    webViewRef?.post {
      val js = """
        (function() {
          window.dispatchEvent(new CustomEvent('goread:app-resume'));
          console.log('[Lifecycle] App resumed');
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
        // Android 11+：必须跳转设置页请求 MANAGE_EXTERNAL_STORAGE 权限
        // 细化媒体权限无法访问文档文件，必须使用全盘访问权限
        try {
          println("[Permission] Android 11+: Opening MANAGE_EXTERNAL_STORAGE settings")
          val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
          intent.data = Uri.parse("package:$packageName")
          manageStorageLauncher.launch(intent)
        } catch (e: Exception) {
          // 部分系统可能不支持直接打开应用权限页，尝试通用设置页
          println("[Permission] Fallback to general MANAGE_ALL_FILES_ACCESS_PERMISSION")
          try {
            val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
            manageStorageLauncher.launch(intent)
          } catch (e2: Exception) {
            println("[Permission] Failed to open settings: $e2")
            notifyPermissionResult(false)
          }
        }
      }
      else -> {
        // Android 6-10：使用运行时权限请求 READ 和 WRITE EXTERNAL_STORAGE
        // 某些设备（如 HarmonyOS）可能需要显式的 WRITE 权限才能写入公共目录
        @Suppress("DEPRECATION")
        val permissionsToRequest = mutableListOf<String>()
        
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_EXTERNAL_STORAGE) 
            != PackageManager.PERMISSION_GRANTED) {
          permissionsToRequest.add(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) 
            != PackageManager.PERMISSION_GRANTED) {
          permissionsToRequest.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
        }
        
        if (permissionsToRequest.isNotEmpty()) {
          println("[Permission] Android 6-10: Requesting ${permissionsToRequest.joinToString()}")
          requestPermissionLauncher.launch(permissionsToRequest.toTypedArray())
        } else {
          notifyPermissionResult(true)
        }
      }
    }
  }
}
