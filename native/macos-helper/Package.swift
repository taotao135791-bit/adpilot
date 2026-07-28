// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AdPilotNativeHelper",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "adpilot-native-helper", targets: ["AdPilotNativeHelper"])
    ],
    targets: [
        .executableTarget(
            name: "AdPilotNativeHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ImageIO"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("Security")
            ]
        ),
        .testTarget(
            name: "AdPilotNativeHelperTests",
            dependencies: ["AdPilotNativeHelper"]
        )
    ]
)
