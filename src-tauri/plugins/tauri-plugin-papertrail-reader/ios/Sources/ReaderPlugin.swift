import Tauri
import UIKit
import WebKit

private enum ReaderOrientation: String, Decodable {
  case portrait
  case landscape

  var mask: UIInterfaceOrientationMask {
    self == .portrait ? .portrait : .landscape
  }

  func matches(_ orientation: UIInterfaceOrientation) -> Bool {
    self == .portrait ? orientation == .portrait : orientation.isLandscape
  }
}

private struct OrientationOptions: Decodable {
  let orientation: ReaderOrientation
}

private struct OrientationRequest {
  let request_id: UUID
  let invoke: Invoke
  let orientation: ReaderOrientation
  let deadline: TimeInterval
}

final class ReaderPlugin: Plugin {
  private var pending: OrientationRequest?
  private var visibility_observer: NSObjectProtocol?

  override func load(webview: WKWebView) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      // The document uses viewport-fit=cover and CSS safe-area insets. Native
      // scroll insets would subtract the same space again and shift on focus.
      webview.scrollView.contentInsetAdjustmentBehavior = .never
      webview.scrollView.setContentOffset(.zero, animated: false)
      if self.visibility_observer == nil {
        // A webview can be created before its window becomes visible.
        self.visibility_observer = NotificationCenter.default.addObserver(
          forName: UIWindow.didBecomeVisibleNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.installStatusBarContainer() }
      }
      self.installStatusBarContainer()
    }
  }

  deinit {
    if let observer = visibility_observer {
      NotificationCenter.default.removeObserver(observer)
    }
  }

  private func installStatusBarContainer() {
    if let controller = manager.viewController {
      ReaderContainerController.install(around: controller)
    }
  }

  @objc func setOrientation(_ invoke: Invoke) throws {
    let options = try invoke.parseArgs(OrientationOptions.self)
    DispatchQueue.main.async {
      guard self.pending == nil else {
        invoke.reject("A reading direction change is already in progress.")
        return
      }
      guard #available(iOS 16, *) else {
        invoke.reject("Changing the reading direction requires iOS 16 or newer.")
        return
      }
      guard let controller = self.manager.viewController,
        let window = controller.viewIfLoaded?.window,
        let scene = window.windowScene,
        scene.activationState == .foregroundActive else {
        invoke.reject("The reader window is not active.")
        return
      }
      guard controller.presentedViewController == nil,
        window.rootViewController?.presentedViewController == nil else {
        invoke.reject("Close the native dialog before changing the reading direction.")
        return
      }
      self.installStatusBarContainer()
      let orientation_controller = window.rootViewController ?? controller
      guard !orientation_controller.supportedInterfaceOrientations.intersection(options.orientation.mask).isEmpty else {
        invoke.reject("This window does not support the requested reading direction.")
        return
      }
      if options.orientation.matches(scene.interfaceOrientation) {
        invoke.resolve(["orientation": options.orientation.rawValue])
        return
      }

      let request_id = UUID()
      self.pending = OrientationRequest(request_id: request_id, invoke: invoke,
        orientation: options.orientation, deadline: ProcessInfo.processInfo.systemUptime + 3)
      orientation_controller.setNeedsUpdateOfSupportedInterfaceOrientations()
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: options.orientation.mask)) { [weak self] error in
        DispatchQueue.main.async {
          self?.finish(request_id, error: error.localizedDescription)
        }
      }
      // Geometry requests have an asynchronous error callback, not a success
      // callback. Resolve only when the scene reports the requested orientation.
      self.awaitOrientation(request_id, scene: scene)
    }
  }

  private func awaitOrientation(_ request_id: UUID, scene: UIWindowScene) {
    guard let request = pending, request.request_id == request_id else { return }
    if request.orientation.matches(scene.interfaceOrientation) {
      finish(request_id)
      return
    }
    if scene.activationState != .foregroundActive {
      finish(request_id, error: "The reader window is no longer active.")
      return
    }
    if ProcessInfo.processInfo.systemUptime >= request.deadline {
      finish(request_id, error: "iOS did not change the reading direction. Try rotating your phone or checking Rotation Lock.")
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak scene] in
      guard let scene = scene else {
        self?.finish(request_id, error: "The reader window closed before its direction changed.")
        return
      }
      self?.awaitOrientation(request_id, scene: scene)
    }
  }

  private func finish(_ request_id: UUID, error: String? = nil) {
    guard let request = pending, request.request_id == request_id else { return }
    pending = nil
    if let error = error {
      request.invoke.reject(error)
    } else {
      request.invoke.resolve(["orientation": request.orientation.rawValue])
    }
  }
}

@_cdecl("init_plugin_papertrail_reader")
func initPlugin() -> Plugin {
  ReaderPlugin()
}
