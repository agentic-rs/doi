use crate::error::Result;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReaderOrientation {
  Portrait,
  Landscape,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ReaderDeviceKind {
  Phone,
  Tablet,
  Desktop,
  Unknown,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ReaderCapabilities {
  pub supports_orientation: bool,
  pub device_kind: ReaderDeviceKind,
}

pub async fn capabilities(app: AppHandle) -> Result<ReaderCapabilities> {
  #[cfg(target_os = "ios")]
  {
    let response = tauri::async_runtime::spawn_blocking(move || {
      tauri_plugin_papertrail_reader::capabilities(&app)
    })
    .await
    .map_err(|_| "Reader device detection was interrupted.".to_string())??;
    Ok(ReaderCapabilities {
      supports_orientation: response.supports_orientation,
      device_kind: device_kind_from_native(&response.device_kind)?,
    })
  }
  #[cfg(not(target_os = "ios"))]
  {
    let _ = app;
    Ok(ReaderCapabilities {
      supports_orientation: false,
      device_kind: ReaderDeviceKind::Desktop,
    })
  }
}

pub async fn set_orientation(
  app: AppHandle,
  orientation: ReaderOrientation,
) -> Result<ReaderOrientation> {
  #[cfg(target_os = "ios")]
  {
    let value = match orientation {
      ReaderOrientation::Portrait => "portrait",
      ReaderOrientation::Landscape => "landscape",
    };
    let response = tauri::async_runtime::spawn_blocking(move || {
      tauri_plugin_papertrail_reader::set_orientation(&app, value.to_string())
    })
    .await
    .map_err(|_| "The reading direction change was interrupted.".to_string())??;
    orientation_from_native(&response)
  }
  #[cfg(not(target_os = "ios"))]
  {
    let _ = (app, orientation);
    Err("Screen orientation changes are available only on iOS.".to_string())
  }
}

pub async fn set_ai_mode(app: AppHandle, active: bool) -> Result<ReaderOrientation> {
  #[cfg(target_os = "ios")]
  {
    let response = tauri::async_runtime::spawn_blocking(move || {
      tauri_plugin_papertrail_reader::set_ai_mode(&app, active)
    })
    .await
    .map_err(|_| "The AI reader layout change was interrupted.".to_string())??;
    orientation_from_native(&response)
  }
  #[cfg(not(target_os = "ios"))]
  {
    let _ = (app, active);
    Ok(ReaderOrientation::Portrait)
  }
}

#[cfg(any(target_os = "ios", test))]
fn orientation_from_native(value: &str) -> Result<ReaderOrientation> {
  match value {
    "portrait" => Ok(ReaderOrientation::Portrait),
    "landscape" => Ok(ReaderOrientation::Landscape),
    _ => Err("iOS returned an unknown reading direction.".to_string()),
  }
}

#[cfg(any(target_os = "ios", test))]
fn device_kind_from_native(value: &str) -> Result<ReaderDeviceKind> {
  match value {
    "phone" => Ok(ReaderDeviceKind::Phone),
    "tablet" => Ok(ReaderDeviceKind::Tablet),
    "desktop" => Ok(ReaderDeviceKind::Desktop),
    "unknown" => Ok(ReaderDeviceKind::Unknown),
    _ => Err("iOS returned an unknown reader device kind.".to_string()),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn orientation_contract_accepts_only_supported_native_directions() {
    let portrait = serde_json::from_str::<ReaderOrientation>("\"portrait\"").unwrap();
    assert_eq!(portrait, ReaderOrientation::Portrait);
    assert_eq!(
      serde_json::to_string(&ReaderOrientation::Landscape).unwrap(),
      "\"landscape\""
    );
    assert!(serde_json::from_str::<ReaderOrientation>("\"clockwise\"").is_err());
    assert!(serde_json::from_str::<ReaderOrientation>("90").is_err());
    assert_eq!(orientation_from_native("portrait").unwrap(), portrait);
    assert!(orientation_from_native("landscape_left").is_err());
  }

  #[test]
  fn capabilities_use_native_device_kinds_and_snake_case_fields() {
    for (value, kind) in [
      ("phone", ReaderDeviceKind::Phone),
      ("tablet", ReaderDeviceKind::Tablet),
      ("desktop", ReaderDeviceKind::Desktop),
      ("unknown", ReaderDeviceKind::Unknown),
    ] {
      assert_eq!(device_kind_from_native(value).unwrap(), kind);
      assert_eq!(
        serde_json::to_value(ReaderCapabilities {
          supports_orientation: kind == ReaderDeviceKind::Phone || kind == ReaderDeviceKind::Tablet,
          device_kind: kind,
        })
        .unwrap(),
        serde_json::json!({
          "supports_orientation": kind == ReaderDeviceKind::Phone || kind == ReaderDeviceKind::Tablet,
          "device_kind": value,
        })
      );
    }
    assert!(device_kind_from_native("small_screen").is_err());
  }
}
