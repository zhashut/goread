// swift-tools-version:5.3

import PackageDescription

let package = Package(
  name: "tauri-plugin-ios-bridge",
  platforms: [
    .iOS(.v14),
  ],
  products: [
    .library(
      name: "tauri-plugin-ios-bridge",
      type: .static,
      targets: ["tauri-plugin-ios-bridge"]
    )
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-ios-bridge",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources"
    )
  ]
)
