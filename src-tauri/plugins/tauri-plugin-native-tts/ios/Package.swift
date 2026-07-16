// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-native-tts",
  platforms: [
    .iOS(.v14),
  ],
  products: [
    .library(
      name: "tauri-plugin-native-tts",
      type: .static,
      targets: ["tauri-plugin-native-tts"]
    )
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-native-tts",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources"
    )
  ]
)
