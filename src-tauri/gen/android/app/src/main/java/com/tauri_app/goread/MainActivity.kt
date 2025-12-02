package com.tauri_app.goread

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

class MainActivity : TauriActivity() {
  
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
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    
    // Request storage permissions
    requestStoragePermissions()
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