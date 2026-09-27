// swift-tools-version:5.3
import PackageDescription

let package = Package(
  name: "tauri-plugin-papertrail-reader",
  platforms: [.iOS(.v13)],
  products: [
    .library(name: "tauri-plugin-papertrail-reader", type: .static,
      targets: ["tauri-plugin-papertrail-reader"])
  ],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [
    .target(name: "tauri-plugin-papertrail-reader", dependencies: [.byName(name: "Tauri")],
      path: "Sources")
  ]
)
