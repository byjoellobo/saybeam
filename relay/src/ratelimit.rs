//! Per-connection abuse limits, mirroring room-core.ts: a token bucket per
//! connection (sized by role) and a count of rejected frames ("strikes").

use std::collections::HashMap;

use crate::protocol::{Role, limits};
use crate::room::ConnId;

#[derive(Clone, Copy, Debug)]
struct Bucket {
    tokens: f64,
    last: u64,
}

/// Capacity and refill per second for a role (`None`: not joined yet).
fn bucket_spec(role: Option<Role>) -> (f64, f64) {
    match role {
        Some(Role::Speaker) => (60.0, 30.0),
        Some(Role::Corrector) => (30.0, 10.0),
        Some(Role::Listener) => (20.0, 4.0),
        None => (5.0, 1.0),
    }
}

#[derive(Debug, Default)]
pub struct ConnLimits {
    buckets: HashMap<ConnId, Bucket>,
    strikes: HashMap<ConnId, u32>,
}

impl ConnLimits {
    /// Take `cost` tokens from the connection's bucket. False (and nothing taken) when short.
    pub fn charge(&mut self, id: ConnId, role: Option<Role>, cost: f64, now: u64) -> bool {
        let (capacity, per_second) = bucket_spec(role);
        let prev = self.buckets.get(&id).copied().unwrap_or(Bucket {
            tokens: capacity,
            last: now,
        });
        let elapsed = now.saturating_sub(prev.last) as f64 / 1000.0;
        let tokens = (prev.tokens + elapsed * per_second).min(capacity);
        let allowed = tokens >= cost;
        let tokens = if allowed { tokens - cost } else { tokens };
        self.buckets.insert(id, Bucket { tokens, last: now });
        allowed
    }

    /// Count a rejected frame. True when the connection has now reached the limit.
    pub fn strike(&mut self, id: ConnId) -> bool {
        let count = self.strikes.entry(id).or_insert(0);
        *count += 1;
        *count >= limits::MAX_STRIKES
    }

    /// Start a fresh bucket (after a successful hello). Strikes are kept.
    pub fn reset_bucket(&mut self, id: ConnId) {
        self.buckets.remove(&id);
    }

    /// The connection went away.
    pub fn forget(&mut self, id: ConnId) {
        self.buckets.remove(&id);
        self.strikes.remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_refill_by_role() {
        let mut guard = ConnLimits::default();
        let listener = Some(Role::Listener);
        let allowed = (0..25)
            .filter(|_| guard.charge(1, listener, 1.0, 0))
            .count();
        assert_eq!(allowed, 20);
        assert!(guard.charge(1, listener, 1.0, 250), "4 tokens per second");
        assert!(!guard.charge(1, listener, 1.0, 250));
    }

    #[test]
    fn expensive_requests_need_enough_tokens() {
        let mut guard = ConnLimits::default();
        let listener = Some(Role::Listener);
        assert!(guard.charge(1, listener, 10.0, 0));
        assert!(guard.charge(1, listener, 10.0, 0));
        assert!(
            !guard.charge(1, listener, 10.0, 0),
            "a failed charge takes nothing"
        );
        assert!(!guard.charge(1, listener, 1.0, 0), "the bucket is empty");
    }

    #[test]
    fn strikes_reach_the_limit_and_reset_on_forget() {
        let mut guard = ConnLimits::default();
        let closes: Vec<bool> = (0..limits::MAX_STRIKES).map(|_| guard.strike(7)).collect();
        assert!(closes[..closes.len() - 1].iter().all(|c| !c));
        assert_eq!(closes.last(), Some(&true));
        guard.forget(7);
        assert!(!guard.strike(7));
    }
}
