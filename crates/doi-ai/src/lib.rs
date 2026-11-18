//! Portable Paper Reader policy. Apell owns transport; this crate owns prompts and drafts.
mod arxiv;
#[allow(dead_code)]
mod models;
mod prompts;
#[allow(dead_code)]
mod reading_layout;
#[allow(dead_code)]
mod validation;
mod workflow;
mod error {
  pub type Result<T> = std::result::Result<T, String>;
}
pub use workflow::*;

#[cfg(target_arch = "wasm32")]
mod wasm {
  use super::*;
  use serde::Serialize;
  use sha2::{Digest, Sha256};
  use wasm_bindgen::prelude::*;

  #[wasm_bindgen(js_name = validateRecord)]
  pub fn validate_record(kind: &str, value: JsValue) -> Result<(), JsValue> {
    fn decode<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T, String> {
      serde_wasm_bindgen::from_value(value).map_err(|e| e.to_string())
    }
    let result = match kind {
      "annotation" => decode(value).and_then(|v| super::validation::validate_annotation(&v)),
      "location" => decode(value).and_then(|v| super::validation::validate_location(&v)),
      "layout" => decode(value).and_then(|v| super::reading_layout::validate(&v)),
      _ => Err("Unknown record kind.".into()),
    };
    result.map_err(|e| JsValue::from_str(&e))
  }

  #[wasm_bindgen(js_name = parseArxivId)]
  pub fn parse_arxiv_id(value: &str) -> Result<String, JsValue> {
    super::arxiv::ArxivId::parse(value)
      .map(|id| id.canonical())
      .map_err(|e| JsValue::from_str(&e))
  }

  #[wasm_bindgen(js_name = parsePaperMetadata)]
  pub fn parse_paper_metadata(bytes: &[u8], requested: &str) -> Result<JsValue, JsValue> {
    let id = super::arxiv::ArxivId::parse(requested).map_err(|e| JsValue::from_str(&e))?;
    output(&super::arxiv::parse_metadata(bytes, &id).map_err(|e| JsValue::from_str(&e))?)
  }

  #[wasm_bindgen(js_name = hashBytes)]
  pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
  }

  fn output(value: &impl Serialize) -> Result<JsValue, JsValue> {
    value
      .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
      .map_err(|error| JsValue::from_str(&error.to_string()))
  }

  #[wasm_bindgen]
  pub struct AiWorkflow(Workflow);

  #[wasm_bindgen]
  impl AiWorkflow {
    #[wasm_bindgen(constructor)]
    pub fn new(input: JsValue) -> Result<AiWorkflow, JsValue> {
      let input = serde_wasm_bindgen::from_value(input)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
      Workflow::new(input)
        .map(Self)
        .map_err(|error| JsValue::from_str(&error))
    }

    pub fn request(&self, request_id: String) -> Result<JsValue, JsValue> {
      output(
        &self
          .0
          .request(request_id)
          .map_err(|error| JsValue::from_str(&error))?,
      )
    }

    pub fn accept(&mut self, result: JsValue) -> Result<JsValue, JsValue> {
      let result = serde_wasm_bindgen::from_value(result)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
      output(
        &self
          .0
          .accept(result)
          .map_err(|error| JsValue::from_str(&error))?,
      )
    }

    #[wasm_bindgen(js_name = supplyReads)]
    pub fn supply_reads(&mut self, results: JsValue) -> Result<(), JsValue> {
      let results = serde_wasm_bindgen::from_value(results)
        .map_err(|error| JsValue::from_str(&error.to_string()))?;
      self
        .0
        .supply_reads(results)
        .map_err(|error| JsValue::from_str(&error))
    }
  }
}
