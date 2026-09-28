use super::*;
use std::sync::Mutex;

fn chunk(delta: Value, finish: Value) -> String {
  format!(
    "data: {}\r\n\r\n",
    json!({"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
  )
}

#[test]
fn fragmented_utf8_crlf_multiline_events_and_tool_arguments_stream_correctly() {
  let frames = format!(
    ": heartbeat\r\n\r\n{}{}{}{}{}data: {{\r\ndata: \"choices\": []}}\r\n\r\ndata: [DONE]\r\n\r\n",
    chunk(json!({"reasoning_content": "考虑一下。"}), Value::Null),
    chunk(
      json!({"content": "An answer ☀", "tool_calls": [{"index": 0, "id": "call_1", "type": "function", "function": {"name": "propose_annotation", "arguments": "{\"content\":"}}]}),
      Value::Null
    ),
    chunk(
      json!({"tool_calls": [{"index": 0, "function": {"arguments": "\"A takeaway\"}"}}]}),
      Value::Null
    ),
    chunk(json!({"content": "."}), Value::Null),
    chunk(json!({}), json!("tool_calls")),
  );
  let events = Mutex::new(Vec::new());
  let emit = |kind, text: &str| events.lock().unwrap().push((kind, text.to_owned()));
  let mut decoder = SseDecoder::default();
  for byte in frames.bytes() {
    decoder.push(&[byte], &emit).unwrap();
  }
  let turn = decoder.finish().unwrap();
  assert_eq!(turn.answer, "An answer ☀.");
  assert_eq!(turn.thinking, "考虑一下。");
  assert_eq!(turn.tools[&0].arguments, "{\"content\":\"A takeaway\"}");
  let history = turn.assistant_message().unwrap();
  assert_eq!(history["reasoning_content"], "考虑一下。");
  assert_eq!(history["tool_calls"][0]["id"], "call_1");
  assert_eq!(events.lock().unwrap().len(), 3);
}

#[test]
fn incomplete_failed_and_oversized_streams_are_rejected_without_echoing_content() {
  for frame in [
    chunk(json!({"content": "private text"}), Value::Null),
    format!(
      "{}data: [DONE]\n\n",
      chunk(json!({"content": "private text"}), Value::Null)
    ),
    "data: {\"secret\":\"unfinished".into(),
    "event: error\ndata: private error\n\n".into(),
    "data: {\"error\":{\"message\":\"private error\"}}\n\n".into(),
    chunk(json!({"content": "private text"}), json!("length")),
    chunk(json!({"content": "private text"}), json!("sensitive")),
    chunk(json!({"content": "private text"}), json!("network_error")),
  ] {
    let mut decoder = SseDecoder::default();
    let result = decoder
      .push(frame.as_bytes(), &|_, _| {})
      .and_then(|_| decoder.finish());
    let error = result.unwrap_err();
    assert!(!error.contains("private"));
    assert!(!error.contains("secret"));
  }
  for bytes in [
    vec![b'x'; MAX_EVENT_BYTES + 1],
    vec![b'x'; MAX_STREAM_BYTES + 1],
  ] {
    assert!(SseDecoder::default()
      .push(&bytes, &|_, _| {})
      .unwrap_err()
      .contains("too much data"));
  }
}

#[test]
fn reasoning_is_never_used_as_answer_and_bad_tools_do_not_discard_good_answer() {
  let mut turn = Turn::default();
  turn.ingest(json!({"choices": [{"message": {"content": null, "reasoning_content": "Thinking only"}, "finish_reason": "stop"}]}), false, &|_, _| {}).unwrap();
  assert!(turn.answer.is_empty());
  assert_eq!(turn.thinking, "Thinking only");
  let frame = chunk(
    json!({"content": "Usable answer", "tool_calls": [{"index": 999, "function": {"name": "bad"}}]}),
    json!("stop"),
  );
  let mut decoder = SseDecoder::default();
  decoder.push(frame.as_bytes(), &|_, _| {}).unwrap();
  let turn = decoder.finish().unwrap();
  assert_eq!(turn.answer, "Usable answer");
  assert!(turn.tool_warning);
  assert!(turn.assistant_message().is_none());
}

#[test]
fn utf8_bom_and_bare_carriage_returns_follow_sse_grammar() {
  let frame = format!(
    "\u{feff}{}data: [DONE]\r\r",
    chunk(json!({"content": "Yes"}), json!("stop")).replace("\r\n", "\r")
  );
  let mut decoder = SseDecoder::default();
  for byte in frame.bytes() {
    decoder.push(&[byte], &|_, _| {}).unwrap();
  }
  assert_eq!(decoder.finish().unwrap().answer, "Yes");
}
