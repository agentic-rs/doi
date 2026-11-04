use super::*;

fn workflow(mode: Mode) -> Workflow {
  Workflow::new(Input {
    source: "Quoted paper".into(),
    history: vec![],
    question: "Explain".into(),
    mode,
  })
  .unwrap()
}

fn result(status: Status) -> HostResult {
  HostResult {
    request_id: "request".into(),
    content: "Answer".into(),
    status,
    tool_calls: vec![],
    message: None,
    error: None,
    provenance: Provenance {
      connection_id: "connection".into(),
      requested_model_id: "alias".into(),
      model_id: Some("actual".into()),
    },
  }
}

fn tool_result() -> HostResult {
  let mut value = result(Status::ToolCalls);
  value.tool_calls = vec![ToolCall {
    id: "call_1".into(),
    name: "propose_annotation".into(),
    arguments: r#"{"content":"Useful note"}"#.into(),
  }];
  value.message = Some(
    json!({"role":"assistant", "content":value.content, "tool_calls":value.tool_calls, "provider_state":{"token":"opaque"}}),
  );
  value
}

fn finished(step: Step) -> Completion {
  match step {
    Step::Finished { completion } => completion,
    _ => panic!("expected completion"),
  }
}

#[test]
fn tool_continuation_preserves_assistant_and_opaque_metadata() {
  let mut flow = workflow(Mode::InitialAnswer);
  let first = tool_result();
  assert!(matches!(
    flow.accept(first.clone()).unwrap(),
    Step::Continue
  ));
  let request = flow.request("second".into()).unwrap();
  assert!(request.get("tools").is_none());
  assert_eq!(request["messages"][3]["content"], first.content);
  assert_eq!(request["messages"][3]["provider_state"]["token"], "opaque");
  assert_eq!(request["messages"][4]["tool_call_id"], "call_1");
  let completion = finished(flow.accept(result(Status::Completed)).unwrap());
  assert_eq!(completion.note_proposal.as_deref(), Some("Useful note"));
  assert_eq!(completion.provenance.model_id.as_deref(), Some("actual"));
  assert!(flow.request("third".into()).is_err());
}

#[test]
fn generated_note_requires_exactly_one_valid_schema() {
  for arguments in [
    r#"{"content":""}"#,
    r#"{"content":"note","extra":true}"#,
    r#"{"content":7}"#,
  ] {
    let mut flow = workflow(Mode::GenerateNote);
    let mut value = tool_result();
    value.tool_calls[0].arguments = arguments.into();
    let completion = finished(flow.accept(value).unwrap());
    assert_eq!(completion.status, Status::Failed);
    assert!(completion.note_proposal.is_none());
  }
  let mut flow = workflow(Mode::GenerateNote);
  let mut value = tool_result();
  value.tool_calls.push(value.tool_calls[0].clone());
  assert_eq!(finished(flow.accept(value).unwrap()).status, Status::Failed);
  let mut flow = workflow(Mode::GenerateNote);
  assert_eq!(
    flow.request("id".into()).unwrap()["tool_choice"],
    "required"
  );
  assert_eq!(
    finished(flow.accept(tool_result()).unwrap()).status,
    Status::Completed
  );
}

#[test]
fn partial_outcomes_never_expose_a_draft_for_saving() {
  for status in [
    Status::Cancelled,
    Status::Truncated,
    Status::Unsupported,
    Status::Failed,
  ] {
    let mut flow = workflow(Mode::InitialAnswer);
    flow.accept(tool_result()).unwrap();
    let completion = finished(flow.accept(result(status.clone())).unwrap());
    assert_eq!(completion.status, status);
    assert_eq!(completion.answer, "Answer");
    assert!(completion.note_proposal.is_none());
    assert!(completion.note_provenance.is_none());
  }
}

#[test]
fn follows_up_without_tools_and_rejects_unsolicited_calls() {
  let mut flow = workflow(Mode::FollowUp);
  assert!(flow
    .request("request".into())
    .unwrap()
    .get("tools")
    .is_none());
  assert_eq!(
    finished(flow.accept(tool_result()).unwrap()).status,
    Status::Failed
  );
}

#[test]
fn required_note_does_not_fall_back_to_ordinary_text() {
  let mut flow = workflow(Mode::GenerateNote);
  assert_eq!(
    finished(flow.accept(result(Status::Completed)).unwrap()).status,
    Status::Failed
  );
}

#[test]
fn fallback_is_bounded_and_only_for_confirmed_tools_limitation() {
  let mut unsupported = result(Status::Unsupported);
  unsupported.error = Some(Failure {
    code: "unsupported_capability".into(),
    message: "Tools unavailable".into(),
    capability: Some("tools".into()),
    retryable: false,
  });
  let mut flow = workflow(Mode::InitialAnswer);
  assert!(matches!(
    flow.accept(unsupported.clone()).unwrap(),
    Step::Continue
  ));
  assert!(flow.request("next".into()).unwrap().get("tools").is_none());
  assert_eq!(
    finished(flow.accept(unsupported.clone()).unwrap()).status,
    Status::Unsupported
  );
  let mut flow = workflow(Mode::GenerateNote);
  assert_eq!(
    finished(flow.accept(unsupported).unwrap()).status,
    Status::Unsupported
  );
  let mut flow = workflow(Mode::InitialAnswer);
  assert_eq!(
    finished(flow.accept(result(Status::Failed)).unwrap()).status,
    Status::Failed
  );
}

#[test]
fn connection_changes_between_rounds_invalidate_the_draft() {
  let mut flow = workflow(Mode::InitialAnswer);
  flow.accept(tool_result()).unwrap();
  let mut next = result(Status::Completed);
  next.provenance.connection_id = "different".into();
  let completion = finished(flow.accept(next).unwrap());
  assert_eq!(completion.error.unwrap().code, "connection_changed");
  assert!(completion.note_proposal.is_none());
}

#[test]
fn context_is_bounded_without_silent_trimming() {
  let input = Input {
    source: "s".repeat(MAX_CONTEXT_BYTES),
    history: vec![],
    question: "Question".into(),
    mode: Mode::FollowUp,
  };
  assert!(Workflow::new(input).is_err());
  let input = Input {
    source: "Source".into(),
    history: vec![("Question".into(), "Answer".into())],
    question: "Follow up".into(),
    mode: Mode::FollowUp,
  };
  let request = Workflow::new(input).unwrap().request("id".into()).unwrap();
  assert_eq!(request["messages"][2]["role"], "user");
  assert_eq!(request["messages"][3]["role"], "assistant");
  assert_eq!(request["messages"][4]["content"], "Follow up");
}

#[test]
fn unknown_actual_model_stays_unknown() {
  let mut flow = workflow(Mode::FollowUp);
  let mut value = result(Status::Completed);
  value.provenance.model_id = None;
  let completion = finished(flow.accept(value).unwrap());
  assert!(completion.provenance.model_id.is_none());
  assert_eq!(completion.provenance.requested_model_id, "alias");
}
