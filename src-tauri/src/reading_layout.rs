use crate::{error::Result, models::ReadingLayout, validation};
use std::collections::HashSet;

pub const LAYOUT_VERSION: u32 = 4;
pub const MAX_LAYOUT_BYTES: usize = 16 * 1024 * 1024;

pub fn validate(layout: &ReadingLayout) -> Result<()> {
  if layout.layout_version != LAYOUT_VERSION {
    return Err("Unsupported reading layout version.".into());
  }
  if layout.pdf_hash.len() != 64 || !layout.pdf_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
    return Err("A reading layout must identify the original PDF hash.".into());
  }
  if layout.page_count == 0 || layout.page_count > 10_000 || layout.blocks.len() > 100_000 {
    return Err("The reading layout has an invalid page or block count.".into());
  }
  let mut ids = HashSet::with_capacity(layout.blocks.len());
  let mut text_bytes = 0;
  let mut pages = HashSet::new();
  for block in &layout.blocks {
    validation::validate_id(&block.block_id)?;
    if !ids.insert(&block.block_id) {
      return Err("Reading layout block identifiers must be unique.".into());
    }
    if block.page_number == 0 || block.page_number > layout.page_count {
      return Err("A reading layout block is outside the document.".into());
    }
    pages.insert(block.page_number);
    let [left, bottom, right, top] = block.source_rect;
    if block
      .source_rect
      .iter()
      .any(|value| !value.is_finite() || value.abs() > 1_000_000.0)
      || left >= right
      || bottom >= top
    {
      return Err("Reading layout rectangles must enclose a finite PDF region.".into());
    }
    validation::bound_text(
      &block.text,
      "reading block text",
      validation::MAX_TEXT_BYTES,
    )?;
    if let Some(label) = &block.figure_label {
      validation::require_text(label, "figure label", 128)?;
    }
    text_bytes += block.block_id.len() + block.text.len();
    text_bytes += block.figure_label.as_ref().map_or(0, String::len);
    if text_bytes > MAX_LAYOUT_BYTES {
      return Err("The reading layout is too large to cache.".into());
    }
  }
  if pages.len() != layout.page_count as usize {
    return Err("A reading layout must retain content from every source page.".into());
  }
  Ok(())
}

pub fn encode(layout: &ReadingLayout) -> Result<String> {
  validate(layout)?;
  let data = serde_json::to_string(layout)
    .map_err(|_| "Could not serialize the reading layout.".to_string())?;
  if data.len() > MAX_LAYOUT_BYTES {
    return Err("The reading layout is too large to cache.".into());
  }
  Ok(data)
}

// Derived data is disposable: damaged, stale, or unsupported caches are misses.
pub fn decode(data: &str, pdf_hash: &str) -> Option<ReadingLayout> {
  if data.len() > MAX_LAYOUT_BYTES {
    return None;
  }
  let layout: ReadingLayout = serde_json::from_str(data).ok()?;
  if layout.pdf_hash != pdf_hash || validate(&layout).is_err() {
    return None;
  }
  Some(layout)
}

#[cfg(test)]
pub(crate) mod tests {
  use super::*;
  use crate::models::{ReadingBlock, ReadingBlockKind, ReadingBlockType};

  pub(crate) fn fixture_layout(pdf_hash: String) -> ReadingLayout {
    ReadingLayout {
      layout_version: LAYOUT_VERSION,
      pdf_hash,
      page_count: 3,
      blocks: [2, 1, 3]
        .into_iter()
        .map(|page_number| ReadingBlock {
          block_id: format!("page-{page_number}-figure-1"),
          page_number,
          source_rect: [-10.0, 12.0, 400.0, 650.0],
          kind: ReadingBlockKind::Figure,
          block_type: ReadingBlockType::Graph,
          text: "Figure 1. Results.".into(),
          figure_label: Some("1".into()),
        })
        .collect(),
    }
  }

  #[test]
  fn invalid_source_geometry_and_duplicate_ids_are_rejected() {
    let mut layout = fixture_layout("a".repeat(64));
    assert!(validate(&layout).is_ok());
    for rect in [
      [0.0, 0.0, f64::NAN, 10.0],
      [0.0, 0.0, f64::INFINITY, 10.0],
      [0.0, 0.0, 0.0, 10.0],
      [10.0, 0.0, 0.0, 10.0],
      [0.0, 10.0, 10.0, 0.0],
    ] {
      layout.blocks[0].source_rect = rect;
      assert!(encode(&layout).is_err());
    }
    layout.blocks[0].source_rect = [0.0, 0.0, 10.0, 10.0];
    layout.blocks.push(layout.blocks[0].clone());
    assert!(validate(&layout).is_err());
  }

  #[test]
  fn layout_limits_and_page_membership_are_checked() {
    let mut layout = fixture_layout("a".repeat(64));
    layout.blocks[0].page_number = 4;
    assert!(validate(&layout).is_err());
    layout.blocks[0].page_number = 0;
    assert!(validate(&layout).is_err());
    layout.blocks[0].page_number = 2;
    layout.blocks[0].text = "x".repeat(validation::MAX_TEXT_BYTES + 1);
    assert!(validate(&layout).is_err());
    layout.blocks[0].text.clear();
    layout.page_count = 10_001;
    assert!(validate(&layout).is_err());
  }

  #[test]
  fn incomplete_layouts_are_rebuilt_instead_of_hiding_source_pages() {
    let mut layout = fixture_layout("a".repeat(64));
    layout.blocks.pop();
    assert!(validate(&layout).is_err());
    let data = serde_json::to_string(&layout).unwrap();
    assert!(decode(&data, &layout.pdf_hash).is_none());
    layout.blocks.clear();
    assert!(validate(&layout).is_err());
  }

  #[test]
  fn stale_or_damaged_data_is_a_cache_miss() {
    let layout = fixture_layout("a".repeat(64));
    let data = encode(&layout).unwrap();
    assert_eq!(decode(&data, &layout.pdf_hash), Some(layout.clone()));
    assert!(decode(&data, &"b".repeat(64)).is_none());
    assert!(decode("{corrupt", &layout.pdf_hash).is_none());
    for version in [1, 2, 3, LAYOUT_VERSION + 1] {
      let mut unsupported = layout.clone();
      unsupported.layout_version = version;
      let data = serde_json::to_string(&unsupported).unwrap();
      assert!(decode(&data, &layout.pdf_hash).is_none());
    }
  }

  #[test]
  fn semantic_types_round_trip_independently_of_rendering_kind() {
    let mut layout = fixture_layout("a".repeat(64));
    for (block_type, serialized) in [
      (ReadingBlockType::Content, "content"),
      (ReadingBlockType::Equation, "equation"),
      (ReadingBlockType::Graph, "graph"),
      (ReadingBlockType::Table, "table"),
      (ReadingBlockType::Reference, "reference"),
      (ReadingBlockType::Title, "title"),
      (ReadingBlockType::Others, "others"),
    ] {
      layout.blocks[0].block_type = block_type;
      let data = encode(&layout).unwrap();
      let value: serde_json::Value = serde_json::from_str(&data).unwrap();
      assert_eq!(value["blocks"][0]["block_type"], serialized);
      assert_eq!(value["blocks"][0]["kind"], "figure");
      assert_eq!(decode(&data, &layout.pdf_hash), Some(layout.clone()));
    }
  }

  #[test]
  fn missing_or_unknown_semantic_types_are_cache_misses() {
    let layout = fixture_layout("a".repeat(64));
    let mut missing_type = serde_json::to_value(&layout).unwrap();
    missing_type["blocks"][0]
      .as_object_mut()
      .unwrap()
      .remove("block_type");
    assert!(decode(&missing_type.to_string(), &layout.pdf_hash).is_none());
    missing_type["layout_version"] = 1.into();
    assert!(decode(&missing_type.to_string(), &layout.pdf_hash).is_none());

    let mut unknown_type = serde_json::to_value(&layout).unwrap();
    unknown_type["blocks"][0]["block_type"] = "unknown".into();
    assert!(decode(&unknown_type.to_string(), &layout.pdf_hash).is_none());
  }
}
