use super::*;
use std::{sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_rustls::{rustls, TlsAcceptor};

#[test]
fn certificate_bundle_selection_is_explicit_and_predictable() {
  let ssl = OsString::from("explicit.pem");
  let curl = OsString::from("fallback.pem");
  assert_eq!(
    certificate_bundle_path(Some(ssl.clone()), Some(curl.clone())),
    Some(ssl)
  );
  assert_eq!(
    certificate_bundle_path(Some(OsString::new()), Some(curl.clone())),
    Some(curl)
  );
  assert_eq!(certificate_bundle_path(None, None), None);
}

#[test]
fn certificate_bundles_reject_missing_empty_invalid_and_oversized_files() {
  let directory = tempfile::tempdir().unwrap();
  let path = directory.path().join("private-path-do-not-echo.pem");
  for bytes in [
    b"".as_slice(),
    b"not a certificate",
    b"-----BEGIN CERTIFICATE-----\ninvalid!\n-----END CERTIFICATE-----",
  ] {
    std::fs::write(&path, bytes).unwrap();
    let error = read_certificate_bundle(&path).unwrap_err();
    assert!(!error.contains("private-path"));
  }
  std::fs::File::create(&path)
    .unwrap()
    .set_len(MAX_CERTIFICATE_BUNDLE_BYTES + 1)
    .unwrap();
  assert!(read_certificate_bundle(&path).is_err());
  assert!(read_certificate_bundle(directory.path()).is_err());
  assert!(read_certificate_bundle(&directory.path().join("missing.pem")).is_err());
}

async fn tls_request(
  config: Arc<rustls::ServerConfig>,
  roots: Vec<Certificate>,
  host: &str,
) -> reqwest::Result<reqwest::Response> {
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let address = listener.local_addr().unwrap();
  let task = tokio::spawn(async move {
    let (socket, _) = listener.accept().await.unwrap();
    if let Ok(mut tls) = TlsAcceptor::from(config).accept(socket).await {
      let mut bytes = [0; 4096];
      if tls.read(&mut bytes).await.is_ok_and(|count| count > 0) {
        let _ = tls
          .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
          .await;
      }
    }
  });
  let result = reqwest::Client::builder()
    .no_proxy()
    .tls_certs_merge(roots)
    .resolve("localhost", address)
    .timeout(Duration::from_secs(5))
    .build()
    .unwrap()
    .get(format!("https://{host}:{}/", address.port()))
    .send()
    .await;
  tokio::time::timeout(Duration::from_secs(5), task)
    .await
    .unwrap()
    .unwrap();
  result
}

#[test]
fn configured_roots_trust_the_selected_certificate_but_still_verify_hostnames() {
  let rcgen::CertifiedKey { cert, signing_key } =
    rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
  let key = rustls::pki_types::PrivatePkcs8KeyDer::from(signing_key.serialize_der());
  let config = Arc::new(
    rustls::ServerConfig::builder_with_provider(Arc::new(
      rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(vec![cert.der().clone()], key.into())
    .unwrap(),
  );
  let directory = tempfile::tempdir().unwrap();
  let path = directory.path().join("roots.pem");
  std::fs::write(&path, cert.pem()).unwrap();
  let roots = read_certificate_bundle(&path).unwrap();
  tauri::async_runtime::block_on(async {
    let untrusted = tls_request(config.clone(), Vec::new(), "localhost")
      .await
      .unwrap_err();
    assert!(untrusted.is_connect());
    assert!(network_error("Model discovery", untrusted)
      .contains("could not verify the server's TLS certificate"));
    assert_eq!(
      tls_request(config.clone(), roots.clone(), "localhost")
        .await
        .unwrap()
        .status(),
      200
    );
    assert!(tls_request(config, roots, "127.0.0.1")
      .await
      .unwrap_err()
      .is_connect());
  });
}
