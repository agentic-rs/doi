use crate::error::Result;
use sha2::{Digest, Sha256};

const SERVICE: &str = "app.papertrail.reader.ai";

#[cfg(not(target_os = "ios"))]
use keyring::{Entry as CredentialEntry, Error as CredentialError};
#[cfg(target_os = "ios")]
use keyring_core::{Entry as CredentialEntry, Error as CredentialError};

fn credential_entry(base_url: &str) -> Result<CredentialEntry> {
  // A changed provider does not inherit the previous provider's secret.
  let account = format!("{:x}", Sha256::digest(base_url.as_bytes()));
  #[cfg(not(target_os = "ios"))]
  let entry = CredentialEntry::new(SERVICE, &account);
  #[cfg(target_os = "ios")]
  let entry = apple_native_keyring_store::protected::Cred::build(
    SERVICE,
    &account,
    apple_native_keyring_store::protected::AccessPolicy::WhenUnlockedThisDeviceOnly,
    None,
    false,
  );
  entry.map_err(|_| "Could not initialize the native credential store.".to_string())
}

pub async fn get_key(base_url: String) -> Result<Option<String>> {
  if base_url.is_empty() {
    return Ok(None);
  }
  tauri::async_runtime::spawn_blocking(move || {
    match credential_entry(&base_url)?.get_password() {
      Ok(value) => Ok(Some(value)),
      Err(CredentialError::NoEntry) => Ok(None),
      Err(_) => Err("Could not read the API key from the native credential store. Check that your keychain is unlocked.".into()),
    }
  }).await.map_err(|_| "The credential operation was interrupted.".to_string())?
}

pub async fn update_key(base_url: String, api_key: Option<String>) -> Result<()> {
  let Some(api_key) = api_key else {
    return Ok(());
  };
  if base_url.is_empty() {
    return Err("Enter a provider base URL before saving an API key.".into());
  }
  if api_key.len() > 8192 || api_key.chars().any(char::is_control) {
    return Err("The API key is too long or contains invalid characters.".into());
  }
  tauri::async_runtime::spawn_blocking(move || {
    let entry = credential_entry(&base_url)?;
    if api_key.trim().is_empty() {
      match entry.delete_credential() {
        Ok(()) | Err(CredentialError::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the API key from the native credential store.".into()),
      }
    } else {
      entry.set_password(api_key.trim()).map_err(|_|
        "Could not save the API key in the native credential store. Check that your keychain is unlocked.".into())
    }
  }).await.map_err(|_| "The credential operation was interrupted.".to_string())?
}
