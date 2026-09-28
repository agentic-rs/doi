use super::{
  build_provider, provider_error,
  stream::{self, Emit},
  SYSTEM_PROMPT,
};
use crate::{
  error::Result,
  http,
  models::{AiProviderKind, AiSettings, AiStreamKind},
  validation,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokn_core::provider::{Endpoint, Provider, RequestCtx};
use tokn_headers::{AgentId, HeaderMap, TemplateVars};

const MAX_ROUNDS: usize = 2;
const MANUAL_NOTE: &str =
  "The model's note proposal could not be used. You can edit and save the answer instead.";

#[derive(Debug, Default)]
pub struct Completion {
  pub answer: String,
  pub thinking: String,
  pub note_proposal: Option<String>,
  pub proposal_warning: Option<String>,
}

pub async fn complete(
  client: &reqwest::Client,
  settings: &AiSettings,
  api_key: Option<String>,
  user_content: &str,
  emit: Emit<'_>,
) -> Result<Completion> {
  let provider = build_provider(settings, api_key)?;
  let mut messages = vec![
    json!({ "role": "system", "content": SYSTEM_PROMPT }),
    json!({ "role": "user", "content": user_content }),
  ];
  let mut tools_enabled = true;
  let mut result = Completion::default();
  emit(AiStreamKind::Status, "Waiting for the model…");
  for round in 0..MAX_ROUNDS {
    let response = loop {
      let response = send(
        client,
        provider.as_ref(),
        settings,
        &messages,
        tools_enabled,
      )
      .await?;
      if response.status().is_success() {
        break response;
      }
      let error = http::require_success(&response, "AI request").unwrap_err();
      if tools_enabled && round == 0 && matches!(response.status().as_u16(), 400 | 422) {
        let bytes = http::bounded_body(response, 16 * 1024, "AI request").await;
        if bytes.as_deref().is_ok_and(unsupported_tools) {
          tools_enabled = false;
          result.proposal_warning = Some(
            "This model does not support note proposals. You can edit and save its answer instead."
              .into(),
          );
          emit(
            AiStreamKind::Status,
            "This model supports answers without note proposals. Asking again…",
          );
          continue;
        }
      }
      return Err(error);
    };
    if round > 0 && !result.thinking.is_empty() {
      if result.thinking.len() + 2 > validation::MAX_TEXT_BYTES {
        return Err("AI request returned too much data.".into());
      }
      result.thinking.push_str("\n\n");
      emit(AiStreamKind::ThinkingDelta, "\n\n");
    }
    let turn = stream::read_response(
      response,
      emit,
      validation::MAX_TEXT_BYTES - result.thinking.len(),
    )
    .await?;
    if result.thinking.len() + turn.thinking.len() > validation::MAX_TEXT_BYTES {
      return Err("AI request returned too much data.".into());
    }
    result.thinking.push_str(&turn.thinking);
    let mut tool_results = Vec::new();
    let mut accepted_proposal = false;
    for tool in turn.tools.values() {
      let proposed = parse_proposal(tool);
      let accepted = proposed.is_some();
      accepted_proposal |= accepted;
      if let Some(content) = proposed {
        if result.note_proposal.is_none() {
          result.note_proposal = Some(content);
        }
      } else {
        result.proposal_warning = Some(MANUAL_NOTE.into());
      }
      tool_results.push(json!({
        "role": "tool", "tool_call_id": tool.id,
        "content": if accepted {
          "The note is prepared as an editable draft. Nothing has been saved. Now provide the answer to the user's question as ordinary text."
        } else {
          "The note proposal was invalid. Nothing has been saved. Provide the answer to the user's question as ordinary text."
        }
      }));
    }
    if turn.tool_warning {
      result.proposal_warning = Some(MANUAL_NOTE.into());
    }
    if !turn.answer.trim().is_empty() && !accepted_proposal {
      validation::require_text(&turn.answer, "AI answer", validation::MAX_TEXT_BYTES)?;
      result.answer = turn.answer;
      return Ok(result);
    }
    if turn.tools.is_empty() || round + 1 == MAX_ROUNDS {
      return Err("The provider returned no text answer. Check the model and try again.".into());
    }
    // Text accompanying a tool call may only be a preamble. Request one final
    // answer after returning the draft result, keeping the original assistant
    // reasoning/content/tool sequence required by thinking providers.
    if let Some(message) = turn.assistant_message() {
      messages.push(message);
      messages.extend(tool_results);
    } else {
      // An invalid tool envelope cannot be safely replayed as chat history.
      // Retry the original question once without tools to obtain usable text.
      result.proposal_warning = Some(MANUAL_NOTE.into());
    }
    tools_enabled = false;
    if !turn.answer.is_empty() {
      emit(AiStreamKind::AnswerDelta, "\n\n");
    }
    emit(AiStreamKind::Status, "Preparing the answer…");
  }
  Err("The provider returned no text answer. Check the model and try again.".into())
}

async fn send(
  client: &reqwest::Client,
  provider: &dyn Provider,
  settings: &AiSettings,
  messages: &[Value],
  tools_enabled: bool,
) -> Result<reqwest::Response> {
  let mut body = json!({"model": settings.model_id, "messages": messages, "stream": true});
  if settings.provider_kind == AiProviderKind::Deepseek {
    body["thinking"] = json!({"type": "enabled"});
  }
  if tools_enabled {
    body["tools"] = json!([{
      "type": "function",
      "function": {
        "name": "propose_annotation",
        "description": "Prepare a concise plain-text note for the user's review. This does not save anything. Include the useful takeaway and relevant caveats, not your thinking process.",
        "parameters": {
          "type": "object", "properties": {"content": {"type": "string", "minLength": 1, "maxLength": validation::MAX_AI_NOTE_BYTES}},
          "required": ["content"], "additionalProperties": false
        }
      }
    }]);
    body["tool_choice"] = json!("auto");
  }
  if let Some(transformer) = provider.input_transformer() {
    body = transformer
      .transform_input(Endpoint::ChatCompletions, body)
      .map_err(|error| provider_error("AI request", error))?;
  }
  provider
    .chat(RequestCtx {
      endpoint: Endpoint::ChatCompletions,
      http: client,
      body: &body,
      body_bytes: None,
      content_encoding: None,
      stream: true,
      initiator: "user",
      inbound_headers: &HeaderMap::new(),
      client_headers: None,
      outbound: None,
      vars: TemplateVars::default(),
      agent_id: AgentId::from("papertrail"),
    })
    .await
    .map_err(|error| provider_error("AI request", error))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Proposal {
  content: String,
}

fn parse_proposal(tool: &stream::ToolCall) -> Option<String> {
  if tool.invalid
    || tool.name != "propose_annotation"
    || tool.id.is_empty()
    || tool.id.chars().any(char::is_control)
  {
    return None;
  }
  let Proposal { content } = serde_json::from_str(&tool.arguments).ok()?;
  let content = content.trim().to_owned();
  if content
    .chars()
    .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
  {
    return None;
  }
  validation::require_text(&content, "note proposal", validation::MAX_AI_NOTE_BYTES).ok()?;
  Some(content)
}

fn unsupported_tools(bytes: &[u8]) -> bool {
  let Ok(value) = serde_json::from_slice::<Value>(bytes) else {
    return false;
  };
  let message = value["error"]["message"]
    .as_str()
    .or_else(|| value["message"].as_str())
    .unwrap_or("")
    .to_ascii_lowercase();
  let parameter = value["error"]["param"]
    .as_str()
    .unwrap_or("")
    .to_ascii_lowercase();
  let names_tools = [
    "tools",
    "tool_choice",
    "function calling",
    "function_call",
    "tool calling",
  ]
  .iter()
  .any(|word| message.contains(word) || parameter == *word);
  let unsupported = [
    "not support",
    "unsupported",
    "not available",
    "unknown parameter",
    "unrecognized request argument",
    "not allowed",
  ]
  .iter()
  .any(|word| message.contains(word));
  names_tools && unsupported
}

#[cfg(test)]
mod tests;
