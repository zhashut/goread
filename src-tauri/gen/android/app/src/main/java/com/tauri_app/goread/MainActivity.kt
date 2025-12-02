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
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  
  // Hold reference to the WebView for injecting safe area insets
  private var webViewRef: WebView? = null
  private var currentTop = 0
  private var currentBottom = 0
  private var insetsReady = false
  
  private val requestPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) { permissions ->
    // Handle permission results
    permissions.entries.forEach { entry ->
      val permission = entry.key
      val isGranted = entry.value
      if (!isGranted) {
        // Permission denied, you might want to show a message to the user
        println("Permission $permission denied")
      }
    }
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
    
    // Request storage permissions
    requestStoragePermissions()
  }
  
  // This callback is provided by WryActivity when WebView is created
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webViewRef = webView
    
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
    }
  }
  
  private fun setupWindowInsetsListener() {
    val decorView = window.decorView
    
    ViewCompat.setOnApplyWindowInsetsListener(decorView) { view, insets ->
      val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val density = resources.displayMetrics.density
      
      // Apply bottom padding to the root view so content sits above the navigation bar
      // We keep top padding 0 because we WANT the status bar to overlap (translucent)
      view.setPadding(0, 0, 0, systemBars.bottom)

      // Convert physical pixels to CSS/dp pixels
      val topPx = (systemBars.top / density).toInt()
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
  
  private fun requestStoragePermissions() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      // Android 11+ - Request MANAGE_EXTERNAL_STORAGE
      if (!Environment.isExternalStorageManager()) {
        try {
          val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
          intent.data = Uri.parse("package:$packageName")
          startActivity(intent)
        } catch (e: Exception) {
          val intent = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)
          startActivity(intent)
        }
      }
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      // Android 13+ - Request granular media permissions
      val permissions = arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
        Manifest.permission.READ_MEDIA_AUDIO
      )
      val permissionsToRequest = permissions.filter {
        ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
      }
      if (permissionsToRequest.isNotEmpty()) {
        requestPermissionLauncher.launch(permissionsToRequest.toTypedArray())
      }
    } else {
      // Android 6-12 - Request READ_EXTERNAL_STORAGE
      if (ContextCompat.checkSelfPermission(
          this,
          Manifest.permission.READ_EXTERNAL_STORAGE
        ) != PackageManager.PERMISSION_GRANTED
      ) {
        requestPermissionLauncher.launch(arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE))
      }
    }
  }
}