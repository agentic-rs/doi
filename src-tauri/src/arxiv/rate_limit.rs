use super::{service::RetryPolicy, Progress};
use crate::{
  error::{network_error, Result},
  http,
  state::AppState,
};
use chrono::{DateTime, Utc};
use reqwest::{header::RETRY_AFTER, RequestBuilder, Response, StatusCode};
use std::time::{Duration, Instant};

pub(super) fn retry_deadline(
  value: Option<&str>,
  now: DateTime<Utc>,
  fallback: Duration,
) -> DateTime<Utc> {
  let server = value.and_then(|value| {
    let value = value.trim();
    if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
      // Never turn an oversized but valid delay into an early fallback retry.
      Some(
        value
          .parse::<i64>()
          .ok()
          .and_then(chrono::TimeDelta::try_seconds)
          .and_then(|delay| now.checked_add_signed(delay))
          .unwrap_or(DateTime::<Utc>::MAX_UTC),
      )
    } else {
      DateTime::parse_from_rfc2822(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
    }
  });
  let fallback = chrono::TimeDelta::from_std(fallback)
    .ok()
    .and_then(|delay| now.checked_add_signed(delay))
    .unwrap_or(DateTime::<Utc>::MAX_UTC);
  server.map_or(fallback, |deadline| deadline.max(fallback))
}

fn retry_delay(policy: &RetryPolicy, retry: u32) -> Duration {
  let jitter_max = policy.jitter.as_millis() as u64;
  let jitter = if jitter_max == 0 {
    0
  } else {
    uuid::Uuid::new_v4().as_u128() as u64 % jitter_max
  };
  policy.backoff.saturating_mul(1_u32 << retry.min(10)) + Duration::from_millis(jitter)
}

pub(super) async fn send(
  state: &AppState,
  progress: &Progress<'_>,
  operation: &str,
  request: impl Fn() -> Result<RequestBuilder>,
) -> Result<Response> {
  // All callers hold import_lock through body consumption. This clock therefore
  // covers both endpoints and only one arXiv connection can be active at once.
  let mut rate = state.arxiv.rate.lock().await;
  for retry in 0..=state.arxiv.policy.max_retries {
    loop {
      let spacing = state
        .arxiv
        .policy
        .spacing
        .saturating_sub(rate.last_request.elapsed());
      let now = Utc::now();
      let cooldown = rate
        .cooldown
        .and_then(|deadline| (deadline - now).to_std().ok())
        .unwrap_or_default();
      let wait = spacing.max(cooldown);
      if wait.is_zero() {
        break;
      }
      let retry_at = now
        .checked_add_signed(chrono::TimeDelta::from_std(wait).unwrap_or(chrono::TimeDelta::MAX))
        .unwrap_or(DateTime::<Utc>::MAX_UTC);
      progress.waiting(retry_at);
      // Recheck wall time after waking, including very long Retry-After values.
      tokio::time::sleep(wait.min(Duration::from_secs(60))).await;
    }
    // A cancelled/failed request still counts against the shared pacing clock.
    rate.last_request = Instant::now();
    let response = request()?
      .send()
      .await
      .map_err(|error| network_error(operation, error))?;
    // Start the quiet interval after receiving headers as well; connection
    // setup time must not compress the gap between requests at the server.
    rate.last_request = Instant::now();
    if response.status() != StatusCode::TOO_MANY_REQUESTS {
      http::require_success(&response, operation)?;
      return Ok(response);
    }
    let deadline = retry_deadline(
      response
        .headers()
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok()),
      Utc::now(),
      retry_delay(&state.arxiv.policy, retry),
    );
    rate.cooldown = Some(
      rate
        .cooldown
        .map_or(deadline, |previous| previous.max(deadline)),
    );
    // Keep arXiv's cooldown across app restarts. A write error does not disable
    // offline reading or lose the in-memory deadline.
    if let Ok(bytes) = serde_json::to_vec(&rate.cooldown) {
      let temporary = rate.cooldown_path.with_extension("tmp");
      if tokio::fs::write(&temporary, bytes).await.is_ok() {
        let _ = tokio::fs::rename(&temporary, &rate.cooldown_path).await;
      }
    }
    progress.waiting(rate.cooldown.expect("rate limit establishes a cooldown"));
    drop(response);
    if retry == state.arxiv.policy.max_retries {
      return Err("arXiv is still rate limiting requests (HTTP 429). The paper has not been added. Retry after the displayed cooldown.".into());
    }
  }
  unreachable!("bounded retry loop always returns")
}
