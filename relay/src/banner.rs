//! The startup banner: where the speaker and the audience should go.

use std::fmt::Write as _;
use std::net::IpAddr;
use std::path::Path;

use qrcode::QrCode;
use qrcode::render::unicode::Dense1x2;

use crate::net::LanAddress;

pub struct BannerInfo<'a> {
    pub version: &'a str,
    pub port: u16,
    pub bind: IpAddr,
    /// URL for the audience, if a LAN address is known.
    pub public_base: Option<&'a str>,
    pub lan: &'a [LanAddress],
    /// Directory served at `/models/`, if any.
    pub models_dir: Option<&'a Path>,
    /// True when the web app (index.html) is available.
    pub has_web_app: bool,
}

/// Render the banner as text (printed by `main`).
pub fn render(info: &BannerInfo<'_>) -> String {
    let mut out = String::new();
    let port = info.port;
    let _ = writeln!(out);
    let _ = writeln!(out, "  Caption Room LAN relay v{}", info.version);
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "  Speaker:  open http://localhost:{port} on THIS laptop"
    );
    let _ = writeln!(
        out,
        "            (browsers only allow the microphone on localhost or HTTPS)"
    );
    match info.public_base {
        Some(base) => {
            let _ = writeln!(out, "  Audience: {base}");
        }
        None => {
            let _ = writeln!(
                out,
                "  Audience: no network address found. Connect this laptop to the school Wi-Fi"
            );
            let _ = writeln!(
                out,
                "            or turn on its hotspot, then restart (or pass --public-host)."
            );
        }
    }
    let others: Vec<String> = info
        .lan
        .iter()
        .map(|a| (format!("http://{}:{port}", a.ip), &a.interface))
        .filter(|(url, _)| Some(url.as_str()) != info.public_base)
        .map(|(url, iface)| format!("{url} ({iface})"))
        .collect();
    if !others.is_empty() {
        let _ = writeln!(
            out,
            "  Other addresses on this laptop (use --public-host to pick one):"
        );
        for line in others {
            let _ = writeln!(out, "            {line}");
        }
    }
    if info.bind.is_loopback() {
        let _ = writeln!(
            out,
            "  Warning:  listening on {} only, so phones cannot connect. Use --bind 0.0.0.0.",
            info.bind
        );
    }
    if let Some(qr) = info.public_base.and_then(qr_code) {
        let _ = writeln!(out);
        for line in qr.lines() {
            let _ = writeln!(out, "  {line}");
        }
        let _ = writeln!(
            out,
            "  Students: scan the code or type the audience address."
        );
    }
    let _ = writeln!(out);
    match info.models_dir {
        Some(dir) => {
            let _ = writeln!(
                out,
                "  Offline models: serving {} at /models/",
                dir.display()
            );
        }
        None => {
            let _ = writeln!(
                out,
                "  Offline models: off. On-device speech engines download their models from the"
            );
            let _ = writeln!(
                out,
                "                  internet. Pass --models-dir <folder> to serve them locally."
            );
        }
    }
    if !info.has_web_app {
        let _ = writeln!(
            out,
            "  Web app: missing. Run `npm run build` at the repo root, then rebuild the relay"
        );
        let _ = writeln!(out, "           (or pass --web-dir apps/web/dist).");
    }
    let _ = writeln!(
        out,
        "  Firewall: if phones cannot connect, allow inbound TCP port {port} for this program."
    );
    let _ = writeln!(
        out,
        "  Press Ctrl+C to stop. Rooms live in memory until the relay stops."
    );
    let _ = writeln!(out);
    out
}

/// A QR code drawn with half-block characters, light on dark (for dark terminals).
pub fn qr_code(url: &str) -> Option<String> {
    let code = QrCode::new(url.as_bytes()).ok()?;
    Some(
        code.render::<Dense1x2>()
            .dark_color(Dense1x2::Light)
            .light_color(Dense1x2::Dark)
            .quiet_zone(true)
            .build(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn mentions_speaker_audience_models_and_qr() {
        let lan = vec![
            LanAddress {
                interface: "Wi-Fi".into(),
                ip: Ipv4Addr::new(192, 168, 1, 23),
            },
            LanAddress {
                interface: "Ethernet".into(),
                ip: Ipv4Addr::new(10, 0, 0, 5),
            },
        ];
        let text = render(&BannerInfo {
            version: "0.1.0",
            port: 7300,
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            public_base: Some("http://192.168.1.23:7300"),
            lan: &lan,
            models_dir: None,
            has_web_app: true,
        });
        assert!(text.contains("Speaker:  open http://localhost:7300 on THIS laptop"));
        assert!(text.contains("browsers only allow the microphone on localhost or HTTPS"));
        assert!(text.contains("Audience: http://192.168.1.23:7300"));
        assert!(text.contains("http://10.0.0.5:7300 (Ethernet)"));
        assert!(text.contains("Offline models: off"));
        assert!(
            text.contains('\u{2588}') || text.contains('\u{2580}') || text.contains('\u{2584}')
        );
        assert!(!text.contains('\u{2014}'), "no em dashes");
    }

    #[test]
    fn explains_missing_network() {
        let text = render(&BannerInfo {
            version: "0.1.0",
            port: 7300,
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            public_base: None,
            lan: &[],
            models_dir: Some(Path::new("models")),
            has_web_app: false,
        });
        assert!(text.contains("no network address found"));
        assert!(text.contains("Warning:"));
        assert!(text.contains("Offline models: serving models at /models/"));
        assert!(text.contains("npm run build"));
    }
}
