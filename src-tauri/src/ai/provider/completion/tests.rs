use super::super::tests::{client, MockProvider};
use super::*;
use std::sync::Mutex;

fn json_response(message: Value, finish: &str) -> (String, String, String) {
  (
    "200 OK".into(),
    "application/json".into(),
    json!({"choices": [{"message": message, "finish_reason": finish}]}).to_string(),
  )
}

fn proposal(arguments: &str) -> Value {
  json!({"id": "call_1", "type": "function", "function": {"name": "propose_annotation", "arguments": arguments}})
}

#[test]
fn tool_only_response_continues_with_original_thinking_and_draft_tool_result() {
  tauri::async_runtime::block_on(async {
    let server = MockProvider::sequence(vec![
      json_response(
        json!({"content": null, "reasoning_content": "Original thinking, unchanged.", "tool_calls": [proposal("{\"content\":\"Concise takeaway.\"}")]}),
        "tool_calls",
      ),
      json_response(
        json!({"content": "The grounded answer.", "reasoning_content": "Follow-up reasoning."}),
        "stop",
      ),
    ]);
    let events = Mutex::new(Vec::new());
    let result = complete(
      &client(),
      &server.settings(AiProviderKind::Deepseek),
      Some("test-only-token".into()),
      "Selected text",
      &|kind, text| events.lock().unwrap().push((kind, text.to_owned())),
    )
    .await
    .unwrap();
    assert_eq!(result.answer, "The grounded answer.");
    assert_eq!(result.note_proposal.as_deref(), Some("Concise takeaway."));
    assert_eq!(
      result.thinking,
      "Original thinking, unchanged.\n\nFollow-up reasoning."
    );
    assert!(result.proposal_warning.is_none());
    let requests = server.captured_all();
    assert_eq!(requests.len(), 2);
    let history = &requests[1].1["messages"];
    assert_eq!(
      history[2]["reasoning_content"],
      "Original thinking, unchanged."
    );
    assert_eq!(
      history[2]["tool_calls"][0],
      proposal("{\"content\":\"Concise takeaway.\"}")
    );
    assert_eq!(history[3]["tool_call_id"], "call_1");
    assert!(history[3]["content"]
      .as_str()
      .unwrap()
      .contains("Nothing has been saved"));
    assert_eq!(requests[1].1["thinking"]["type"], "enabled");
    let emitted_thinking: String = events
      .lock()
      .unwrap()
      .iter()
      .filter(|(kind, _)| *kind == AiStreamKind::ThinkingDelta)
      .map(|(_, text)| text.as_str())
      .collect();
    assert_eq!(emitted_thinking, result.thinking);
  });
}

#[test]
fn streamed_tool_preamble_is_followed_by_a_final_answer() {
  tauri::async_runtime::block_on(async {
    let frame = |delta: Value, finish: Value| {
      format!(
        "data: {}\n\n",
        json!({"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
      )
    };
    let body = format!(
      "{}{}{}data: [DONE]\n\n",
      frame(
        json!({"reasoning_content": "Provider thinking"}),
        Value::Null
      ),
      frame(
        json!({"content": "Preparing note…", "tool_calls": [{"index": 0, "id": "call_1", "function": {"name": "propose_annotation", "arguments": "{\"content\":\"Short note\"}"}}]}),
        Value::Null
      ),
      frame(json!({}), json!("tool_calls")),
    );
    let server = MockProvider::sequence(vec![
      (
        "200 OK".into(),
        "text/event-stream; charset=utf-8".into(),
        body,
      ),
      json_response(json!({"content": "Full answer"}), "stop"),
    ]);
    let events = Mutex::new(Vec::new());
    let result = complete(
      &client(),
      &server.settings(AiProviderKind::Zai),
      Some("test-only-token".into()),
      "Selected text",
      &|kind, text| events.lock().unwrap().push((kind, text.to_owned())),
    )
    .await
    .unwrap();
    assert_eq!(result.answer, "Full answer");
    assert_eq!(result.note_proposal.as_deref(), Some("Short note"));
    assert_eq!(result.thinking.trim_end(), "Provider thinking");
    assert!(events
      .lock()
      .unwrap()
      .iter()
      .any(|(kind, text)| *kind == AiStreamKind::AnswerDelta && text == "Full answer"));
    let requests = server.captured_all();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[1].1["messages"][2]["content"], "Preparing note…");
    assert!(requests[1].1.get("tools").is_none());
    assert!(requests[1].1.get("tool_choice").is_none());
  });
}

#[test]
fn missing_or_invalid_proposals_preserve_the_answer_for_manual_saving() {
  tauri::async_runtime::block_on(async {
    for arguments in [
      None,
      Some("{broken"),
      Some("{\"content\":\"note\",\"paper_id\":\"injected\"}"),
      Some("{\"content\":\" \"}"),
    ] {
      let mut message = json!({"content": "A useful answer"});
      if let Some(arguments) = arguments {
        message["tool_calls"] = json!([proposal(arguments)]);
      }
      let server = MockProvider::sequence(vec![json_response(message, "stop")]);
      let result = complete(
        &client(),
        &server.settings(AiProviderKind::OpenaiCompatible),
        None,
        "Selection",
        &|_, _| {},
      )
      .await
      .unwrap();
      assert_eq!(result.answer, "A useful answer");
      assert!(result.note_proposal.is_none());
      assert_eq!(result.proposal_warning.is_some(), arguments.is_some());
      assert_eq!(server.captured_all().len(), 1);
    }
  });
}

#[test]
fn unsupported_tools_retry_once_but_other_failures_do_not_retry() {
  tauri::async_runtime::block_on(async {
    let unsupported =
      json!({"error": {"message": "This model does not support tools.", "param": "tools"}})
        .to_string();
    let server = MockProvider::sequence(vec![
      (
        "400 Bad Request".into(),
        "application/json".into(),
        unsupported.clone(),
      ),
      json_response(json!({"content": "Compatible answer"}), "stop"),
    ]);
    let result = complete(
      &client(),
      &server.settings(AiProviderKind::OpenaiCompatible),
      None,
      "Selection",
      &|_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(result.answer, "Compatible answer");
    assert!(result
      .proposal_warning
      .unwrap()
      .contains("does not support"));
    let requests = server.captured_all();
    assert!(requests[0].1.get("tools").is_some());
    assert!(requests[1].1.get("tools").is_none());
    assert!(requests[1].1.get("tool_choice").is_none());
    for (status, body) in [
      ("401 Unauthorized", unsupported.clone()),
      ("429 Too Many Requests", unsupported.clone()),
      (
        "400 Bad Request",
        json!({"error": {"message": "Invalid model ID secret-detail"}}).to_string(),
      ),
    ] {
      let server = MockProvider::sequence(vec![(status.into(), "application/json".into(), body)]);
      let error = complete(
        &client(),
        &server.settings(AiProviderKind::OpenaiCompatible),
        None,
        "Selection",
        &|_, _| {},
      )
      .await
      .unwrap_err();
      assert!(error.contains(&status[..3]));
      assert!(!error.contains("secret-detail"));
      assert_eq!(server.captured_all().len(), 1);
    }
  });
}

#[test]
fn proposal_schema_rejects_ids_unknown_tools_and_large_or_control_text() {
  let make_tool = |name: &str, content: Value| stream::ToolCall {
    id: "call".into(),
    name: name.into(),
    arguments: content.to_string(),
    invalid: false,
  };
  for tool in [
    make_tool("save_annotation", json!({"content": "note"})),
    make_tool(
      "propose_annotation",
      json!({"content": "note", "annotation_id": "evil"}),
    ),
    make_tool(
      "propose_annotation",
      json!({"content": "a".repeat(validation::MAX_AI_NOTE_BYTES + 1)}),
    ),
    make_tool("propose_annotation", json!({"content": "nul\u{0000}"})),
  ] {
    assert!(parse_proposal(&tool).is_none());
  }
}

#[test]
fn stopping_during_a_stream_closes_the_in_flight_connection() {
  tauri::async_runtime::block_on(async {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let settings = AiSettings {
      provider_kind: AiProviderKind::OpenaiCompatible,
      base_url: format!("http://{}/v1", listener.local_addr().unwrap()),
      model_id: "local-test".into(),
      has_api_key: false,
    };
    let server = tokio::spawn(async move {
      let (mut socket, _) = listener.accept().await.unwrap();
      let mut request = Vec::new();
      let mut buffer = [0; 4096];
      loop {
        let count = socket.read(&mut buffer).await.unwrap();
        assert!(count > 0);
        request.extend_from_slice(&buffer[..count]);
        if let Some(boundary) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
          let headers = String::from_utf8_lossy(&request[..boundary]);
          let length: usize = headers
            .lines()
            .find_map(|line| {
              line
                .to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse().unwrap())
            })
            .unwrap();
          if request.len() >= boundary + 4 + length {
            break;
          }
        }
      }
      socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").await.unwrap();
      let frame = format!(
        "data: {}\n\n",
        json!({"choices": [{"delta": {"reasoning_content": "Thinking arrived"}, "finish_reason": null}]})
      );
      socket
        .write_all(format!("{:x}\r\n{frame}\r\n", frame.len()).as_bytes())
        .await
        .unwrap();
      // There is deliberately no terminal frame. Stop should drop the response
      // while it awaits more bytes, without waiting for the client timeout.
      socket.read(&mut buffer).await.unwrap()
    });
    let registry = crate::ai::RequestRegistry::default();
    let mut active = registry.register("network-cancel").unwrap();
    let emit = |kind, _: &str| {
      if kind == AiStreamKind::ThinkingDelta {
        registry.cancel("network-cancel");
      }
    };
    let client = client();
    let result = tokio::time::timeout(
      Duration::from_secs(2),
      active.run(complete(&client, &settings, None, "Selected text", &emit)),
    )
    .await
    .unwrap();
    assert!(result.unwrap_err().contains("stopped"));
    assert_eq!(
      tokio::time::timeout(Duration::from_secs(2), server)
        .await
        .unwrap()
        .unwrap(),
      0
    );
    drop(active);
    assert!(registry.register("network-cancel").is_ok());
  });
}
