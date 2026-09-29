import Tauri
import UIKit
import WebKit

private enum ReaderOrientation: String, Decodable {
  case portrait
  case landscape

  var mask: UIInterfaceOrientationMask {
    self == .portrait ? .portrait : .landscape
  }

  init?(_ orientation: UIInterfaceOrientation) {
    if orientation.isPortrait {
      self = .portrait
    } else if orientation.isLandscape {
      self = .landscape
    } else {
      return nil
    }
  }
}

private struct OrientationOptions: Decodable {
  let orientation: ReaderOrientation
}

private struct AiModeOptions: Decodable {
  let active: Bool
}

private struct ReaderOrientationError: Error {
  let message: String
}

private enum OrientationRequestKind: Equatable {
  case reader
  case ai_activation
  case ai_restoration
}

private struct OrientationRequest {
  let request_id: UUID
  let kind: OrientationRequestKind
  let mask: UIInterfaceOrientationMask
  let controller: UIViewController
  let scene: UIWindowScene
  let deadline: TimeInterval
  let completion: (Result<ReaderOrientation, ReaderOrientationError>) -> Void
  var submitted = false
}

private final class AiModeSession {
  let session_id = UUID()
  let prior_orientation: UIInterfaceOrientation
  weak var controller: ReaderContainerController?
  weak var scene: UIWindowScene?

  init(prior_orientation: UIInterfaceOrientation,
    controller: ReaderContainerController, scene: UIWindowScene) {
    self.prior_orientation = prior_orientation
    self.controller = controller
    self.scene = scene
  }
}

final class ReaderPlugin: Plugin {
  private var pending: OrientationRequest?
  private var ai_session: AiModeSession?
  private var visibility_observer: NSObjectProtocol?
  private var loading_observer: NSKeyValueObservation?
  private weak var reader_webview: WKWebView?
  private var keyboard_constraints: [NSLayoutConstraint] = []

  override func load(webview: WKWebView) {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      if self.reader_webview !== webview {
        self.resetAiModeForNavigation()
      }
      self.loading_observer?.invalidate()
      self.reader_webview = webview
      // A full document reload discards the frontend's AI session. Observe
      // navigation without replacing Wry's WKNavigationDelegate; capability
      // reads remain side-effect free while an AI conversation is open.
      self.loading_observer = webview.observe(\.isLoading, options: [.new]) { [weak self] observed, change in
        guard change.newValue == true else { return }
        DispatchQueue.main.async {
          guard let self = self, self.reader_webview === observed else { return }
          self.resetAiModeForNavigation()
        }
      }
      // The document uses viewport-fit=cover and CSS safe-area insets. Native
      // scroll insets would subtract the same space again and shift on focus.
      webview.scrollView.contentInsetAdjustmentBehavior = .never
      webview.scrollView.bounces = false
      webview.scrollView.setContentOffset(.zero, animated: false)
      if self.visibility_observer == nil {
        // A webview can be created before its window becomes visible.
        self.visibility_observer = NotificationCenter.default.addObserver(
          forName: UIWindow.didBecomeVisibleNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.installReaderLayout() }
      }
      self.installReaderLayout()
    }
  }

  deinit {
    loading_observer?.invalidate()
    if let observer = visibility_observer {
      NotificationCenter.default.removeObserver(observer)
    }
    if let controller = ai_session?.controller {
      DispatchQueue.main.async { controller.setAiModeActive(false) }
    }
  }

  private func installReaderLayout() {
    if let controller = manager.viewController {
      ReaderContainerController.install(around: controller)
    }
    guard #available(iOS 17, *),
      let webview = reader_webview,
      let host = webview.superview else { return }

    // Tao keeps its own view equal to the full window on every layout pass.
    // Constrain the webview inside that host, leaving Tao's frame ownership
    // intact. This also keeps CSS scrolling and text selection enabled.
    NSLayoutConstraint.deactivate(keyboard_constraints)
    host.keyboardLayoutGuide.usesBottomSafeArea = false
    webview.autoresizingMask = []
    webview.translatesAutoresizingMaskIntoConstraints = false
    keyboard_constraints = [
      webview.topAnchor.constraint(equalTo: host.topAnchor),
      webview.leadingAnchor.constraint(equalTo: host.leadingAnchor),
      webview.trailingAnchor.constraint(equalTo: host.trailingAnchor),
      webview.bottomAnchor.constraint(equalTo: host.keyboardLayoutGuide.topAnchor)
    ]
    NSLayoutConstraint.activate(keyboard_constraints)
    // With no keyboard, usesBottomSafeArea=false preserves the full viewport;
    // CSS applies safe areas once. A docked keyboard shrinks the layout viewport,
    // while a floating iPad keyboard retains its normal overlay behavior.
    host.setNeedsLayout()
  }

  private func resetAiModeForNavigation() {
    let session = ai_session
    ai_session = nil
    session?.controller?.setAiModeActive(false)
    if let request = pending, request.kind != .reader {
      finish(request.request_id, error: "The AI reader session ended when the page reloaded.")
    }
    guard #available(iOS 16, *), pending == nil,
      let session = session, let controller = session.controller,
      let scene = session.scene, scene.activationState == .foregroundActive,
      controller.viewIfLoaded?.window?.rootViewController === controller,
      controller.presentedViewController == nil,
      manager.viewController?.presentedViewController == nil,
      let restore_mask = orientationMask(session.prior_orientation) else { return }
    // Reload is a best-effort close. The mask is already released even when
    // restoring fails, and a stale activation cannot win over this new target.
    requestOrientation(restore_mask, kind: .ai_restoration,
      controller: controller, scene: scene, force_request: true) { _ in }
  }

  @objc func setOrientation(_ invoke: Invoke) throws {
    let options = try invoke.parseArgs(OrientationOptions.self)
    DispatchQueue.main.async {
      guard self.ai_session == nil else {
        invoke.reject("Close AI before changing the reading direction.")
        return
      }
      guard self.pending == nil else {
        invoke.reject("A reading direction change is already in progress.")
        return
      }
      guard #available(iOS 16, *) else {
        invoke.reject("Changing the reading direction requires iOS 16 or newer.")
        return
      }
      guard let context = self.orientationContext(invoke) else { return }
      self.requestOrientation(options.orientation.mask, kind: .reader,
        controller: context.controller, scene: context.scene) { [weak self] result in
        self?.resolve(invoke, result: result)
      }
    }
  }

  @objc func capabilities(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let idiom = UIDevice.current.userInterfaceIdiom
      let device_kind: String
      if idiom == .phone {
        device_kind = "phone"
      } else if idiom == .pad {
        device_kind = "tablet"
      } else if #available(iOS 14, *), idiom == .mac {
        device_kind = "desktop"
      } else {
        device_kind = "unknown"
      }
      var supports_orientation = false
      if #available(iOS 16, *) {
        supports_orientation = idiom == .phone || idiom == .pad
      }
      invoke.resolve([
        "supports_orientation": supports_orientation,
        "device_kind": device_kind
      ])
    }
  }

  @objc func setAiMode(_ invoke: Invoke) throws {
    let options = try invoke.parseArgs(AiModeOptions.self)
    DispatchQueue.main.async {
      guard UIDevice.current.userInterfaceIdiom == .phone else {
        let orientation = self.manager.viewController?.viewIfLoaded?.window?
          .windowScene?.interfaceOrientation ?? .portrait
        invoke.resolve(["orientation": (ReaderOrientation(orientation) ?? .portrait).rawValue])
        return
      }
      guard #available(iOS 16, *) else {
        invoke.reject("The AI portrait layout requires iOS 16 or newer.")
        return
      }
      if options.active {
        self.activateAiMode(invoke)
      } else {
        self.deactivateAiMode(invoke)
      }
    }
  }

  private func orientationContext(_ invoke: Invoke)
    -> (controller: UIViewController, scene: UIWindowScene)? {
    guard let controller = manager.viewController,
      let window = controller.viewIfLoaded?.window,
      let scene = window.windowScene,
      scene.activationState == .foregroundActive else {
      invoke.reject("The reader window is not active.")
      return nil
    }
    guard controller.presentedViewController == nil,
      window.rootViewController?.presentedViewController == nil else {
      invoke.reject("Close the native dialog before changing the reading direction.")
      return nil
    }
    installReaderLayout()
    return (window.rootViewController ?? controller, scene)
  }

  @available(iOS 16, *)
  private func activateAiMode(_ invoke: Invoke) {
    guard pending == nil else {
      invoke.reject("A reading direction change is already in progress.")
      return
    }
    guard let context = orientationContext(invoke) else { return }
    guard let controller = context.controller as? ReaderContainerController else {
      // The original controller remains owned by Tauri. Only our public root
      // container can apply a temporary orientation policy to that window.
      invoke.reject("The reader window cannot apply the AI portrait layout.")
      return
    }
    guard orientationMask(context.scene.interfaceOrientation) != nil else {
      invoke.reject("The reader window has not settled into a reading direction.")
      return
    }
    let is_new_session = ai_session == nil
    let session: AiModeSession
    if let current = ai_session {
      guard current.controller === controller, current.scene === context.scene else {
        current.controller?.setAiModeActive(false)
        ai_session = nil
        invoke.reject("The reader window changed. Open AI again.")
        return
      }
      session = current
    } else {
      session = AiModeSession(prior_orientation: context.scene.interfaceOrientation,
        controller: controller, scene: context.scene)
      ai_session = session
    }
    controller.setAiModeActive(true)
    requestOrientation(.portrait, kind: .ai_activation, controller: controller,
      scene: context.scene) { [weak self] result in
      guard let self = self else { return }
      if case .failure = result, is_new_session,
        self.ai_session?.session_id == session.session_id {
        // A refused or timed-out activation must not leave a portrait lock.
        session.controller?.setAiModeActive(false)
        self.ai_session = nil
      }
      self.resolve(invoke, result: result)
    }
  }

  @available(iOS 16, *)
  private func deactivateAiMode(_ invoke: Invoke) {
    guard let session = ai_session else {
      guard pending?.kind != .ai_restoration else {
        invoke.reject("The previous reading direction is still being restored.")
        return
      }
      let orientation = manager.viewController?.viewIfLoaded?.window?
        .windowScene?.interfaceOrientation ?? .portrait
      invoke.resolve(["orientation": (ReaderOrientation(orientation) ?? .portrait).rawValue])
      return
    }
    // Unlock the original owner before checking window activity or native
    // dialogs. Restoration can fail; closing AI must still release its policy.
    ai_session = nil
    session.controller?.setAiModeActive(false)
    let interrupted_activation = pending?.kind == .ai_activation
    if interrupted_activation, let request = pending {
      finish(request.request_id, error: "The AI portrait layout was cancelled.")
    }
    guard pending == nil else {
      invoke.reject("A reading direction change is already in progress.")
      return
    }
    guard let context = orientationContext(invoke) else { return }
    guard session.scene === context.scene,
      let restore_mask = orientationMask(session.prior_orientation) else {
      invoke.reject("The reader window changed before its reading direction could be restored.")
      return
    }
    requestOrientation(restore_mask, kind: .ai_restoration,
      controller: context.controller, scene: context.scene,
      force_request: interrupted_activation) { [weak self] result in
      self?.resolve(invoke, result: result)
    }
  }

  private func orientationMask(_ orientation: UIInterfaceOrientation) -> UIInterfaceOrientationMask? {
    switch orientation {
    case .portrait: return .portrait
    case .portraitUpsideDown: return .portraitUpsideDown
    case .landscapeLeft: return .landscapeLeft
    case .landscapeRight: return .landscapeRight
    default: return nil
    }
  }

  @available(iOS 16, *)
  private func requestOrientation(_ mask: UIInterfaceOrientationMask,
    kind: OrientationRequestKind, controller: UIViewController, scene: UIWindowScene,
    force_request: Bool = false,
    completion: @escaping (Result<ReaderOrientation, ReaderOrientationError>) -> Void) {
    guard !controller.supportedInterfaceOrientations.intersection(mask).isEmpty else {
      completion(.failure(ReaderOrientationError(
        message: "This window does not support the requested reading direction.")))
      return
    }
    if !force_request, controller.transitionCoordinator == nil,
      matches(mask, scene.interfaceOrientation),
      let orientation = ReaderOrientation(scene.interfaceOrientation) {
      completion(.success(orientation))
      return
    }
    let request_id = UUID()
    pending = OrientationRequest(request_id: request_id, kind: kind, mask: mask,
      controller: controller, scene: scene,
      deadline: ProcessInfo.processInfo.systemUptime + 3, completion: completion)
    submitOrientation(request_id)
    // Monitor the deadline even while waiting for an earlier UIKit transition.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      self?.awaitOrientation(request_id)
    }
  }

  @available(iOS 16, *)
  private func submitOrientation(_ request_id: UUID) {
    guard let request = pending, request.request_id == request_id else { return }
    guard ProcessInfo.processInfo.systemUptime < request.deadline else {
      finish(request_id, error: "The reading direction change timed out.")
      return
    }
    // Cancelling an invoke cannot cancel UIKit's submitted geometry request.
    // Wait through any existing transition, then reassert our current target.
    if let coordinator = request.controller.transitionCoordinator {
      let queued = coordinator.animate(alongsideTransition: nil) { [weak self] _ in
        DispatchQueue.main.async { self?.submitOrientation(request_id) }
      }
      if queued { return }
    }
    request.controller.setNeedsUpdateOfSupportedInterfaceOrientations()
    pending?.submitted = true
    request.scene.requestGeometryUpdate(.iOS(interfaceOrientations: request.mask)) { [weak self] error in
      DispatchQueue.main.async {
        self?.finish(request_id, error: error.localizedDescription)
      }
    }
  }

  private func matches(_ mask: UIInterfaceOrientationMask,
    _ orientation: UIInterfaceOrientation) -> Bool {
    guard let actual_mask = orientationMask(orientation) else { return false }
    return !mask.intersection(actual_mask).isEmpty
  }

  private func awaitOrientation(_ request_id: UUID) {
    guard let request = pending, request.request_id == request_id else { return }
    guard request.controller.viewIfLoaded?.window?.windowScene === request.scene else {
      finish(request_id, error: "The reader window closed before its direction changed.")
      return
    }
    if request.scene.activationState != .foregroundActive {
      finish(request_id, error: "The reader window is no longer active.")
      return
    }
    // UIKit reports asynchronous errors but has no success callback. Only a
    // submitted request with a settled, matching scene can resolve successfully.
    if request.submitted, request.controller.transitionCoordinator == nil,
      matches(request.mask, request.scene.interfaceOrientation) {
      finish(request_id)
      return
    }
    if ProcessInfo.processInfo.systemUptime >= request.deadline {
      finish(request_id, error: "iOS did not change the reading direction. Try rotating your phone or checking Rotation Lock.")
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      self?.awaitOrientation(request_id)
    }
  }

  private func finish(_ request_id: UUID, error: String? = nil) {
    guard let request = pending, request.request_id == request_id else { return }
    pending = nil
    if let error = error {
      request.completion(.failure(ReaderOrientationError(message: error)))
    } else if let orientation = ReaderOrientation(request.scene.interfaceOrientation) {
      request.completion(.success(orientation))
    } else {
      request.completion(.failure(ReaderOrientationError(
        message: "The reader window has not settled into a reading direction.")))
    }
  }

  private func resolve(_ invoke: Invoke, result: Result<ReaderOrientation, ReaderOrientationError>) {
    switch result {
    case .success(let orientation):
      invoke.resolve(["orientation": orientation.rawValue])
    case .failure(let error):
      invoke.reject(error.message)
    }
  }
}

@_cdecl("init_plugin_papertrail_reader")
func initPlugin() -> Plugin {
  ReaderPlugin()
}
