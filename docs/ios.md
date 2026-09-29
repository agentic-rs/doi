# iOS build and installation

Papertrail supports iOS 18 and newer. It bundles its interface, PDF.js worker, fonts, and rendering assets, so installed builds do not require a running Vite server. Downloads and remote AI still need a network connection.

## Toolchain

Use macOS with Xcode and its iOS SDK/simulator runtime, Rust 1.90 or newer, Node.js 22.18 or newer, and pnpm. The build launcher uses Node's built-in TypeScript support. Tauri also requires XcodeGen, CocoaPods, and libimobiledevice. These are installed on the development Mac used for this build.

On a fresh checkout:

```sh
pnpm install
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
pnpm ios:init
```

The initializer creates `src-tauri/gen/apple/papertrail.xcodeproj` and prepares this Mac's Node, pnpm, and Rust paths for Xcode's Rust build phase. The generated project, local toolchain environment, signing settings, and build artifacts are excluded from Git. The iOS configuration and native plugin sources are tracked. Run `pnpm ios:init` when starting from a fresh checkout.

The minimum OS is set in `src-tauri/tauri.ios.conf.json`. The reader uses PDF.js's legacy bundle, which includes compatibility polyfills; current PDF.js lists Safari 18+ support for this bundle in its [browser support guide](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported).

A scoped PDF text-stream adapter uses the stream reader API supported by Safari 18 instead of the async iteration required by PDF.js's ordinary text extraction path. It supplies the selectable text layer and bibliography parser without modifying browser stream APIs globally.

The native reader constrains the web view above the docked keyboard while leaving Tauri's host controller full-screen. This prevents input focus from panning the entire workspace and leaving the toolbar off-screen after dismissal. CSS applies safe-area padding once; PDF and Notes panes keep their own scrolling. Revealing a new AI response scrolls only Notes, and the direction button follows screen orientation rather than the keyboard-reduced viewport's aspect ratio.

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
2. From the project directory, run `pnpm ios:open` to open Xcode. Keep that terminal running while using Xcode's Run or Build actions.
3. Add your Apple account in Xcode Settings → Accounts and select the `papertrail_iOS` target. In Signing & Capabilities, enable automatic signing and select your team. If the bundle identifier is unavailable to your account, change `identifier` in `src-tauri/tauri.conf.json` and regenerate the iOS project with `pnpm ios:init`.
4. Enable Settings → Privacy & Security → Developer Mode on the iPhone, restart, and confirm when prompted.
5. Select your iPhone as Xcode's destination and press Run.

`pnpm ios:open` refreshes the existing project's local toolchain environment, bundles the frontend, and starts the Tauri CLI helper before opening Xcode. It does not install or run the app on the phone itself. The helper must remain running while Xcode builds; opening the `.xcodeproj` alone does not provide it. Press Ctrl+C in the terminal when finished. See [Tauri's Xcode workflow](https://v2.tauri.app/develop/#using-xcode-or-android-studio).

The environment hook is also stored in the local XcodeGen configuration, so it survives regeneration of the generated project. Reopening through `pnpm ios:open` leaves your existing signing settings intact.

Apple supports a personal Apple account for running your own development app; signing and provisioning must match your account/device. See [Apple's device setup instructions](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices) and [Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).

To export a signed development package from the terminal:

```sh
APPLE_DEVELOPMENT_TEAM=YOUR_TEAM_ID pnpm ios:build
```

The CLI prints the output location. `YOUR_TEAM_ID` is the development team ID shown by your Apple developer account; it is not the certificate fingerprint or the identifier in parentheses beside a certificate name. See [Tauri's signing guide](https://v2.tauri.app/distribute/sign/ios/) for signing setup.

Before exporting for a new phone, perform a build with that phone explicitly selected in Xcode. A generic archive can otherwise create a profile covering only the Mac's “Designed for iPad/iPhone” destination. When building from the terminal, keep `pnpm ios:open` running, and in another terminal run:

```sh
xcodebuild -project src-tauri/gen/apple/papertrail.xcodeproj \
  -scheme papertrail_iOS -configuration debug -sdk iphoneos \
  -destination 'id=YOUR_IPHONE_UDID' \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID CODE_SIGN_STYLE=Automatic build
```

After the device build finishes, stop `ios:open` with Ctrl+C, then export with `pnpm ios:build`. Use one Tauri iOS command at a time; restart `pnpm ios:open` when returning to Xcode. The selected device must appear in the app's embedded provisioning profile; a valid signature alone does not establish that a particular iPhone can install it.

An exported development IPA installs only on devices covered by its provisioning profile. In Xcode, use Window → Devices and Simulators, select the iPhone, and add the IPA under Installed Apps. Alternatively, install the corresponding signed `.app` directly:

```sh
xcrun devicectl list devices
unzip src-tauri/gen/apple/build/arm64/Papertrail.ipa -d /private/tmp/papertrail-iphone
xcrun devicectl device install app --device DEVICE_ID /private/tmp/papertrail-iphone/Payload/Papertrail.app
```

Use the device identifier from the first command. Direct installation does not publish an app to the App Store or TestFlight. Distribution through those services is a separate signing and submission workflow.

If the phone asks you to trust the developer after installation, open Settings → General → VPN & Device Management, select the signing account under Developer App, and follow the trust prompts. Developer trust and Developer Mode are separate steps; complete whichever the phone requests before reopening Papertrail.

## Xcode build troubleshooting

- **Build Rust Code: `pnpm: command not found`**: Xcode's GUI environment lacks the Node/pnpm paths available in your terminal. Run `pnpm ios:open` from a terminal where pnpm and Rust work; the launcher refreshes the generated project's local environment.
- **CLI options helper unavailable**: the Tauri terminal command has stopped or the project was opened without it. Run `pnpm ios:open` again and keep that terminal running before pressing Run or Build in Xcode.

## Packages built on this Mac

- Simulator: `src-tauri/gen/apple/build/arm64-sim/Papertrail.app`, installed and launch-tested on the iPhone 16 simulator.
- iPhone: `src-tauri/gen/apple/build/iphone/Papertrail.ipa`. Use this package in place of the generic `arm64` path in the installation commands above. Development packages are restricted to the devices covered by their provisioning profile and must be rebuilt and reinstalled when that profile expires.

The simulator build was installed without uninstalling the app, and its cached library survived. Native simulator checks verified the immersive flow with real papers, portrait/landscape changes, reference following, and Back/Forward. The latest landscape changes build successfully for the simulator and a signed physical iPhone target through the live Xcode helper. The earlier exported IPA does not contain these latest changes; use Xcode Run or export a new build. Physical-device installation and interaction testing were not performed for this update.

## Reading on iPhone

Opening a paper from an arXiv ID, the library, or a reference presents its title, full author list, arXiv ID and version, abstract, and the date the local copy was cached. The cached date is not a publication date. Tap **Read paper** or **Resume reading** to close this sheet and read with the PDF filling the screen.

Tap a page to show the reading overlay, then tap again or use its close button to hide it. Scrolling, following a PDF link, and selecting text retain their normal behavior. The overlay provides the library, **Info**, **Refs & notes**, AI settings, and Back/Forward. The bottom PDF controls provide page navigation, zoom, fit width, and PDF rotation.

Use **Landscape** or **Portrait** in the top overlay to switch the viewer's native screen orientation. This is separate from **Rotate clockwise**, which rotates the PDF pages without changing the phone's screen orientation. The reader keeps the current paper and reading location when its viewport changes.

In iPhone landscape, controls fit on one row at each edge and use icons with 44-point tap targets. References and notes appear in a narrower panel beneath the top controls. The system clock and status icons hide in landscape and return in portrait; overlays respect the notch and home indicator in both directions.

Pinch the PDF with two fingers to zoom the document while reading overlays keep their size. A page preview follows your fingers and sharpens after you release.

**Fit page width** remains selected across page and citation jumps, reopening a paper, viewport and orientation changes, and PDF rotation. A PDF link with an explicit zoom level can override this. Pinching or using the + and − controls selects manual zoom. Older saved reading positions retain their numeric zoom until you select **Fit page width**.

Back and Forward return directly to the saved PDF location, including across papers; they do not show the paper information sheet again. Use **Info** whenever you want to revisit the abstract or metadata.

Long-press PDF text, adjust the native selection handles, and tap the floating sparkle icon to ask AI or add a note. Drag the icon to move it out of the way. References and notes open over the reader. Close that panel or hide the reading controls to continue reading. The PDF stays loaded while information and controls are shown.

## Development and storage

`pnpm tauri ios dev` uses Vite for live updates. The Vite configuration follows `TAURI_DEV_HOST` for physical-device development; both devices must reach that address. `pnpm tauri ios run` and the build scripts bundle the production interface instead.

The phone has its own sandboxed library; desktop papers are not automatically copied or synchronized. API keys use the iOS protected Keychain, accessible while the device is unlocked. Annotation exports use the native Files picker and contain the complete JSON sidecar; cancelling the picker leaves the annotations in the app.

For AI, choose a provider in Settings, enter your API key, and load its models or enter a model ID. Tokn's provider components run inside the iPhone app and connect directly to that provider; a gateway on your Mac is not needed. Keys remain in the phone's protected Keychain. See [AI setup](ai.md).

Custom endpoints must use HTTPS when reached over the network. `127.0.0.1` on an iPhone refers to the iPhone, not your Mac. HTTP is accepted only for loopback endpoints.

To open another paper while reading, tap a page to reveal the controls and use the top-left library button.
