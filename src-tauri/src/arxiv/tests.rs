use super::*;
use chrono::{DateTime, TimeDelta, Utc};
use std::{
  collections::VecDeque,
  sync::{Arc, Mutex},
};
use tokio::io::AsyncReadExt;

const XML: &[u8] = include_bytes!("../../tests/fixtures/arxiv-1706.03762.xml");
const PDF: &[u8] = b"%PDF-1.7\nA local PDF fixture";

struct Reply {
  status: u16,
  headers: &'static str,
  body: &'static [u8],
  hold: bool,
}

impl Reply {
  fn ok(body: &'static [u8]) -> Self {
    Self {
      status: 200,
      headers: "",
      body,
      hold: false,
    }
  }
  fn limited(headers: &'static str) -> Self {
    Self {
      status: 429,
      headers,
      body: b"rate limited",
      hold: false,
    }
  }
}

struct Server {
  url: String,
  calls: Arc<Mutex<Vec<(String, Instant)>>>,
  task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
  fn drop(&mut self) {
    self.task.abort();
  }
}

async fn server(replies: Vec<Reply>) -> Server {
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
  let url = format!("http://{}/", listener.local_addr().unwrap());
  let calls = Arc::new(Mutex::new(Vec::new()));
  let recorded = calls.clone();
  let task = tokio::spawn(async move {
    let mut replies = VecDeque::from(replies);
    loop {
      let (mut socket, _) = listener.accept().await.unwrap();
      let mut request = Vec::new();
      while !request.windows(4).any(|value| value == b"\r\n\r\n") {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        if count == 0 {
          break;
        }
        request.extend_from_slice(&chunk[..count]);
      }
      recorded.lock().unwrap().push((
        String::from_utf8_lossy(&request)
          .lines()
          .next()
          .unwrap_or_default()
          .to_owned(),
        Instant::now(),
      ));
      let reply = replies.pop_front().expect("unexpected extra HTTP request");
      let length = if reply.hold {
        reply.body.len() + 10_000
      } else {
        reply.body.len()
      };
      let headers = format!(
        "HTTP/1.1 {} Test\r\nContent-Length: {length}\r\nConnection: close\r\n{}\r\n",
        reply.status, reply.headers
      );
      socket.write_all(headers.as_bytes()).await.unwrap();
      socket.write_all(reply.body).await.unwrap();
      if reply.hold {
        let mut byte = [0];
        let _ = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut byte)).await;
      }
    }
  });
  Server { url, calls, task }
}

fn state(directory: &tempfile::TempDir, server: &Server) -> AppState {
  let mut state = AppState::initialize(directory.path().to_owned()).unwrap();
  state.arxiv.metadata_url = format!("{}api/query", server.url);
  state.arxiv.pdf_base_url = format!("{}pdf/", server.url);
  state.arxiv.policy = service::RetryPolicy {
    spacing: Duration::from_millis(15),
    backoff: Duration::from_millis(20),
    jitter: Duration::ZERO,
    max_retries: 2,
  };
  state
}

fn ignore(_: OperationProgress) {}

#[test]
fn preview_does_not_create_a_library_entry_or_download_and_pins_confirmed_revision() {
  tauri::async_runtime::block_on(async {
    let server = server(vec![Reply::ok(XML), Reply::ok(PDF)]).await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, &server);
    let preview = preview(
      &state,
      "1706.03762",
      &Progress {
        request_id: "preview",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    assert!(preview.library_paper.is_none());
    assert_eq!(preview.metadata.paper_id, "1706.03762v7");
    assert_eq!(state.database.list_papers().await.unwrap().len(), 0);
    assert_eq!(std::fs::read_dir(&state.pdf_directory).unwrap().count(), 0);
    assert_eq!(server.calls.lock().unwrap().len(), 1);
    let paper = download(
      &state,
      &preview.preview_id,
      &Progress {
        request_id: "download",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    assert_eq!(read_pdf(&state, paper.paper_id.clone()).await.unwrap(), PDF);
    assert_eq!(state.database.list_papers().await.unwrap().len(), 1);
    let calls = server.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert!(calls[1].0.contains("/pdf/1706.03762v7"));
    assert!(calls[1].1.duration_since(calls[0].1) >= state.arxiv.policy.spacing);
  });
}

#[test]
fn failed_download_retains_preview_metadata_and_retry_never_repeats_lookup() {
  tauri::async_runtime::block_on(async {
    let server = server(vec![
      Reply::ok(XML),
      Reply::ok(b"not a PDF"),
      Reply::ok(PDF),
    ])
    .await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, &server);
    let first = preview(
      &state,
      "1706.03762",
      &Progress {
        request_id: "preview",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    assert!(download(
      &state,
      &first.preview_id,
      &Progress {
        request_id: "failed",
        emit: &ignore
      }
    )
    .await
    .unwrap_err()
    .contains("not a PDF"));
    assert!(state.database.list_papers().await.unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&state.pdf_directory).unwrap().count(), 0);
    let repeated = preview(
      &state,
      "1706.03762",
      &Progress {
        request_id: "retry-preview",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    assert_eq!(first.metadata.paper_id, repeated.metadata.paper_id);
    download(
      &state,
      &first.preview_id,
      &Progress {
        request_id: "retry-download",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    let calls = server.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert_eq!(
      calls
        .iter()
        .filter(|(request, _)| request.contains("api/query"))
        .count(),
      1
    );
  });
}

#[test]
fn retry_after_seconds_and_http_date_never_shorten_server_cooldown() {
  let now = DateTime::parse_from_rfc3339("2026-09-29T12:00:00Z")
    .unwrap()
    .with_timezone(&Utc);
  assert_eq!(
    rate_limit::retry_deadline(Some("120"), now, Duration::from_secs(15)),
    now + TimeDelta::seconds(120)
  );
  assert_eq!(
    rate_limit::retry_deadline(
      Some("Tue, 29 Sep 2026 12:02:00 GMT"),
      now,
      Duration::from_secs(15)
    ),
    now + TimeDelta::seconds(120)
  );
  assert_eq!(
    rate_limit::retry_deadline(
      Some("999999999999999999999999"),
      now,
      Duration::from_secs(15)
    ),
    DateTime::<Utc>::MAX_UTC
  );
  for value in [
    None,
    Some("not a date"),
    Some("0"),
    Some("Tue, 29 Sep 2026 11:02:00 GMT"),
  ] {
    assert_eq!(
      rate_limit::retry_deadline(value, now, Duration::from_secs(15)),
      now + TimeDelta::seconds(15)
    );
  }
}

#[test]
fn metadata_rate_limit_emits_deadline_retries_and_persists_shared_cooldown() {
  tauri::async_runtime::block_on(async {
    let server = server(vec![
      Reply::limited("Retry-After: 1\r\n"),
      Reply::ok(XML),
      Reply::ok(PDF),
    ])
    .await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, &server);
    let events = Mutex::new(Vec::new());
    let emit = |event| events.lock().unwrap().push(event);
    let paper = preview(
      &state,
      "1706.03762",
      &Progress {
        request_id: "preview",
        emit: &emit,
      },
    )
    .await
    .unwrap();
    assert!(events
      .lock()
      .unwrap()
      .iter()
      .any(|event: &OperationProgress| event.phase == "waiting"
        && event.retry_at.is_some()
        && event.request_id == "preview"));
    assert!(directory.path().join("arxiv-cooldown.json").is_file());
    download(
      &state,
      &paper.preview_id,
      &Progress {
        request_id: "download",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    let calls = server.calls.lock().unwrap();
    assert_eq!(calls.len(), 3);
    assert!(calls[1].1.duration_since(calls[0].1) >= Duration::from_secs(1));
    assert!(calls[2].1.duration_since(calls[1].1) >= state.arxiv.policy.spacing);
  });
}

#[test]
fn pdf_rate_limits_retry_with_a_bound_and_leave_preview_usable() {
  tauri::async_runtime::block_on(async {
    let server = server(vec![
      Reply::ok(XML),
      Reply::limited(""),
      Reply::limited(""),
      Reply::limited(""),
      Reply::ok(PDF),
    ])
    .await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, &server);
    let preview = preview(
      &state,
      "1706.03762",
      &Progress {
        request_id: "preview",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    assert!(download(
      &state,
      &preview.preview_id,
      &Progress {
        request_id: "limited",
        emit: &ignore
      }
    )
    .await
    .unwrap_err()
    .contains("429"));
    assert_eq!(server.calls.lock().unwrap().len(), 4);
    assert!(state.database.list_papers().await.unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&state.pdf_directory).unwrap().count(), 0);
    download(
      &state,
      &preview.preview_id,
      &Progress {
        request_id: "retry",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    assert_eq!(server.calls.lock().unwrap().len(), 5);
  });
}

#[test]
fn cancelled_rate_limit_wait_keeps_deadline_across_restart_without_downloads() {
  tauri::async_runtime::block_on(async {
    let server = server(vec![Reply::limited("Retry-After: 120\r\n")]).await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, &server);
    let emit = |event: OperationProgress| {
      if event.phase == "waiting" {
        cancel_operation(&state, "preview").unwrap();
      }
    };
    assert_eq!(
      preview(
        &state,
        "1706.03762",
        &Progress {
          request_id: "preview",
          emit: &emit
        }
      )
      .await
      .unwrap_err(),
      cancellation::CANCELLED
    );
    assert!(state.database.list_papers().await.unwrap().is_empty());
    let restarted = AppState::initialize(directory.path().to_owned()).unwrap();
    assert!(
      restarted.arxiv.rate.lock().await.cooldown.unwrap() >= Utc::now() + TimeDelta::seconds(110)
    );
    assert_eq!(server.calls.lock().unwrap().len(), 1);
  });
}

#[test]
fn cancellation_interrupts_streaming_and_removes_partial_pdf_without_losing_preview() {
  tauri::async_runtime::block_on(async {
    let server = server(vec![
      Reply::ok(XML),
      Reply {
        hold: true,
        ..Reply::ok(PDF)
      },
      Reply::ok(PDF),
    ])
    .await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, &server);
    let preview = preview(
      &state,
      "1706.03762",
      &Progress {
        request_id: "preview",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    let emit = |event: OperationProgress| {
      if event.received_bytes > 0 {
        cancel_operation(&state, "download").unwrap();
      }
    };
    let result = tokio::time::timeout(
      Duration::from_secs(2),
      download(
        &state,
        &preview.preview_id,
        &Progress {
          request_id: "download",
          emit: &emit,
        },
      ),
    )
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), cancellation::CANCELLED);
    assert!(state.database.list_papers().await.unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&state.pdf_directory).unwrap().count(), 0);
    download(
      &state,
      &preview.preview_id,
      &Progress {
        request_id: "retry",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    assert_eq!(server.calls.lock().unwrap().len(), 3);
  });
}

#[test]
fn early_cancel_and_deletion_invalidation_prevent_queued_download_resurrection() {
  tauri::async_runtime::block_on(async {
    let server = server(vec![Reply::ok(XML)]).await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, &server);
    cancel_operation(&state, "early").unwrap();
    assert_eq!(
      preview(
        &state,
        "1706.03762",
        &Progress {
          request_id: "early",
          emit: &ignore
        }
      )
      .await
      .unwrap_err(),
      cancellation::CANCELLED
    );
    assert!(server.calls.lock().unwrap().is_empty());
    let preview = preview(
      &state,
      "1706.03762",
      &Progress {
        request_id: "preview",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    let guard = state.import_lock.lock().await;
    let progress = Progress {
      request_id: "queued",
      emit: &ignore,
    };
    let task = download(&state, &preview.preview_id, &progress);
    tokio::pin!(task);
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut task)
      .await
      .is_err());
    state.arxiv.invalidate_paper(&preview.metadata.paper_id);
    drop(guard);
    assert!(task
      .await
      .unwrap_err()
      .contains("expired or the paper was removed"));
    assert_eq!(server.calls.lock().unwrap().len(), 1);
    assert!(state.database.list_papers().await.unwrap().is_empty());
  });
}

#[test]
fn saved_papers_preview_and_open_offline_without_network_requests() {
  tauri::async_runtime::block_on(async {
    let server = server(Vec::new()).await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, &server);
    let mut paper = parse_metadata(XML, &ArxivId::parse("1706.03762").unwrap()).unwrap();
    paper.pdf_hash = format!("{:x}", Sha256::digest(PDF));
    state.database.save_paper(paper.clone()).await.unwrap();
    std::fs::write(pdf_path(&state, &paper.paper_id), PDF).unwrap();
    let preview = preview(
      &state,
      "1706.03762",
      &Progress {
        request_id: "preview",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    assert_eq!(preview.library_paper.unwrap().paper_id, paper.paper_id);
    let opened = download(
      &state,
      &preview.preview_id,
      &Progress {
        request_id: "open",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    assert_eq!(opened.paper_id, paper.paper_id);
    assert!(server.calls.lock().unwrap().is_empty());
  });
}

#[test]
fn cancelling_in_flight_metadata_closes_the_request_without_saving_a_paper() {
  tauri::async_runtime::block_on(async {
    let server = server(vec![
      Reply {
        hold: true,
        ..Reply::ok(XML)
      },
      Reply::ok(XML),
    ])
    .await;
    let directory = tempfile::tempdir().unwrap();
    let state = state(&directory, &server);
    let progress = Progress {
      request_id: "metadata",
      emit: &ignore,
    };
    let cancel = async {
      while server.calls.lock().unwrap().is_empty() {
        tokio::time::sleep(Duration::from_millis(1)).await;
      }
      cancel_operation(&state, "metadata").unwrap();
    };
    let (result, ()) = tokio::time::timeout(Duration::from_secs(2), async {
      tokio::join!(preview(&state, "1706.03762", &progress), cancel)
    })
    .await
    .unwrap();
    assert_eq!(result.unwrap_err(), cancellation::CANCELLED);
    assert!(state.database.list_papers().await.unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&state.pdf_directory).unwrap().count(), 0);
    preview(
      &state,
      "1706.03762",
      &Progress {
        request_id: "retry",
        emit: &ignore,
      },
    )
    .await
    .unwrap();
    assert_eq!(server.calls.lock().unwrap().len(), 2);
  });
}
