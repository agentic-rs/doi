import Tauri
import UIKit

private struct ExportOptions: Decodable {
  let file_path: String
}

/// iOS exports an existing file. The Rust caller supplies the complete, validated
/// sidecar in a unique temporary folder and removes it after this operation ends.
final class ExportPlugin: Plugin, UIDocumentPickerDelegate, UIPopoverPresentationControllerDelegate {
  private var pending: Invoke?

  @objc func exportFile(_ invoke: Invoke) throws {
    let options = try invoke.parseArgs(ExportOptions.self)
    let source = URL(fileURLWithPath: options.file_path)
    guard FileManager.default.fileExists(atPath: source.path) else {
      invoke.reject("The annotation export file is missing.")
      return
    }
    DispatchQueue.main.async {
      guard self.pending == nil else {
        invoke.reject("An annotation export is already open.")
        return
      }
      guard let controller = self.manager.viewController else {
        invoke.reject("The Files picker is unavailable.")
        return
      }
      guard controller.presentedViewController == nil else {
        invoke.reject("Close the current native dialog before exporting annotations.")
        return
      }
      let picker: UIDocumentPickerViewController
      if #available(iOS 14, *) {
        picker = UIDocumentPickerViewController(forExporting: [source], asCopy: true)
      } else {
        picker = UIDocumentPickerViewController(url: source, in: .exportToService)
      }
      picker.delegate = self
      picker.modalPresentationStyle = .formSheet
      picker.presentationController?.delegate = self
      if let popover = picker.popoverPresentationController {
        popover.delegate = self
        popover.sourceView = controller.view
        popover.sourceRect = CGRect(x: controller.view.bounds.midX,
          y: controller.view.bounds.midY, width: 1, height: 1)
      }
      self.pending = invoke
      controller.present(picker, animated: true)
    }
  }

  func documentPicker(_ controller: UIDocumentPickerViewController,
    didPickDocumentsAt urls: [URL]) {
    guard let invoke = pending else { return }
    pending = nil
    guard let destination = urls.first else {
      invoke.reject("The Files picker did not return a destination.")
      return
    }
    invoke.resolve(["destination": destination.path])
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    cancelExport()
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    cancelExport()
  }

  func popoverPresentationControllerDidDismissPopover(
    _ popoverPresentationController: UIPopoverPresentationController) {
    cancelExport()
  }

  private func cancelExport() {
    pending?.resolve(["destination": NSNull()])
    pending = nil
  }
}

@_cdecl("init_plugin_papertrail_export")
func initPlugin() -> Plugin {
  ExportPlugin()
}
