use crate::{error::Result, validation};
use std::{
  collections::HashMap,
  future::Future,
  sync::Mutex,
  time::{Duration, Instant},
};
use tokio::sync::watch;

pub(super) const CANCELLED: &str = "The paper operation was cancelled.";
const MAX_OPERATIONS: usize = 64;
const EARLY_CANCEL_TTL: Duration = Duration::from_secs(60);

enum Entry {
  Active(watch::Sender<bool>),
  Cancelled(Instant),
}

#[derive(Default)]
pub(super) struct OperationRegistry {
  entries: Mutex<HashMap<String, Entry>>,
}

impl OperationRegistry {
  pub fn register(&self, request_id: &str) -> Result<ActiveOperation<'_>> {
    validation::validate_id(request_id)?;
    let mut entries = self
      .entries
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    prune(&mut entries);
    match entries.get(request_id) {
      Some(Entry::Cancelled(_)) => {
        entries.remove(request_id);
        return Err(CANCELLED.into());
      }
      Some(Entry::Active(_)) => return Err("That paper operation is already running.".into()),
      None => {}
    }
    if entries.len() >= MAX_OPERATIONS {
      return Err("Too many paper operations are running. Cancel one and try again.".into());
    }
    let (sender, receiver) = watch::channel(false);
    entries.insert(request_id.to_owned(), Entry::Active(sender));
    Ok(ActiveOperation {
      registry: self,
      request_id: request_id.to_owned(),
      receiver,
    })
  }

  pub fn cancel(&self, request_id: &str) -> Result<()> {
    validation::validate_id(request_id)?;
    let mut entries = self
      .entries
      .lock()
      .unwrap_or_else(|error| error.into_inner());
    prune(&mut entries);
    if let Some(Entry::Active(sender)) = entries.get(request_id) {
      sender.send_replace(true);
    } else if entries.len() < MAX_OPERATIONS {
      // Stop may reach native code before the lookup/download IPC command.
      entries.insert(request_id.to_owned(), Entry::Cancelled(Instant::now()));
    }
    Ok(())
  }
}

fn prune(entries: &mut HashMap<String, Entry>) {
  entries
    .retain(|_, entry| !matches!(entry, Entry::Cancelled(at) if at.elapsed() > EARLY_CANCEL_TTL));
  if entries.len() >= MAX_OPERATIONS {
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
}

pub(super) struct ActiveOperation<'a> {
  registry: &'a OperationRegistry,
  request_id: String,
  receiver: watch::Receiver<bool>,
}

impl ActiveOperation<'_> {
  pub fn check(&self) -> Result<()> {
    if *self.receiver.borrow() {
      Err(CANCELLED.into())
    } else {
      Ok(())
    }
  }

  pub async fn run<T>(&mut self, future: impl Future<Output = Result<T>>) -> Result<T> {
    self.check()?;
    tokio::select! {
      biased;
      _ = self.receiver.changed() => Err(CANCELLED.into()),
      result = future => { self.check()?; result },
    }
  }
}

impl Drop for ActiveOperation<'_> {
  fn drop(&mut self) {
    self
      .registry
      .entries
      .lock()
      .unwrap_or_else(|error| error.into_inner())
      .remove(&self.request_id);
  }
}
