//! Command-line flags.

use std::net::IpAddr;
use std::path::PathBuf;

use clap::Parser;

/// Caption Room LAN relay: live captions over school Wi-Fi, no internet needed.
///
/// The speaker opens http://localhost:PORT on this laptop; students open the
/// LAN address printed at startup (or scan its QR code).
#[derive(Debug, Parser)]
#[command(name = "caption-room-relay", version, about, long_about)]
pub struct Cli {
    /// TCP port to listen on.
    #[arg(long, default_value_t = 7300)]
    pub port: u16,

    /// Address to listen on. 0.0.0.0 accepts phones on every network this laptop is on.
    #[arg(long, default_value = "0.0.0.0")]
    pub bind: IpAddr,

    /// Host or IP students should use (overrides the detected LAN address).
    /// Accepts a host, host:port, or a full http(s) URL.
    #[arg(long, value_name = "HOST")]
    pub public_host: Option<String>,

    /// Folder of speech model files to serve at /models/ for fully offline use.
    #[arg(long, value_name = "DIR")]
    pub models_dir: Option<PathBuf>,

    /// Serve the web app from this folder instead of the copy built into the binary.
    #[arg(long, value_name = "DIR")]
    pub web_dir: Option<PathBuf>,
}
