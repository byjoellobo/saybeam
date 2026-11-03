//! Saybeam LAN relay.
//!
//! A small server for a teacher's laptop that speaks the same wire protocol as
//! the cloud Durable Object (see `docs/protocol.md`), so the web app works on a
//! school network with weak or no internet.

pub mod banner;
pub mod cli;
pub mod codes;
pub mod http;
pub mod hub;
pub mod net;
pub mod paths;
pub mod protocol;
pub mod ratelimit;
pub mod room;
pub mod validate;
pub mod web;
pub mod ws;
