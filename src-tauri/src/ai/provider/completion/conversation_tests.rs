use super::super::tests::{client, MockProvider};
use super::*;

fn response(message: Value) -> (String, String, String) {
  (
    "200 OK".into(),
    "application/json".into(),
    json!({"choices": [{"message": message, "finish_reason": "stop"}]}).to_string(),
  )
}

fn proposal(arguments: &str) -> Value {
  json!({"id": "call_1", "type": "function", "function": {"name": "propose_annotation", "arguments": arguments}})
}

#[test]
fn conversation_uses_source_once_and_keeps_each_question_and_answer_in_its_role() {
  let history = vec![
    ("First question".into(), "First answer".into()),
    ("Second question".into(), "Second answer".into()),
  ];
  let messages = conversation_messages(
    "Paper title and quoted passage",
    &history,
    "Current question",
    CompletionMode::FollowUp,
  )
  .unwrap();
  assert_eq!(messages.len(), 7);
  assert_eq!(messages[0]["role"], "system");
  assert!(messages[0]["content"]
    .as_str()
    .unwrap()
    .contains("not instructions"));
  assert!(!messages[0]["content"]
    .as_str()
    .unwrap()
    .contains("propose_annotation"));
  assert_eq!(
    messages[1],
    json!({"role": "user", "content": "Quoted paper source:\nPaper title and quoted passage"})
  );
  assert_eq!(
    messages[2],
    json!({"role": "user", "content": "First question"})
  );
  assert_eq!(
    messages[3],
    json!({"role": "assistant", "content": "First answer"})
  );
  assert_eq!(
    messages[4],
    json!({"role": "user", "content": "Second question"})
  );
  assert_eq!(
    messages[5],
    json!({"role": "assistant", "content": "Second answer"})
  );
  assert_eq!(
    messages[6],
    json!({"role": "user", "content": "Current question"})
  );
  let initial = conversation_messages(
    "Source",
    &[],
    "Initial question",
    CompletionMode::InitialAnswer,
  )
  .unwrap();
  assert_eq!(initial.len(), 3);
  assert!(initial[0]["content"]
    .as_str()
    .unwrap()
    .contains("propose_annotation"));
  assert_eq!(initial[2]["content"], "Initial question");
}

#[test]
fn context_limit_counts_source_all_history_and_current_question_without_truncation() {
  let source = "s".repeat(validation::MAX_TEXT_BYTES - 3);
  let history = vec![("q".into(), "a".into())];
  assert!(conversation_messages(&source, &history, "q", CompletionMode::FollowUp).is_ok());
  let error = conversation_messages(&source, &history, "qq", CompletionMode::FollowUp).unwrap_err();
  assert!(error.contains("too long"));
  assert!(conversation_messages(
    "Source",
    &[("Question".into(), "".into())],
    "Q",
    CompletionMode::FollowUp
  )
  .is_err());
  assert!(conversation_messages(
    "Source",
    &[],
    &"q".repeat(8193),
    CompletionMode::InitialAnswer
  )
  .is_err());
  assert!(conversation_messages(
    "Source",
    &[("Question".into(), "Invalid\0answer".into())],
    "Q",
    CompletionMode::FollowUp
  )
  .is_err());
}

#[test]
fn follow_up_disables_tools_and_cannot_create_a_note_even_if_provider_ignores_it() {
  tauri::async_runtime::block_on(async {
    let server = MockProvider::sequence(vec![response(json!({
      "content": "Further explanation",
      "reasoning_content": "New thinking",
      "tool_calls": [proposal("{\"content\":\"Unsolicited note\"}")],
    }))]);
    let result = complete_conversation(
      &client(),
      &server.settings(AiProviderKind::Deepseek),
      Some("test-only-token".into()),
      ConversationInput {
        source: "Paper source",
        history: &[("Original question".into(), "Original answer".into())],
        question: "Explain further",
        mode: CompletionMode::FollowUp,
      },
      &|_, _| {},
    )
    .await
    .unwrap();
    assert_eq!(result.answer, "Further explanation");
    assert_eq!(result.thinking, "New thinking");
    assert!(result.note_proposal.is_none());
    let requests = server.captured_all();
    assert_eq!(requests.len(), 1);
    let body = &requests[0].1;
    assert!(body.get("tools").is_none());
    assert!(body.get("tool_choice").is_none());
    assert_eq!(body["thinking"]["type"], "enabled");
    assert_eq!(body["messages"][3]["role"], "assistant");
    assert_eq!(body["messages"][3]["content"], "Original answer");
    assert!(body["messages"][3].get("reasoning_content").is_none());
  });
}

#[test]
fn explicit_note_returns_valid_tool_proposal_without_an_extra_answer_request() {
  tauri::async_runtime::block_on(async {
    for provider in [AiProviderKind::OpenaiCompatible, AiProviderKind::Deepseek] {
      let server = MockProvider::sequence(vec![response(json!({
        "content": null,
        "tool_calls": [proposal("{\"content\":\" A grounded takeaway with caveats. \"}")],
      }))]);
      let result = complete_conversation(
        &client(),
        &server.settings(provider),
        Some("test-only-token".into()),
        ConversationInput {
          source: "Paper source",
          history: &[("Question".into(), "Answer".into())],
          question: "Generate a note from the conversation.",
          mode: CompletionMode::GenerateNote,
        },
        &|_, _| {},
      )
      .await
      .unwrap();
      assert_eq!(
        result.note_proposal.as_deref(),
        Some("A grounded takeaway with caveats.")
      );
      assert!(result.proposal_warning.is_none());
      let requests = server.captured_all();
      assert_eq!(requests.len(), 1);
      let body = &requests[0].1;
      assert_eq!(body["tool_choice"], "required");
      assert_eq!(body["tools"][0]["function"]["name"], "propose_annotation");
      assert!(body["messages"][0]["content"]
        .as_str()
        .unwrap()
        .contains("explicitly requested a note"));
      if provider == AiProviderKind::Deepseek {
        assert_eq!(body["thinking"]["type"], "disabled");
      }
    }
  });
}

#[test]
fn explicit_note_rejects_plain_text_invalid_and_ambiguous_tool_proposals() {
  tauri::async_runtime::block_on(async {
    let invalid = [
      json!({"content": "A note as plain text"}),
      json!({"content": "Fallback text", "tool_calls": [proposal("{invalid")] }),
      json!({"content": "Fallback text", "tool_calls": [proposal("{\"content\":\" \"}")] }),
      json!({"content": "Fallback text", "tool_calls": [proposal("{\"content\":\"note\",\"annotation_id\":\"bad\"}")] }),
      json!({"content": "Fallback text", "tool_calls": [proposal("{\"content\":\"one\"}"), {"id": "call_2", "type": "function", "function": {"name": "propose_annotation", "arguments": "{\"content\":\"two\"}"}}] }),
    ];
    for message in invalid {
      let server = MockProvider::sequence(vec![response(message)]);
      let error = complete_conversation(
        &client(),
        &server.settings(AiProviderKind::OpenaiCompatible),
        None,
        ConversationInput {
          source: "Paper source",
          history: &[("Question".into(), "Answer".into())],
          question: "Generate note",
          mode: CompletionMode::GenerateNote,
        },
        &|_, _| {},
      )
      .await
      .unwrap_err();
      assert_eq!(error, INVALID_GENERATED_NOTE);
      assert_eq!(server.captured_all().len(), 1);
    }
  });
}

#[test]
fn explicit_note_reports_unsupported_tools_without_retrying_for_a_plain_answer() {
  tauri::async_runtime::block_on(async {
    let server = MockProvider::sequence(vec![(
      "400 Bad Request".into(),
      "application/json".into(),
      json!({"error": {"message": "This model does not support tools. secret-detail", "param": "tools"}}).to_string(),
    )]);
    let error = complete_conversation(
      &client(),
      &server.settings(AiProviderKind::OpenaiCompatible),
      None,
      ConversationInput {
        source: "Paper source",
        history: &[("Question".into(), "Answer".into())],
        question: "Generate note",
        mode: CompletionMode::GenerateNote,
      },
      &|_, _| {},
    )
    .await
    .unwrap_err();
    assert!(error.contains("does not support the tool calls"));
    assert!(!error.contains("secret-detail"));
    assert_eq!(server.captured_all().len(), 1);
  });
}
