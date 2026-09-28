use crate::error::Result;
use std::{
  collections::HashMap,
  future::Future,
  sync::Mutex,
  time::{Duration, Instant},
};
use tokio::sync::watch;

const CANCELLED: &str = "The AI request was stopped.";
const MAX_REQUESTS: usize = 64;
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(30);
const MAX_AI_REQUEST_TIME: Duration = Duration::from_secs(300);

enum Entry {
  Active(watch::Sender<bool>),
  Cancelled(Instant),
}

#[derive(Default)]
pub struct RequestRegistry {
  entries: Mutex<HashMap<String, Entry>>,
}

impl RequestRegistry {
  pub fn register(&self, request_id: &str) -> Result<ActiveRequest<'_>> {
    let mut entries = self
      .entries
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    expire(&mut entries);
    match entries.get(request_id) {
      Some(Entry::Cancelled(_)) => {
        entries.remove(request_id);
        return Err(CANCELLED.into());
      }
      Some(Entry::Active(_)) => return Err("That AI request is already running.".into()),
      None => {}
    }
    make_room(&mut entries);
    if entries.len() >= MAX_REQUESTS {
      return Err("Too many AI requests are running. Stop a request and try again.".into());
    }
    let (sender, receiver) = watch::channel(false);
    entries.insert(request_id.to_owned(), Entry::Active(sender));
    Ok(ActiveRequest {
      registry: self,
      request_id: request_id.to_owned(),
      receiver,
    })
  }

  pub fn cancel(&self, request_id: &str) {
    let mut entries = self
      .entries
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    expire(&mut entries);
    if let Some(Entry::Active(sender)) = entries.get(request_id) {
      sender.send_replace(true);
      return;
    }
    // IPC commands may arrive out of order. Brief, bounded tombstones let Stop
    // win even before ask_selection has registered its request.
    make_room(&mut entries);
    if entries.len() < MAX_REQUESTS {
      entries.insert(request_id.to_owned(), Entry::Cancelled(Instant::now()));
    }
  }
}

fn make_room(entries: &mut HashMap<String, Entry>) {
  if entries.len() < MAX_REQUESTS {
    return;
  }
  let oldest = entries
    .iter()
    .filter_map(|(id, entry)| match entry {
      Entry::Cancelled(at) => Some((id.clone(), *at)),
      Entry::Active(_) => None,
    })
    .min_by_key(|(_, at)| *at);
  if let Some((id, _)) = oldest {
    entries.remove(&id);
  }
}

fn expire(entries: &mut HashMap<String, Entry>) {
  entries
    .retain(|_, entry| !matches!(entry, Entry::Cancelled(at) if at.elapsed() > EARLY_CANCEL_TTL));
}

pub struct ActiveRequest<'a> {
  registry: &'a RequestRegistry,
  request_id: String,
  receiver: watch::Receiver<bool>,
}

impl ActiveRequest<'_> {
  pub async fn run<T>(&mut self, future: impl Future<Output = Result<T>>) -> Result<T> {
    if *self.receiver.borrow() {
      return Err(CANCELLED.into());
    }
    tokio::select! {
      biased;
      _ = self.receiver.changed() => Err(CANCELLED.into()),
      _ = tokio::time::sleep(MAX_AI_REQUEST_TIME) => Err("The AI request timed out. Try a more focused question or another model.".into()),
      result = future => if *self.receiver.borrow() { Err(CANCELLED.into()) } else { result },
    }
  }
}

impl Drop for ActiveRequest<'_> {
  fn drop(&mut self) {
    self
      .registry
      .entries
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .remove(&self.request_id);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
  };

  #[test]
  fn cancellation_drops_in_flight_work_and_cleans_registry() {
    tauri::async_runtime::block_on(async {
      struct Dropped(Arc<AtomicBool>);
      impl Drop for Dropped {
        fn drop(&mut self) {
          self.0.store(true, Ordering::SeqCst);
        }
      }
      let registry = RequestRegistry::default();
      let dropped = Arc::new(AtomicBool::new(false));
      let mut active = registry.register("request").unwrap();
      assert!(registry.register("request").is_err());
      let work = async {
        let _guard = Dropped(dropped.clone());
        registry.cancel("request");
        std::future::pending::<Result<()>>().await
      };
      assert_eq!(active.run(work).await.unwrap_err(), CANCELLED);
      assert!(dropped.load(Ordering::SeqCst));
      drop(active);
      assert!(registry.entries.lock().unwrap().is_empty());
      let mut active = registry.register("request").unwrap();
      assert!(active
        .run(async { Err::<(), _>("error".into()) })
        .await
        .is_err());
      drop(active);
      assert!(registry.entries.lock().unwrap().is_empty());
    });
  }

  #[test]
  fn early_stop_is_honored_and_tombstones_are_bounded_and_expire() {
    let registry = RequestRegistry::default();
    registry.cancel("early");
    assert!(matches!(registry.register("early"), Err(error) if error == CANCELLED));
    for index in 0..MAX_REQUESTS * 2 {
      registry.cancel(&index.to_string());
    }
    assert_eq!(registry.entries.lock().unwrap().len(), MAX_REQUESTS);
    registry.entries.lock().unwrap().insert(
      "expired".into(),
      Entry::Cancelled(Instant::now() - EARLY_CANCEL_TTL - Duration::from_secs(1)),
    );
    assert!(registry.register("expired").is_ok());
    assert!(!registry.entries.lock().unwrap().contains_key("expired"));
  }
}
