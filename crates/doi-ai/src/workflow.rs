use crate::prompts::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_CONTEXT_BYTES: usize = 128 * 1024;
const MAX_NOTE_BYTES: usize = 32 * 1024;
const MANUAL_NOTE: &str =
  "The model did not provide a valid note proposal. You can edit and save the answer instead.";

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
  InitialAnswer,
  FollowUp,
  GenerateNote,
}

#[derive(Deserialize)]
pub struct Input {
  pub source: String,
  /// Only completed turns belong here; interrupted responses must be excluded.
  pub history: Vec<(String, String)>,
  pub question: String,
  pub mode: Mode,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Provenance {
  pub connection_id: String,
  pub requested_model_id: String,
  pub model_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ToolCall {
  pub id: String,
  pub name: String,
  pub arguments: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
  Completed,
  ToolCalls,
  Cancelled,
  Truncated,
  Unsupported,
  Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Failure {
  pub code: String,
  pub message: String,
  pub capability: Option<String>,
  pub retryable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct HostResult {
  pub request_id: String,
  pub content: String,
  pub tool_calls: Vec<ToolCall>,
  pub message: Option<Value>,
  pub status: Status,
  pub provenance: Provenance,
  pub error: Option<Failure>,
}

#[derive(Debug, Serialize)]
pub struct Completion {
  pub answer: String,
  pub note_proposal: Option<String>,
  pub proposal_warning: Option<String>,
  pub provenance: Provenance,
  pub note_provenance: Option<Provenance>,
  pub status: Status,
  pub error: Option<Failure>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Step {
  Continue,
  Finished { completion: Completion },
}

pub struct Workflow {
  mode: Mode,
  messages: Vec<Value>,
  tools_enabled: bool,
  round: usize,
  finished: bool,
  note: Option<String>,
  note_provenance: Option<Provenance>,
  warning: Option<String>,
  connection: Option<(String, String)>,
}

fn require_text(value: &str, limit: usize) -> Result<(), String> {
  if value.trim().is_empty() || value.len() > limit || value.contains('\0') {
    return Err("AI text is empty, invalid, or exceeds its size limit.".into());
  }
  Ok(())
}

fn proposal(call: &ToolCall) -> Option<String> {
  #[derive(Deserialize)]
  #[serde(deny_unknown_fields)]
  struct Proposal {
    content: String,
  }
  if call.name != "propose_annotation" || call.id.is_empty() {
    return None;
  }
  let parsed: Proposal = serde_json::from_str(&call.arguments).ok()?;
  let content = parsed.content.trim();
  require_text(content, MAX_NOTE_BYTES).ok()?;
  if content
    .chars()
    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
  {
    return None;
  }
  Some(content.into())
}

impl Workflow {
  pub fn new(input: Input) -> Result<Self, String> {
    require_text(&input.source, MAX_CONTEXT_BYTES)?;
    require_text(&input.question, 8192)?;
    if input.history.len() > 64 {
      return Err("Start a new conversation after 64 turns.".into());
    }
    let mut bytes = input.source.len() + input.question.len();
    for (question, answer) in &input.history {
      require_text(question, 8192)?;
      require_text(answer, MAX_CONTEXT_BYTES)?;
      bytes = bytes.saturating_add(question.len() + answer.len() + 24);
    }
    if bytes > MAX_CONTEXT_BYTES {
      return Err(
        "This conversation is too long. Start a new conversation about the passage.".into(),
      );
    }
    let extra = match input.mode {
      Mode::InitialAnswer => INITIAL_NOTE_PROMPT,
      Mode::GenerateNote => GENERATE_NOTE_PROMPT,
      Mode::FollowUp => "",
    };
    let mut messages = vec![
      json!({"role": "system", "content": format!("{SOURCE_PROMPT} {extra}")}),
      json!({"role": "user", "content": format!("Quoted paper source:\n{}", input.source)}),
    ];
    for (question, answer) in input.history {
      messages.push(json!({"role": "user", "content": question}));
      messages.push(json!({"role": "assistant", "content": answer}));
    }
    messages.push(json!({"role": "user", "content": input.question}));
    Ok(Self {
      mode: input.mode,
      messages,
      tools_enabled: input.mode != Mode::FollowUp,
      round: 0,
      finished: false,
      note: None,
      note_provenance: None,
      warning: None,
      connection: None,
    })
  }

  pub fn request(&self, request_id: String) -> Result<Value, String> {
    if self.finished {
      return Err("This AI operation has already finished.".into());
    }
    let mut request = json!({"request_id": request_id, "messages": self.messages});
    if self.tools_enabled {
      request["tools"] = json!([{
        "name": "propose_annotation",
        "description": "Prepare a concise plain-text note for user review. Nothing is saved.",
        "parameters": {"type": "object", "properties": {"content": {"type": "string", "minLength": 1, "maxLength": MAX_NOTE_BYTES}}, "required": ["content"], "additionalProperties": false}
      }]);
      request["tool_choice"] = json!(if self.mode == Mode::GenerateNote {
        "required"
      } else {
        "auto"
      });
    }
    Ok(request)
  }

  pub fn accept(&mut self, mut result: HostResult) -> Result<Step, String> {
    if self.finished {
      return Err("This AI operation has already finished.".into());
    }
    let binding = (
      result.provenance.connection_id.clone(),
      result.provenance.requested_model_id.clone(),
    );
    if self
      .connection
      .as_ref()
      .is_some_and(|previous| previous != &binding)
    {
      return Ok(self.fail(
        result,
        "connection_changed",
        "The model connection changed during the answer. Please retry.",
      ));
    }
    self.connection = Some(binding);
    if result.content.len() > MAX_CONTEXT_BYTES || result.content.contains('\0') {
      result.content = result
        .content
        .chars()
        .filter(|c| *c != '\0')
        .scan(0, |size, c| {
          *size += c.len_utf8();
          (*size <= MAX_CONTEXT_BYTES).then_some(c)
        })
        .collect();
      return Ok(self.fail(
        result,
        "answer_limit",
        "The answer exceeded Paper Reader's text limit.",
      ));
    }
    // Only a positively identified tools limitation permits one text-only fallback.
    let unsupported_tools = result.status == Status::Unsupported
      && result
        .error
        .as_ref()
        .is_some_and(|e| e.capability.as_deref() == Some("tools"));
    if unsupported_tools && self.mode == Mode::InitialAnswer && self.round == 0 {
      self.tools_enabled = false;
      self.warning = Some(MANUAL_NOTE.into());
      self.round += 1;
      return Ok(Step::Continue);
    }
    if !matches!(result.status, Status::Completed | Status::ToolCalls) {
      return Ok(self.finish(result));
    }
    if result.status == Status::ToolCalls {
      if !self.tools_enabled || self.round != 0 || result.tool_calls.is_empty() {
        return Ok(self.fail(
          result,
          "unexpected_tools",
          "The model returned unexpected tool calls.",
        ));
      }
      if self.mode == Mode::GenerateNote {
        if result.tool_calls.len() != 1 || proposal(&result.tool_calls[0]).is_none() {
          return Ok(self.fail(
            result,
            "invalid_note",
            "The model did not return one valid note. Your existing draft is unchanged.",
          ));
        }
        self.note = proposal(&result.tool_calls[0]);
        self.note_provenance = Some(result.provenance.clone());
        // The operation is complete once the required proposal is validated.
        result.status = Status::Completed;
        return Ok(self.finish(result));
      }
      self.messages.push(
        result
          .message
          .clone()
          .ok_or("The host omitted the replayable assistant message.")?,
      );
      for call in &result.tool_calls {
        let note = proposal(call);
        let accepted = note.is_some() && self.note.is_none();
        if accepted {
          self.note = note;
          self.note_provenance = Some(result.provenance.clone());
        } else {
          self.warning = Some(MANUAL_NOTE.into());
        }
        self.messages.push(json!({"role": "tool", "tool_call_id": call.id,
          "content": if accepted { "Draft prepared for review; nothing saved. Now answer the user's question as ordinary text." }
            else { "Proposal rejected; nothing saved. Now answer the user's question as ordinary text." }}));
      }
      self.tools_enabled = false;
      self.round += 1;
      return Ok(Step::Continue);
    }
    if self.mode == Mode::GenerateNote
      || result.content.trim().is_empty()
      || !result.tool_calls.is_empty()
    {
      return Ok(self.fail(
        result,
        "invalid_completion",
        "The model did not return the required answer or note. Your existing draft is unchanged.",
      ));
    }
    Ok(self.finish(result))
  }

  fn fail(&mut self, mut result: HostResult, code: &str, message: &str) -> Step {
    result.status = Status::Failed;
    result.error = Some(Failure {
      code: code.into(),
      message: message.into(),
      capability: None,
      retryable: false,
    });
    self.finish(result)
  }

  fn finish(&mut self, result: HostResult) -> Step {
    self.finished = true;
    let successful = result.status == Status::Completed;
    Step::Finished {
      completion: Completion {
        answer: result.content,
        note_proposal: if successful { self.note.take() } else { None },
        note_provenance: if successful {
          self.note_provenance.take()
        } else {
          None
        },
        proposal_warning: self.warning.take(),
        provenance: result.provenance,
        status: result.status,
        error: result.error,
      },
    }
  }
}

#[cfg(test)]
mod tests;
