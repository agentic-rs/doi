# iOS build and installation

Papertrail supports iOS 18 and newer. It bundles its interface, PDF.js worker, fonts, and rendering assets, so installed builds do not require a running Vite server. Downloads and remote AI still need a network connection.

## Toolchain

Use macOS with Xcode and its iOS SDK/simulator runtime, Rust, Node.js 22 or newer, and pnpm. Tauri also requires XcodeGen, CocoaPods, and libimobiledevice. These are installed on the development Mac used for this build.

On a fresh checkout:

```sh
pnpm install
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
pnpm tauri ios init
```

The initializer creates `src-tauri/gen/apple/papertrail.xcodeproj`. That project is generated locally and excluded from Git, including local signing settings and build artifacts. The iOS configuration and native plugin sources are tracked. Run the initializer again when starting from a fresh checkout.

The minimum OS is set in `src-tauri/tauri.ios.conf.json`. The reader uses PDF.js's legacy bundle, which includes compatibility polyfills; current PDF.js lists Safari 18+ support for this bundle in its [browser support guide](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported).

## Simulator

Build the Apple Silicon simulator package:

```sh
pnpm ios:sim
```

Output: `src-tauri/gen/apple/build/arm64-sim/Papertrail.app`.

To install and run it on the simulator available on this Mac:

```sh
xcrun simctl bootstatus "iPhone 16" -b
xcrun simctl install "iPhone 16" src-tauri/gen/apple/build/arm64-sim/Papertrail.app
xcrun simctl launch "iPhone 16" app.papertrail.reader
open -a Simulator
```

Use `xcrun simctl list devices available` to choose another simulator. Intel Macs use `pnpm tauri ios build --debug --target x86_64 --no-sign` instead. Simulator packages cannot be installed on a physical iPhone.

## Your iPhone

1. Connect or pair the iPhone with this Mac and trust the Mac on the phone.
2. Add your Apple account in Xcode Settings → Accounts. Open the generated project and select the `papertrail_iOS` target. In Signing & Capabilities, enable automatic signing and select your team. If the bundle identifier is unavailable to your account, change `identifier` in `src-tauri/tauri.conf.json` and regenerate the iOS project.
3. Enable Settings → Privacy & Security → Developer Mode on the iPhone, restart, and confirm when prompted.
4. Select your iPhone as Xcode's destination and run the app. For the Tauri build environment and bundled interface, start Xcode with `pnpm tauri ios run --open`, then press Run. Keep that terminal command running while Xcode builds.

Apple supports a personal Apple account for running your own development app; signing and provisioning must match your account/device. See [Apple's device setup instructions](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices) and [Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).

To export a signed development package from the terminal:

```sh
APPLE_DEVELOPMENT_TEAM=YOUR_TEAM_ID pnpm ios:build
```

The CLI prints the output location. `YOUR_TEAM_ID` is the development team ID shown by your Apple developer account; it is not the certificate fingerprint or the identifier in parentheses beside a certificate name. See [Tauri's signing guide](https://v2.tauri.app/distribute/sign/ios/) for signing setup.

Before exporting for a new phone, perform a build with that phone explicitly selected in Xcode. A generic archive can otherwise create a profile covering only the Mac's “Designed for iPad/iPhone” destination. When building from the terminal, keep `pnpm tauri ios build --debug --open` running, and in another terminal run:

```sh
xcodebuild -project src-tauri/gen/apple/papertrail.xcodeproj \
  -scheme papertrail_iOS -configuration debug -sdk iphoneos \
  -destination 'id=YOUR_IPHONE_UDID' \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID CODE_SIGN_STYLE=Automatic build
```

Then export with `pnpm ios:build`. The selected device must appear in the app's embedded provisioning profile; a valid signature alone does not establish that a particular iPhone can install it.

An exported development IPA installs only on devices covered by its provisioning profile. In Xcode, use Window → Devices and Simulators, select the iPhone, and add the IPA under Installed Apps. Alternatively, install the corresponding signed `.app` directly:

```sh
xcrun devicectl list devices
unzip src-tauri/gen/apple/build/arm64/Papertrail.ipa -d /private/tmp/papertrail-iphone
xcrun devicectl device install app --device DEVICE_ID /private/tmp/papertrail-iphone/Payload/Papertrail.app
```

Use the device identifier from the first command. Direct installation does not publish an app to the App Store or TestFlight. Distribution through those services is a separate signing and submission workflow.

## Packages built on this Mac

- Simulator: `src-tauri/gen/apple/build/arm64-sim/Papertrail.app`, installed and launch-tested on the iPhone 16 simulator.
- iPhone: `src-tauri/gen/apple/build/iphone/Papertrail.ipa`, signed for the paired iPhone 16. Use this package in place of the generic `arm64` path in the installation commands above.
- The current development provisioning profile expires on October 4, 2026. Rebuild and reinstall with renewed provisioning after expiry. This package is not signed for arbitrary other phones.

The physical phone has not been modified or used for interaction testing by this build task.

## Development and storage

`pnpm tauri ios dev` uses Vite for live updates. The Vite configuration follows `TAURI_DEV_HOST` for physical-device development; both devices must reach that address. `pnpm tauri ios run` and the build scripts bundle the production interface instead.

The phone has its own sandboxed library; desktop papers are not automatically copied or synchronized. API keys use the iOS protected Keychain, accessible while the device is unlocked. Annotation exports use the native Files picker and contain the complete JSON sidecar; cancelling the picker leaves the annotations in the app.

For AI, configure an HTTPS endpoint reachable from the phone. `127.0.0.1` on an iPhone refers to the iPhone, not your Mac. The existing provider policy permits HTTP only for loopback addresses, so a Mac's plain HTTP LAN endpoint is not currently accepted.

On a phone, open the library from the top-left button. References and notes occupy the reader area when their panel is open. Long-press PDF text, adjust the native selection handles, and tap “Ask AI or add a note to this passage”. Close the panel to return to reading.
