pub type Result<T> = std::result::Result<T, String>;

pub fn storage_error(error: impl std::fmt::Display) -> String {
  format!("Could not access the local library: {error}")
}

pub fn network_error(operation: &str, error: reqwest::Error) -> String {
  if error.is_timeout() {
    format!("{operation} timed out. Please try again.")
  } else if error.is_connect() {
    format!("Could not connect for {operation}. Check your network and try again.")
  } else {
    format!("{operation} failed. Please try again.")
  }
}
