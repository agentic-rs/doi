import UIKit

/// Tao defaults prefersStatusBarHidden to a stored `false`, overriding
/// UIKit's normal compact-height iPhone behavior. A public UIKit container owns
/// that policy without replacing Tauri's controller or calling runtime setters.
final class ReaderContainerController: UIViewController {
  private let content_controller: UIViewController
  private var transitioning_landscape: Bool?

  private init(content_controller: UIViewController) {
    self.content_controller = content_controller
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("ReaderContainerController is created programmatically.")
  }

  static func install(around controller: UIViewController) {
    guard UIDevice.current.userInterfaceIdiom == .phone,
      let window = controller.viewIfLoaded?.window,
      window.rootViewController === controller,
      controller.parent == nil,
      controller.presentedViewController == nil else { return }

    let container = ReaderContainerController(content_controller: controller)
    window.rootViewController = container
    window.layoutIfNeeded()
    container.setNeedsStatusBarAppearanceUpdate()
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = content_controller.view.backgroundColor
    addChild(content_controller)
    content_controller.view.frame = view.bounds
    content_controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(content_controller.view)
    content_controller.didMove(toParent: self)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    content_controller.view.frame = view.bounds
  }

  override var prefersStatusBarHidden: Bool {
    guard traitCollection.userInterfaceIdiom == .phone else {
      return content_controller.prefersStatusBarHidden
    }
    return transitioning_landscape
      ?? viewIfLoaded?.window?.windowScene?.interfaceOrientation.isLandscape
      ?? false
  }

  override var childForStatusBarStyle: UIViewController? { content_controller }
  override var childForHomeIndicatorAutoHidden: UIViewController? { content_controller }
  override var childForScreenEdgesDeferringSystemGestures: UIViewController? { content_controller }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
    content_controller.supportedInterfaceOrientations
  }
  override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
    content_controller.preferredInterfaceOrientationForPresentation
  }

  override func viewWillTransition(to size: CGSize,
    with coordinator: UIViewControllerTransitionCoordinator) {
    // The scene can still report its old direction at the start of rotation.
    // Use the transition target, then resume reading the actual scene afterward.
    transitioning_landscape = size.width > size.height
    super.viewWillTransition(to: size, with: coordinator)
    setNeedsStatusBarAppearanceUpdate()
    coordinator.animate(alongsideTransition: { [weak self] _ in
      self?.setNeedsStatusBarAppearanceUpdate()
    }, completion: { [weak self] _ in
      self?.transitioning_landscape = nil
      self?.setNeedsStatusBarAppearanceUpdate()
    })
  }
}
