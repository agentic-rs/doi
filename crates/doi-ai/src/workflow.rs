use crate::prompts::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const MAX_CONTEXT_BYTES: usize = 128 * 1024;
const MAX_NOTE_BYTES: usize = 32 * 1024;
const MAX_PDF_ROUNDS: usize = 3;
const MAX_PARALLEL_READS: usize = 4;
const MAX_READ_RESULT_BYTES: usize = 16 * 1024;
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
  #[serde(default)]
  pub read_pdf: bool,
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
  ReadPdf { calls: Vec<PdfCall> },
  Finished { completion: Completion },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "name", rename_all = "snake_case", deny_unknown_fields)]
pub enum PdfReadRequest {
  SearchDocument {
    query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_page: Option<u32>,
  },
  ReadPage {
    page_number: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<u32>,
  },
}

#[derive(Debug, Serialize)]
pub struct PdfCall {
  id: String,
  request: Option<PdfReadRequest>,
}

#[derive(Deserialize)]
pub struct PdfToolResult {
  pub tool_call_id: String,
  pub content: String,
}

fn pdf_call(call: &ToolCall) -> PdfCall {
  let parse = || {
    if call.arguments.len() > 2048 {
      return None;
    }
    let mut args: serde_json::Map<String, Value> = serde_json::from_str(&call.arguments).ok()?;
    if args.insert("name".into(), json!(call.name)).is_some() {
      return None;
    }
    let request: PdfReadRequest = serde_json::from_value(Value::Object(args)).ok()?;
    match &request {
      PdfReadRequest::SearchDocument { query, start_page } => {
        if query.trim().is_empty()
          || query.chars().count() > 256
          || query.chars().any(char::is_control)
          || *start_page == Some(0)
        {
          return None;
        }
      }
      PdfReadRequest::ReadPage { page_number, .. } if *page_number == 0 => return None,
      _ => {}
    }
    Some(request)
  };
  PdfCall {
    id: call.id.clone(),
    request: parse(),
  }
}

fn pdf_tools() -> Value {
  json!([
    {"name":"search_document", "description":"Find matching passages in this paper's PDF. Choose a short phrase or distinctive term.",
     "parameters":{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":256},"start_page":{"type":"integer","minimum":1}},"required":["query"],"additionalProperties":false}},
    {"name":"read_page", "description":"Read anchored passages from a one-based PDF page. Use the suggested offset to continue.",
     "parameters":{"type":"object","properties":{"page_number":{"type":"integer","minimum":1},"offset":{"type":"integer","minimum":0}},"required":["page_number"],"additionalProperties":false}}
  ])
}

pub struct Workflow {
  mode: Mode,
  read_pdf: bool,
  pending_reads: Vec<String>,
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
      // Completed user messages include the passages attached to that turn.
      require_text(question, MAX_CONTEXT_BYTES)?;
      require_text(answer, MAX_CONTEXT_BYTES)?;
      bytes = bytes.saturating_add(question.len() + answer.len() + 24);
    }
    if bytes > MAX_CONTEXT_BYTES {
      return Err(
        "This conversation is too long. Start a new conversation about the passage.".into(),
      );
    }
    let read_pdf = input.read_pdf && input.mode != Mode::GenerateNote;
    let extra = match input.mode {
      _ if read_pdf => PDF_READING_PROMPT,
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
      read_pdf,
      pending_reads: vec![],
      messages,
      tools_enabled: read_pdf || input.mode != Mode::FollowUp,
      round: 0,
      finished: false,
      note: None,
      note_provenance: None,
      warning: None,
      connection: None,
    })
  }

  pub fn request(&self, request_id: String) -> Result<Value, String> {
    if self.finished || !self.pending_reads.is_empty() {
      return Err("This AI operation is finished or waiting for PDF tool results.".into());
    }
    let mut request = json!({"request_id": request_id, "messages": self.messages});
    // The active Apell connection can change while the applet reads a PDF.
    // Route continuations to the original model before sending its history.
    if let Some((connection_id, requested_model)) = &self.connection {
      request["target"] = json!({"connection_id": connection_id, "model_id": requested_model});
    }
    // Keep the schemas for replayed tool calls on the last PDF round. Explicit
    // tool_choice=none requests the answer while preserving provider context.
    if self.tools_enabled || (self.read_pdf && self.round == MAX_PDF_ROUNDS) {
      request["tools"] = if self.read_pdf {
        pdf_tools()
      } else {
        json!([{
          "name": "propose_annotation",
          "description": "Prepare a concise plain-text note for user review. Nothing is saved.",
          "parameters": {"type": "object", "properties": {"content": {"type": "string", "minLength": 1, "maxLength": MAX_NOTE_BYTES}}, "required": ["content"], "additionalProperties": false}
        }])
      };
      request["tool_choice"] = json!(if !self.tools_enabled {
        "none"
      } else if self.mode == Mode::GenerateNote {
        "required"
      } else {
        "auto"
      });
    }
    Ok(request)
  }

  pub fn accept(&mut self, mut result: HostResult) -> Result<Step, String> {
    if self.finished || !self.pending_reads.is_empty() {
      return Err("This AI operation is finished or waiting for PDF tool results.".into());
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
    if unsupported_tools && (self.read_pdf || self.mode == Mode::InitialAnswer) && self.round == 0 {
      self.tools_enabled = false;
      if self.read_pdf {
        self.messages[0]["content"] = json!(format!("{SOURCE_PROMPT} {PDF_UNAVAILABLE_PROMPT}"));
      } else {
        self.warning = Some(MANUAL_NOTE.into());
      }
      self.round += 1;
      return Ok(Step::Continue);
    }
    if !matches!(result.status, Status::Completed | Status::ToolCalls) {
      return Ok(self.finish(result));
    }
    if result.status == Status::ToolCalls {
      if !self.tools_enabled || result.tool_calls.is_empty() {
        return Ok(self.fail(
          result,
          "unexpected_tools",
          "The model returned unexpected tool calls.",
        ));
      }
      if self.read_pdf {
        let calls = &result.tool_calls;
        if calls.len() > MAX_PARALLEL_READS
          || calls.iter().enumerate().any(|(i, c)| {
            c.id.is_empty()
              || c.id.len() > 256
              || calls[..i].iter().any(|previous| previous.id == c.id)
          })
        {
          return Ok(self.fail(
            result,
            "invalid_tool_batch",
            "The model returned too many PDF reads or ambiguous call identifiers.",
          ));
        }
        self.messages.push(
          result
            .message
            .take()
            .ok_or("The host omitted the replayable assistant message.")?,
        );
        self.pending_reads = calls.iter().map(|c| c.id.clone()).collect();
        self.round += 1;
        self.tools_enabled = self.round < MAX_PDF_ROUNDS;
        return Ok(Step::ReadPdf {
          calls: calls.iter().map(pdf_call).collect(),
        });
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

  pub fn supply_reads(&mut self, results: Vec<PdfToolResult>) -> Result<(), String> {
    if self.pending_reads.is_empty()
      || self.pending_reads.len() != results.len()
      || !self.pending_reads.iter().zip(&results).all(|(id, r)| {
        *id == r.tool_call_id && !r.content.is_empty() && r.content.len() <= MAX_READ_RESULT_BYTES
      })
    {
      return Err("The PDF tool results are incomplete, unrelated, or too large.".into());
    }
    for result in results {
      self
        .messages
        .push(json!({"role":"tool","tool_call_id":result.tool_call_id,"content":result.content}));
    }
    self.pending_reads.clear();
    Ok(())
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
