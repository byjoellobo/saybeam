//! Finding the laptop's LAN address so phones know where to connect.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// A candidate IPv4 address phones on the same network can reach.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LanAddress {
    pub interface: String,
    pub ip: Ipv4Addr,
}

/// Interface name fragments that usually belong to virtual adapters (VMs, WSL, VPNs).
const VIRTUAL_HINTS: &[&str] = &[
    "vethernet",
    "virtualbox",
    "vbox",
    "vmware",
    "vmnet",
    "docker",
    "wsl",
    "hyper-v",
    "virbr",
    "veth",
    "tailscale",
    "zerotier",
    "wireguard",
    "loopback",
    "bluetooth",
];

/// Usable LAN IPv4 addresses, best guess first.
pub fn lan_addresses() -> Vec<LanAddress> {
    let interfaces = local_ip_address::list_afinet_netifas().unwrap_or_else(|err| {
        tracing::warn!(%err, "could not list network interfaces");
        Vec::new()
    });
    let default_route = match local_ip_address::local_ip() {
        Ok(IpAddr::V4(ip)) => Some(ip),
        _ => None,
    };
    rank(interfaces, default_route)
}

/// Filter and sort candidates: the default-route address, then private
/// addresses on real adapters, then everything else.
pub fn rank(interfaces: Vec<(String, IpAddr)>, default_route: Option<Ipv4Addr>) -> Vec<LanAddress> {
    let mut found: Vec<LanAddress> = interfaces
        .into_iter()
        .filter_map(|(interface, ip)| match ip {
            IpAddr::V4(ip) if is_usable(ip) => Some(LanAddress { interface, ip }),
            _ => None,
        })
        .collect();
    found.sort_by_key(|a| {
        (
            Some(a.ip) != default_route,
            is_virtual(&a.interface),
            !a.ip.is_private(),
        )
    });
    found.dedup_by(|a, b| a.ip == b.ip);
    found
}

fn is_usable(ip: Ipv4Addr) -> bool {
    !(ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast())
}

fn is_virtual(interface: &str) -> bool {
    let name = interface.to_ascii_lowercase();
    VIRTUAL_HINTS.iter().any(|hint| name.contains(hint))
}

/// The base URL listeners should open, or `None` when no LAN address is known.
///
/// `public_host` may be a host (`192.168.1.5`, `laptop.local`), a host with a
/// port (`192.168.1.5:80`), or a full URL (`http://captions.school.lan`).
pub fn public_base(
    public_host: Option<&str>,
    bind: IpAddr,
    port: u16,
    lan: &[LanAddress],
) -> Option<String> {
    if let Some(host) = public_host.map(str::trim).filter(|h| !h.is_empty()) {
        return Some(format_host(host.trim_end_matches('/'), port));
    }
    if !bind.is_unspecified() && !bind.is_loopback() {
        return Some(format_host(&bind.to_string(), port));
    }
    lan.first().map(|a| format!("http://{}:{port}", a.ip))
}

fn format_host(host: &str, port: u16) -> String {
    if host.starts_with("http://") || host.starts_with("https://") {
        return host.to_string();
    }
    if let Ok(v6) = host.parse::<Ipv6Addr>() {
        return format!("http://[{v6}]:{port}");
    }
    let has_port = if host.starts_with('[') {
        host.contains("]:")
    } else {
        host.contains(':')
    };
    if has_port {
        format!("http://{host}")
    } else {
        format!("http://{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v4(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    #[test]
    fn ranks_real_private_adapters_first() {
        let interfaces = vec![
            ("vEthernet (WSL)".to_string(), v4(172, 20, 16, 1)),
            ("Loopback Pseudo-Interface 1".to_string(), v4(127, 0, 0, 1)),
            ("Wi-Fi".to_string(), v4(192, 168, 1, 23)),
            ("Ethernet".to_string(), v4(169, 254, 3, 3)),
            ("Wi-Fi".to_string(), IpAddr::V6(Ipv6Addr::LOCALHOST)),
            (
                "Local Area Connection* 10".to_string(),
                v4(192, 168, 137, 1),
            ),
        ];
        let ranked = rank(interfaces.clone(), None);
        let ips: Vec<String> = ranked.iter().map(|a| a.ip.to_string()).collect();
        assert_eq!(ips, vec!["192.168.1.23", "192.168.137.1", "172.20.16.1"]);
        let hotspot_default = rank(interfaces, Some(Ipv4Addr::new(192, 168, 137, 1)));
        assert_eq!(hotspot_default[0].ip, Ipv4Addr::new(192, 168, 137, 1));
    }

    #[test]
    fn builds_public_base() {
        let lan = vec![LanAddress {
            interface: "Wi-Fi".into(),
            ip: Ipv4Addr::new(192, 168, 1, 23),
        }];
        let any = IpAddr::V4(Ipv4Addr::UNSPECIFIED);
        assert_eq!(
            public_base(None, any, 7300, &lan).as_deref(),
            Some("http://192.168.1.23:7300")
        );
        assert_eq!(public_base(None, any, 7300, &[]), None);
        assert_eq!(
            public_base(None, v4(10, 0, 0, 5), 80, &lan).as_deref(),
            Some("http://10.0.0.5:80")
        );
        assert_eq!(
            public_base(None, v4(127, 0, 0, 1), 7300, &lan).as_deref(),
            Some("http://192.168.1.23:7300")
        );
        assert_eq!(
            public_base(Some("laptop.local"), any, 7300, &lan).as_deref(),
            Some("http://laptop.local:7300")
        );
        assert_eq!(
            public_base(Some("10.1.1.1:8080"), any, 7300, &lan).as_deref(),
            Some("http://10.1.1.1:8080")
        );
        assert_eq!(
            public_base(Some("https://cap.school.lan/"), any, 7300, &lan).as_deref(),
            Some("https://cap.school.lan")
        );
        assert_eq!(
            public_base(Some("fe80::1"), any, 7300, &lan).as_deref(),
            Some("http://[fe80::1]:7300")
        );
        assert_eq!(
            public_base(Some("  "), any, 7300, &lan).as_deref(),
            Some("http://192.168.1.23:7300")
        );
    }
}
