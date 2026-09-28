use std::{error::Error, io};

pub type Result<T> = std::result::Result<T, String>;

pub fn storage_error(error: impl std::fmt::Display) -> String {
  format!("Could not access the local library: {error}")
}

pub fn network_error(operation: &str, error: reqwest::Error) -> String {
  if error.is_timeout() {
    format!("{operation} timed out. Please try again.")
  } else if error.is_connect() {
    connection_message(operation, connection_failure(error.source()))
  } else {
    format!("{operation} failed. Please try again.")
  }
}

#[derive(Debug, PartialEq)]
enum ConnectionFailure {
  Certificate,
  Tls,
  Dns,
  Refused,
  Other,
}

fn connection_failure(mut source: Option<&(dyn Error + 'static)>) -> ConnectionFailure {
  let mut failure = ConnectionFailure::Other;
  while let Some(error) = source {
    if error
      .downcast_ref::<io::Error>()
      .is_some_and(|error| error.kind() == io::ErrorKind::ConnectionRefused)
    {
      failure = ConnectionFailure::Refused;
    }
    // Reqwest does not expose DNS/TLS error categories. Match known transport
    // descriptions internally, but never return the source text: it may contain
    // an endpoint URL, proxy credentials, or other request details.
    let message = error.to_string().to_ascii_lowercase();
    if [
      "invalid peer certificate",
      "invalid certificate",
      "certificate verify failed",
      "certificate validation failed",
    ]
    .iter()
    .any(|marker| message.contains(marker))
    {
      return ConnectionFailure::Certificate;
    }
    if [
      "tls handshake",
      "tls alert",
      "ssl handshake",
      "received fatal alert",
    ]
    .iter()
    .any(|marker| message.contains(marker))
    {
      failure = ConnectionFailure::Tls;
    } else if [
      "dns error",
      "failed to lookup address information",
      "name or service not known",
      "nodename nor servname provided",
      "temporary failure in name resolution",
    ]
    .iter()
    .any(|marker| message.contains(marker))
    {
      failure = ConnectionFailure::Dns;
    }
    source = error.source();
  }
  failure
}

fn connection_message(operation: &str, failure: ConnectionFailure) -> String {
  match failure {
    ConnectionFailure::Certificate => format!(
      "{operation} could not verify the server's TLS certificate. Check the device date and any proxy certificate configuration."
    ),
    ConnectionFailure::Tls => format!(
      "{operation} could not establish a secure connection. Check the service URL and your proxy or network settings."
    ),
    ConnectionFailure::Dns => format!(
      "{operation} could not resolve the server address. Check the service URL and your network or DNS settings."
    ),
    ConnectionFailure::Refused => format!(
      "{operation} was refused by the server or proxy. Check the service URL and that the service is running."
    ),
    ConnectionFailure::Other => format!(
      "Could not connect for {operation}. Check your network and proxy settings, then try again."
    ),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[derive(Debug)]
  struct WrappedError(Box<dyn Error>);

  impl std::fmt::Display for WrappedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
      formatter.write_str("client error (Connect)")
    }
  }

  impl Error for WrappedError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
      Some(self.0.as_ref())
    }
  }

  #[test]
  fn nested_certificate_failure_is_actionable_without_exposing_transport_details() {
    let source = WrappedError(Box::new(io::Error::new(
      io::ErrorKind::InvalidData,
      "invalid peer certificate: UnknownIssuer; https://user:secret@proxy.example/private",
    )));
    let failure = connection_failure(Some(&source));
    assert_eq!(failure, ConnectionFailure::Certificate);
    assert_eq!(
      connection_message("Model discovery", failure),
      "Model discovery could not verify the server's TLS certificate. Check the device date and any proxy certificate configuration."
    );
  }

  #[test]
  fn connection_failures_distinguish_dns_tls_and_refused_connections() {
    for (kind, message, expected) in [
      (
        io::ErrorKind::Other,
        "dns error: failed to lookup address information",
        ConnectionFailure::Dns,
      ),
      (
        io::ErrorKind::Other,
        "nodename nor servname provided, or not known",
        ConnectionFailure::Dns,
      ),
      (
        io::ErrorKind::InvalidData,
        "TLS handshake failed",
        ConnectionFailure::Tls,
      ),
      (
        io::ErrorKind::ConnectionRefused,
        "Connection refused",
        ConnectionFailure::Refused,
      ),
    ] {
      let source = WrappedError(Box::new(io::Error::new(kind, message)));
      assert_eq!(connection_failure(Some(&source)), expected);
    }
  }

  #[test]
  fn unknown_transport_errors_remain_sanitized() {
    let source = io::Error::other("https://user:secret@proxy.example/private?key=secret");
    let failure = connection_failure(Some(&source));
    assert_eq!(failure, ConnectionFailure::Other);
    assert_eq!(
      connection_message("AI request", failure),
      "Could not connect for AI request. Check your network and proxy settings, then try again."
    );
  }
}
