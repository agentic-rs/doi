use crate::{
  error::{network_error, Result},
  http,
  models::AiStreamKind,
  validation,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const MAX_STREAM_BYTES: usize = 2 * 1024 * 1024;
const MAX_EVENT_BYTES: usize = 256 * 1024;
const MAX_TOOL_CALLS: usize = 8;
pub type Emit<'a> = &'a (dyn Fn(AiStreamKind, &str) + Sync);

#[derive(Debug, Default)]
pub struct Turn {
  pub answer: String,
  pub thinking: String,
  pub tools: BTreeMap<usize, ToolCall>,
  pub tool_warning: bool,
  finish_reason: Option<String>,
  reasoning_key: Option<&'static str>,
  thinking_limit: Option<usize>,
}

#[derive(Debug, Default)]
pub struct ToolCall {
  pub id: String,
  pub name: String,
  pub arguments: String,
  pub invalid: bool,
}

impl Turn {
  fn ingest(&mut self, value: Value, streamed: bool, emit: Emit<'_>) -> Result<()> {
    if value.get("error").is_some() {
      return Err("The provider reported an error while answering. Try again.".into());
    }
    let choices = value["choices"].as_array().ok_or_else(incompatible)?;
    if choices.is_empty() {
      return Ok(());
    } // Final usage-only stream frame.
    let choice = choices
      .iter()
      .find(|choice| choice["index"].as_u64().unwrap_or(0) == 0)
      .ok_or_else(incompatible)?;
    if let Some(reason) = choice["finish_reason"].as_str() {
      if self
        .finish_reason
        .as_deref()
        .is_some_and(|existing| existing != reason)
      {
        return Err(incompatible());
      }
      self.finish_reason = Some(reason.to_owned());
    }
    let message = if streamed {
      &choice["delta"]
    } else {
      &choice["message"]
    };
    if message.is_null() {
      return Ok(());
    }
    let answer = text_content(&message["content"]);
    if !answer.is_empty() {
      append(&mut self.answer, &answer, validation::MAX_TEXT_BYTES)?;
      emit(AiStreamKind::AnswerDelta, &answer);
    }
    // Expose only reasoning explicitly supplied by the provider, never infer it
    // from the answer. Keep its original key/text for tool continuation history.
    let reasoning = ["reasoning_content", "reasoning"]
      .into_iter()
      .find_map(|key| message[key].as_str().map(|text| (key, text)));
    if let Some((key, text)) = reasoning {
      if self.reasoning_key.is_some_and(|existing| existing != key) {
        return Err(incompatible());
      }
      self.reasoning_key = Some(key);
      append(
        &mut self.thinking,
        text,
        self.thinking_limit.unwrap_or(validation::MAX_TEXT_BYTES),
      )?;
      if !text.is_empty() {
        emit(AiStreamKind::ThinkingDelta, text);
      }
    }
    if let Some(calls) = message["tool_calls"].as_array() {
      for (position, call) in calls.iter().enumerate() {
        let index = if streamed {
          let Some(index) = call["index"]
            .as_u64()
            .filter(|index| *index < MAX_TOOL_CALLS as u64)
          else {
            self.tool_warning = true;
            continue;
          };
          index as usize
        } else {
          position
        };
        if index >= MAX_TOOL_CALLS {
          self.tool_warning = true;
          continue;
        }
        let tool = self.tools.entry(index).or_default();
        if let Some(kind) = call["type"].as_str() {
          tool.invalid |= kind != "function";
        }
        if let Some(id) = call["id"].as_str() {
          tool.invalid |= append(&mut tool.id, id, 512).is_err();
        }
        if let Some(name) = call["function"]["name"].as_str() {
          tool.invalid |= append(&mut tool.name, name, 256).is_err();
        }
        if let Some(arguments) = call["function"]["arguments"].as_str() {
          tool.invalid |= append(&mut tool.arguments, arguments, MAX_EVENT_BYTES).is_err();
        }
      }
    } else if !message["tool_calls"].is_null() {
      self.tool_warning = true;
    }
    Ok(())
  }

  pub fn validate(&self) -> Result<()> {
    match self.finish_reason.as_deref() {
      Some("stop" | "tool_calls") => Ok(()),
      Some("length" | "model_context_window_exceeded") => Err("The model reached its response limit before finishing. Try a more focused question or another model.".into()),
      Some("content_filter" | "sensitive") => Err("The provider stopped this response because of its content policy.".into()),
      Some(_) => Err("The provider stopped before completing its answer. Try again.".into()),
      None => Err("The provider connection ended before the answer was complete. Try again.".into()),
    }
  }

  pub fn assistant_message(&self) -> Option<Value> {
    if self.tool_warning
      || self.tools.values().any(|tool| {
        tool.invalid
          || tool.id.is_empty()
          || tool.id.chars().any(char::is_control)
          || tool.name.is_empty()
      })
    {
      return None;
    }
    let mut message = json!({"role": "assistant", "content": if self.answer.is_empty() { Value::Null } else { json!(self.answer) }});
    if let Some(key) = self.reasoning_key {
      message[key] = json!(self.thinking);
    }
    if !self.tools.is_empty() {
      message["tool_calls"] = json!(self.tools.values().map(|tool| json!({
        "id": tool.id, "type": "function", "function": {"name": tool.name, "arguments": tool.arguments}
      })).collect::<Vec<_>>());
    }
    Some(message)
  }
}

fn text_content(content: &Value) -> String {
  match content {
    Value::String(text) => text.clone(),
    Value::Array(parts) => parts
      .iter()
      .filter_map(|part| {
        (part["type"].as_str() == Some("text"))
          .then(|| part["text"].as_str())
          .flatten()
      })
      .collect::<Vec<_>>()
      .join("\n"),
    _ => String::new(),
  }
}

fn append(target: &mut String, text: &str, limit: usize) -> Result<()> {
  if target.len().saturating_add(text.len()) > limit {
    return Err("AI request returned too much data.".into());
  }
  target.push_str(text);
  Ok(())
}

fn incompatible() -> String {
  "The provider did not return a compatible chat-completions response.".into()
}

#[derive(Default)]
struct SseDecoder {
  pending: Vec<u8>,
  data: String,
  event: String,
  total: usize,
  done: bool,
  skip_lf: bool,
  saw_line: bool,
  turn: Turn,
}

impl SseDecoder {
  fn push(&mut self, bytes: &[u8], emit: Emit<'_>) -> Result<()> {
    self.total = self.total.saturating_add(bytes.len());
    if self.total > MAX_STREAM_BYTES {
      return Err("AI request returned too much data.".into());
    }
    self.pending.extend_from_slice(bytes);
    loop {
      if self.pending.is_empty() {
        break;
      }
      if self.skip_lf {
        self.skip_lf = false;
        if self.pending[0] == b'\n' {
          self.pending.remove(0);
        }
      }
      let Some(end) = self
        .pending
        .iter()
        .position(|byte| matches!(*byte, b'\n' | b'\r'))
      else {
        break;
      };
      let line = self.pending.drain(..=end).collect::<Vec<_>>();
      self.skip_lf = line.last() == Some(&b'\r');
      let line = &line[..line.len() - 1];
      self.line(line, emit)?;
    }
    if self.pending.len() > MAX_EVENT_BYTES {
      return Err("AI request returned too much data.".into());
    }
    Ok(())
  }

  fn line(&mut self, bytes: &[u8], emit: Emit<'_>) -> Result<()> {
    if bytes.len() > MAX_EVENT_BYTES {
      return Err("AI request returned too much data.".into());
    }
    let line = std::str::from_utf8(bytes).map_err(|_| incompatible())?;
    let line = if !self.saw_line {
      line.strip_prefix('\u{feff}').unwrap_or(line)
    } else {
      line
    };
    self.saw_line = true;
    if line.is_empty() {
      return self.dispatch(emit);
    }
    if line.starts_with(':') {
      return Ok(());
    }
    let (field, value) = line.split_once(':').unwrap_or((line, ""));
    let value = value.strip_prefix(' ').unwrap_or(value);
    match field {
      "data" => {
        append(&mut self.data, value, MAX_EVENT_BYTES)?;
        append(&mut self.data, "\n", MAX_EVENT_BYTES)?;
      }
      "event" => {
        self.event = value.to_owned();
      }
      _ => {}
    }
    Ok(())
  }

  fn dispatch(&mut self, emit: Emit<'_>) -> Result<()> {
    if self.event == "error" {
      return Err("The provider reported an error while answering. Try again.".into());
    }
    self.event.clear();
    if self.data.is_empty() {
      return Ok(());
    }
    let data = std::mem::take(&mut self.data);
    if self.done {
      return Err(incompatible());
    }
    if data.trim() == "[DONE]" {
      self.done = true;
      return Ok(());
    }
    let value = serde_json::from_str(data.trim_end()).map_err(|_| incompatible())?;
    self.turn.ingest(value, true, emit)
  }

  fn finish(self) -> Result<Turn> {
    // Incomplete SSE frames must never masquerade as a successful response.
    if !self.pending.is_empty() || !self.data.is_empty() {
      return Err(
        "The provider connection ended before the answer was complete. Try again.".into(),
      );
    }
    self.turn.validate()?;
    Ok(self.turn)
  }
}

pub async fn read_response(
  mut response: reqwest::Response,
  emit: Emit<'_>,
  thinking_budget: usize,
) -> Result<Turn> {
  let streaming = response
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .is_some_and(|value| {
      value
        .split(';')
        .next()
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream"))
    });
  if !streaming {
    let bytes = http::bounded_body(response, MAX_STREAM_BYTES, "AI request").await?;
    let value = serde_json::from_slice(&bytes).map_err(|_| incompatible())?;
    let mut turn = Turn {
      thinking_limit: Some(thinking_budget),
      ..Turn::default()
    };
    turn.ingest(value, false, emit)?;
    turn.validate()?;
    return Ok(turn);
  }
  let mut decoder = SseDecoder {
    turn: Turn {
      thinking_limit: Some(thinking_budget),
      ..Turn::default()
    },
    ..SseDecoder::default()
  };
  while let Some(chunk) = response
    .chunk()
    .await
    .map_err(|error| network_error("AI request", error))?
  {
    decoder.push(&chunk, emit)?;
    if decoder.done {
      break;
    }
  }
  decoder.finish()
}

#[cfg(test)]
mod tests;
