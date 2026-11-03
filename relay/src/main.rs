//! `saybeam-relay` binary: parse flags, print the banner, serve.

use std::future::IntoFuture;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::Parser;
use tracing_subscriber::EnvFilter;

use saybeam_relay::banner::{self, BannerInfo};
use saybeam_relay::cli::Cli;
use saybeam_relay::http::{ServerConfig, build_app, spawn_evictor};
use saybeam_relay::hub::HubSettings;
use saybeam_relay::net;
use saybeam_relay::web::WebSource;

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("saybeam_relay=info")),
        )
        .with_target(false)
        .init();
    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    let models_dir = existing_dir("--models-dir", cli.models_dir);
    let web = match cli.web_dir {
        Some(dir) if dir.is_dir() => WebSource::Dir(dir),
        Some(dir) => return Err(format!("--web-dir {} is not a folder", dir.display())),
        None => WebSource::Embedded,
    };
    let has_web_app = web.has_index().await;
    let lan = net::lan_addresses();
    let public_base = net::public_base(cli.public_host.as_deref(), cli.bind, cli.port, &lan);

    let addr = SocketAddr::new(cli.bind, cli.port);
    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|err| {
        format!(
            "could not listen on {addr}: {err}. Is another relay already running? Try --port {}.",
            cli.port.wrapping_add(1)
        )
    })?;

    print!(
        "{}",
        banner::render(&BannerInfo {
            version: env!("CARGO_PKG_VERSION"),
            port: cli.port,
            bind: cli.bind,
            public_base: public_base.as_deref(),
            lan: &lan,
            models_dir: models_dir.as_deref(),
            has_web_app,
        })
    );

    let (app, hub) = build_app(ServerConfig {
        public_base,
        models_dir,
        web,
        hub: HubSettings::default(),
    });
    spawn_evictor(hub);
    tokio::select! {
        served = axum::serve(listener, app).into_future() => served.map_err(|err| format!("server stopped: {err}")),
        _ = tokio::signal::ctrl_c() => {
            println!("Stopping. Rooms were kept in memory only and are now gone.");
            Ok(())
        }
    }
}

/// Keep `dir` only if it exists, warning otherwise (the relay still runs without models).
fn existing_dir(flag: &str, dir: Option<PathBuf>) -> Option<PathBuf> {
    let dir = dir?;
    if dir.is_dir() {
        Some(dir)
    } else {
        tracing::warn!(
            "{flag} {} does not exist or is not a folder; not serving it",
            dir.display()
        );
        None
    }
}
