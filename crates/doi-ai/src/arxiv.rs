use crate::models::Paper;
use regex::Regex;
use serde::Deserialize;
use std::sync::OnceLock;
use url::Url;
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, PartialEq)]
pub struct ArxivId {
  pub base_id: String,
  pub version: Option<u32>,
}

impl ArxivId {
  pub fn parse(input: &str) -> Result<Self> {
    let trimmed = input.trim();
    if trimmed.len() > 1024 {
      return Err("The arXiv identifier is too long.".into());
    }
    let trimmed = trimmed
      .trim_start_matches(['<', '"', '\''])
      .trim_end_matches(['.', ',', ';', ':', ')', ']', '}', '>', '"', '\'']);
    let without_scheme = trimmed.split('/').next().is_some_and(|host| {
      ["arxiv.org", "www.arxiv.org", "export.arxiv.org"]
        .iter()
        .any(|allowed| host.eq_ignore_ascii_case(allowed))
    });
    let value = if trimmed.contains("://") || without_scheme {
      let normalized = if without_scheme {
        format!("https://{trimmed}")
      } else {
        trimmed.to_owned()
      };
      let url = Url::parse(&normalized).map_err(|_| "Invalid arXiv URL.".to_string())?;
      if !matches!(url.scheme(), "http" | "https")
        || !matches!(
          url.host_str(),
          Some("arxiv.org" | "www.arxiv.org" | "export.arxiv.org")
        )
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
      {
        return Err("Enter an arXiv ID or an arxiv.org abstract/PDF/HTML URL.".into());
      }
      let path = percent_encoding::percent_decode_str(url.path())
        .decode_utf8()
        .map_err(|_| "Invalid arXiv URL path.".to_string())?;
      let path = path.trim_end_matches('/');
      let identifier = path
        .strip_prefix("/abs/")
        .or_else(|| path.strip_prefix("/pdf/"))
        .or_else(|| path.strip_prefix("/html/"))
        .ok_or_else(|| "Use an arXiv abstract, PDF, or HTML URL.".to_string())?;
      identifier
        .strip_suffix(".pdf")
        .unwrap_or(identifier)
        .to_owned()
    } else {
      let without_label = if trimmed
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("arxiv:"))
      {
        &trimmed[6..]
      } else {
        trimmed
      };
      let identifier = without_label.trim();
      identifier
        .strip_suffix(".pdf")
        .unwrap_or(identifier)
        .to_owned()
    };
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| Regex::new(
      r"^(?<base>(?:[0-9]{2}(?:0[1-9]|1[0-2])\.[0-9]{4,5}|[a-z][a-z-]*(?:\.[A-Za-z]{2})?/[0-9]{2}(?:0[1-9]|1[0-2])[0-9]{3}))(?:(?:v)(?<version>[1-9][0-9]{0,3}))?$"
    ).expect("constant arXiv identifier pattern"));
    let captures = pattern.captures(&value).ok_or_else(|| {
      "Invalid arXiv ID. Use 2401.12345, hep-th/9901001, or an optional v2 suffix.".to_string()
    })?;
    Ok(Self {
      base_id: captures["base"].to_owned(),
      version: captures
        .name("version")
        .map(|value| value.as_str().parse().expect("bounded version")),
    })
  }

  pub fn canonical(&self) -> String {
    match self.version {
      Some(version) => format!("{}v{version}", self.base_id),
      None => self.base_id.clone(),
    }
  }
}

#[derive(Deserialize)]
struct Feed {
  #[serde(default)]
  entry: Vec<Entry>,
}

#[derive(Deserialize)]
struct Entry {
  id: String,
  title: String,
  summary: String,
  #[serde(default)]
  author: Vec<Author>,
}

#[derive(Deserialize)]
struct Author {
  name: String,
}

fn compact_text(text: &str) -> String {
  text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn parse_metadata(bytes: &[u8], requested: &ArxivId) -> Result<Paper> {
  let xml = std::str::from_utf8(bytes).map_err(|_| "arXiv metadata was not UTF-8.".to_string())?;
  let feed: Feed =
    quick_xml::de::from_str(xml).map_err(|_| "arXiv returned invalid metadata.".to_string())?;
  let entry = feed
    .entry
    .into_iter()
    .next()
    .ok_or_else(|| "No paper was found for that arXiv ID.".to_string())?;
  let resolved = ArxivId::parse(&entry.id)
    .map_err(|_| "arXiv did not return a valid paper revision.".to_string())?;
  if resolved.base_id != requested.base_id
    || resolved.version.is_none()
    || requested
      .version
      .is_some_and(|version| resolved.version != Some(version))
  {
    return Err(
      "arXiv returned a different paper revision. The requested version may not exist.".into(),
    );
  }
  let paper_id = resolved.canonical();
  let title = compact_text(&entry.title);
  if title.is_empty() {
    return Err("arXiv returned a paper without a title.".into());
  }
  Ok(Paper {
    paper_id: paper_id.clone(),
    arxiv_id: resolved.base_id,
    arxiv_version: resolved.version.expect("checked revision"),
    title,
    authors: entry
      .author
      .into_iter()
      .map(|author| compact_text(&author.name))
      .collect(),
    r#abstract: entry.summary.trim().to_owned(),
    pdf_url: format!("https://arxiv.org/pdf/{paper_id}"),
    pdf_hash: String::new(),
    downloaded_at: String::new(),
    last_location: None,
    last_opened_at: None,
  })
}
