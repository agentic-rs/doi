use super::*;
use serde_json::json;

async fn complete(
  client: &reqwest::Client,
  settings: &AiSettings,
  api_key: Option<String>,
  user_content: &str,
) -> Result<String> {
  super::complete(client, settings, api_key, user_content, &|_, _| {})
    .await
    .map(|completion| completion.answer)
}
use std::{
  io::{Read, Write},
  net::TcpListener,
  sync::mpsc::{self, Receiver},
  thread::{self, JoinHandle},
  time::Duration,
};

pub(super) struct MockProvider {
  base_url: String,
  request: Receiver<Vec<u8>>,
  server: JoinHandle<()>,
}

impl MockProvider {
  fn start(status: &str, body: String) -> Self {
    Self::sequence(vec![(status.to_owned(), "application/json".into(), body)])
  }

  pub(super) fn sequence(responses: Vec<(String, String, String)>) -> Self {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}/proxy/v1", listener.local_addr().unwrap());
    let (sender, request) = mpsc::channel();
    listener.set_nonblocking(true).unwrap();
    let server = thread::spawn(move || {
      for (status, content_type, body) in responses {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let (mut socket, _) = loop {
          match listener.accept() {
            Ok(connection) => break connection,
            Err(error)
              if error.kind() == std::io::ErrorKind::WouldBlock
                && std::time::Instant::now() < deadline =>
            {
              thread::sleep(Duration::from_millis(5))
            }
            Err(error) => panic!("mock provider did not receive request: {error}"),
          }
        };
        socket.set_nonblocking(false).unwrap();
        socket
          .set_read_timeout(Some(Duration::from_secs(5)))
          .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        let (header_end, content_length) = loop {
          let count = socket.read(&mut buffer).unwrap();
          assert!(count > 0);
          bytes.extend_from_slice(&buffer[..count]);
          if let Some(index) = bytes.windows(4).position(|slice| slice == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&bytes[..index]);
            let length: usize = headers
              .lines()
              .find_map(|line| {
                line
                  .to_ascii_lowercase()
                  .strip_prefix("content-length:")
                  .map(|value| value.trim().parse().unwrap())
              })
              .unwrap_or(0);
            break (index + 4, length);
          }
        };
        while bytes.len() < header_end + content_length {
          let count = socket.read(&mut buffer).unwrap();
          assert!(count > 0);
          bytes.extend_from_slice(&buffer[..count]);
        }
        sender.send(bytes).unwrap();
        // Redirect failures must never follow this address or forward the key.
        let location = if status.starts_with("302") {
          "Location: http://127.0.0.1:1/leak\r\n"
        } else {
          ""
        };
        let _ = write!(socket, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{location}Connection: close\r\n\r\n{body}", body.len());
      }
    });
    Self {
      base_url,
      request,
      server,
    }
  }

  pub(super) fn settings(&self, provider_kind: AiProviderKind) -> AiSettings {
    AiSettings {
      provider_kind,
      base_url: self.base_url.clone(),
      model_id: "glm-test-model".into(),
      has_api_key: false,
    }
  }

  fn captured(self) -> (String, Value) {
    self.captured_all().pop().unwrap()
  }

  pub(super) fn captured_all(self) -> Vec<(String, Value)> {
    self.server.join().unwrap();
    self
      .request
      .into_iter()
      .map(|bytes| {
        let boundary = bytes
          .windows(4)
          .position(|slice| slice == b"\r\n\r\n")
          .unwrap();
        let headers = String::from_utf8_lossy(&bytes[..boundary]).to_ascii_lowercase();
        let body = &bytes[boundary + 4..];
        (
          headers,
          if body.is_empty() {
            Value::Null
          } else {
            serde_json::from_slice(body).unwrap()
          },
        )
      })
      .collect()
  }
}

pub(super) fn client() -> reqwest::Client {
  reqwest::Client::builder()
    .no_proxy()
    .timeout(Duration::from_secs(5))
    .redirect(reqwest::redirect::Policy::none())
    .build()
    .unwrap()
}

const PROVIDERS: [AiProviderKind; 7] = [
  AiProviderKind::Openai,
  AiProviderKind::Deepseek,
  AiProviderKind::Zai,
  AiProviderKind::ZaiCodingPlan,
  AiProviderKind::Zhipu,
  AiProviderKind::ZhipuCodingPlan,
  AiProviderKind::OpenaiCompatible,
];

#[test]
fn embedded_drivers_preserve_context_and_apply_provider_transforms() {
  tauri::async_runtime::block_on(async {
    for kind in PROVIDERS {
      let server = MockProvider::start("200 OK", json!({
        "choices": [{ "finish_reason": "stop", "message": { "content": "A grounded answer.", "reasoning_content": "Do not include this." } }]
      }).to_string());
      let answer = complete(
        &client(),
        &server.settings(kind),
        Some("test-only-token".into()),
        "Paper metadata\nSelected passage\nNearby context\nQuestion",
      )
      .await
      .unwrap();
      let (headers, payload) = server.captured();
      assert!(headers.starts_with("post /proxy/v1/chat/completions http/1.1"));
      assert!(headers.contains("authorization: bearer test-only-token"));
      assert!(headers.contains("content-type: application/json"));
      assert_eq!(payload["model"], "glm-test-model");
      assert_eq!(payload["stream"], true);
      assert_eq!(payload["tool_choice"], "auto");
      assert_eq!(
        payload["tools"][0]["function"]["name"],
        "propose_annotation"
      );
      assert_eq!(payload["messages"][0]["content"], SYSTEM_PROMPT);
      assert!(payload["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("Selected passage"));
      if matches!(
        kind,
        AiProviderKind::Deepseek
          | AiProviderKind::Zai
          | AiProviderKind::ZaiCodingPlan
          | AiProviderKind::Zhipu
          | AiProviderKind::ZhipuCodingPlan
      ) {
        assert_eq!(payload["thinking"]["type"], "enabled");
      }
      assert_eq!(answer, "A grounded answer.");
    }
  });
}

#[test]
fn compatible_provider_omits_authorization_when_key_is_empty() {
  tauri::async_runtime::block_on(async {
    for key in [None, Some("  ".into())] {
      let server = MockProvider::start("200 OK", json!({
        "choices": [{ "finish_reason": "stop", "message": { "content": [{ "type": "text", "text": "First" }, { "type": "text", "text": "Second" }] } }]
      }).to_string());
      let answer = complete(
        &client(),
        &server.settings(AiProviderKind::OpenaiCompatible),
        key,
        "Selected passage",
      )
      .await
      .unwrap();
      let (headers, _) = server.captured();
      assert!(!headers.contains("authorization:"));
      assert_eq!(answer, "First\nSecond");
    }
  });
}

#[test]
fn discovery_uses_each_drivers_auth_and_returns_sorted_unique_models() {
  tauri::async_runtime::block_on(async {
    for kind in PROVIDERS {
      let server = MockProvider::start(
        "200 OK",
        json!({ "data": [
        { "id": "z-model", "name": "Model Z" },
        { "id": "a-model", "display_name": "Model A" },
        { "id": "a-model", "name": "Duplicate" },
        { "id": "" }, { "id": "bad\nmodel" }, { "id": 123 },
      ] })
        .to_string(),
      );
      let models = list_models(
        &client(),
        &server.settings(kind),
        Some("test-only-token".into()),
      )
      .await
      .unwrap();
      let (headers, body) = server.captured();
      assert!(headers.starts_with("get /proxy/v1/models http/1.1"));
      assert!(headers.contains("authorization: bearer test-only-token"));
      assert_eq!(body, Value::Null);
      assert_eq!(
        models,
        vec![
          AiModel {
            model_id: "a-model".into(),
            display_name: "Model A".into()
          },
          AiModel {
            model_id: "z-model".into(),
            display_name: "Model Z".into()
          },
        ]
      );
    }
    let server = MockProvider::start("200 OK", json!([{ "id": "local-model" }]).to_string());
    let models = list_models(
      &client(),
      &server.settings(AiProviderKind::OpenaiCompatible),
      None,
    )
    .await
    .unwrap();
    assert_eq!(models[0].model_id, "local-model");
    assert!(!server.captured().0.contains("authorization:"));
  });
}

#[test]
fn discovery_with_an_explicit_key_does_not_save_settings_or_secrets() {
  tauri::async_runtime::block_on(async {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::state::AppState::initialize(directory.path().to_owned()).unwrap();
    let original = state.database.get_settings().await.unwrap();
    let server = MockProvider::start(
      "200 OK",
      json!({ "data": [{ "id": "test-model" }] }).to_string(),
    );
    let settings = server.settings(AiProviderKind::Openai);
    let models = crate::ai::list_models(&state, settings, Some("test-only-token".into()))
      .await
      .unwrap();
    assert_eq!(models[0].model_id, "test-model");
    assert!(server
      .captured()
      .0
      .contains("authorization: bearer test-only-token"));
    let after = state.database.get_settings().await.unwrap();
    assert_eq!(after.base_url, original.base_url);
    assert_eq!(after.provider_kind, original.provider_kind);
    assert_eq!(after.model_id, original.model_id);
    assert!(!after.has_api_key);
  });
}

#[test]
fn discovery_and_completion_bound_bodies_and_hide_upstream_errors() {
  tauri::async_runtime::block_on(async {
    for discovery in [true, false] {
      for (status, body, expected) in [
        (
          "401 Unauthorized",
          "secret-key: do not expose upstream error".into(),
          "HTTP 401",
        ),
        ("302 Found", "".into(), "HTTP 302"),
        ("200 OK", "not-json-secret-key".into(), "compatible"),
        (
          "200 OK",
          "x".repeat(stream::MAX_STREAM_BYTES + 1),
          "too much data",
        ),
      ] {
        let server = MockProvider::start(status, body);
        let settings = server.settings(AiProviderKind::OpenaiCompatible);
        let error = if discovery {
          list_models(&client(), &settings, Some("test-only-token".into()))
            .await
            .unwrap_err()
        } else {
          complete(
            &client(),
            &settings,
            Some("test-only-token".into()),
            "selection",
          )
          .await
          .unwrap_err()
        };
        server.captured();
        assert!(error.contains(expected), "{error}");
        assert!(!error.contains("secret-key"));
        assert!(!error.contains("test-only-token"));
      }
    }
  });
}

#[test]
fn connection_failures_name_the_operation_without_exposing_request_details() {
  tauri::async_runtime::block_on(async {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let settings = AiSettings {
      provider_kind: AiProviderKind::OpenaiCompatible,
      base_url: format!("http://{address}/private-provider-path"),
      model_id: "test-model".into(),
      has_api_key: false,
    };
    for discovery in [true, false] {
      let error = if discovery {
        list_models(&client(), &settings, Some("test-only-token".into()))
          .await
          .unwrap_err()
      } else {
        complete(
          &client(),
          &settings,
          Some("test-only-token".into()),
          "selection",
        )
        .await
        .unwrap_err()
      };
      let operation = if discovery {
        "Model discovery"
      } else {
        "AI request"
      };
      assert_eq!(
        error,
        format!("{operation} was refused by the server or proxy. Check the service URL and that the service is running.")
      );
    }
  });
}

#[test]
fn missing_keys_and_invalid_keys_fail_before_network_access() {
  let mut settings = AiSettings::default();
  for kind in PROVIDERS {
    settings.provider_kind = kind;
    if kind != AiProviderKind::OpenaiCompatible {
      assert!(build_provider(&settings, None)
        .err()
        .unwrap()
        .contains("API key"));
    }
    for key in ["bad\r\nkey".to_owned(), "x".repeat(8193)] {
      assert!(build_provider(&settings, Some(key)).is_err());
    }
  }
}

#[test]
fn settings_preserve_legacy_protocol_and_normalized_credential_identity() {
  let settings: AiSettings = serde_json::from_value(json!({
    "base_url": "https://API.example.com:443/proxy/v1/", "model_id": " old-model ", "has_api_key": false
  })).unwrap();
  let normalized = normalize_settings(settings).unwrap();
  assert_eq!(normalized.provider_kind, AiProviderKind::OpenaiCompatible);
  assert_eq!(normalized.base_url, "https://api.example.com/proxy/v1");
  assert_eq!(normalized.model_id, "old-model");
  assert_eq!(AiSettings::default().provider_kind, AiProviderKind::Openai);
  assert!(target("http://localhost:8080/v1").is_ok());
  assert!(target("http://[::1]:8080/v1").is_ok());
  for url in [
    "http://api.example.com/v1",
    "https://key@api.example.com/v1",
    "https://api.example.com/v1?key=secret",
  ] {
    assert!(target(url).is_err());
  }
}

#[test]
fn model_lists_reject_wrong_shapes_and_excessive_counts() {
  assert!(model_list(json!({ "models": [] })).is_err());
  assert!(model_list(json!({ "data": "not-an-array" })).is_err());
  assert!(model_list(json!({ "data": vec![json!({ "id": "a" }); MAX_MODEL_COUNT + 1] })).is_err());
  assert!(model_list(json!({ "data": [] })).unwrap().is_empty());
}
