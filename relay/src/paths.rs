//! URL path safety for files served from disk: percent-decoding, and refusing
//! anything that could escape the served folder or open a Windows device
//! (`CON`, `NUL`, `COM1` and friends resolve to devices in any folder).

use percent_encoding::percent_decode_str;

/// Decode a URL path (relative to a served root) into a safe relative file path.
/// `None` for traversal, separators, drive or stream syntax, NUL bytes or device names.
pub fn safe_relative(rel: &str) -> Option<String> {
    let segments = rel
        .split('/')
        .map(|seg| {
            let decoded = percent_decode_str(seg).decode_utf8().ok()?;
            is_safe_segment(&decoded).then(|| decoded.into_owned())
        })
        .collect::<Option<Vec<String>>>()?;
    Some(segments.join("/"))
}

/// True when any percent-decoded segment of a URL path names a Windows device.
pub fn has_device_name(path: &str) -> bool {
    path.split('/')
        .any(|seg| is_windows_device_name(&percent_decode_str(seg).decode_utf8_lossy()))
}

fn is_safe_segment(seg: &str) -> bool {
    !seg.is_empty()
        && seg != "."
        && seg != ".."
        && !seg.contains(['/', '\\', ':', '\0'])
        && !is_windows_device_name(seg)
}

/// `CON`, `PRN`, `AUX`, `NUL`, `COM0`-`COM9`, `LPT0`-`LPT9` (also with superscript
/// digits) and the console names, with or without an extension.
fn is_windows_device_name(segment: &str) -> bool {
    let stem = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$" => true,
        other => {
            let port = matches!(other.get(..3), Some("COM" | "LPT"));
            let mut digit = other.get(3..).unwrap_or_default().chars();
            let single = digit
                .next()
                .is_some_and(|c| c.is_ascii_digit() || matches!(c, '¹' | '²' | '³'));
            port && single && digit.next().is_none()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_and_keeps_ordinary_paths() {
        assert_eq!(
            safe_relative("assets/app.js").as_deref(),
            Some("assets/app.js")
        );
        assert_eq!(
            safe_relative("icons/my%20icon.png").as_deref(),
            Some("icons/my icon.png")
        );
        assert_eq!(
            safe_relative("caf%C3%A9.txt").as_deref(),
            Some("caf\u{e9}.txt")
        );
        assert_eq!(safe_relative("console.js").as_deref(), Some("console.js"));
        assert_eq!(safe_relative("com10.txt").as_deref(), Some("com10.txt"));
    }

    #[test]
    fn refuses_paths_that_escape_the_root() {
        for bad in [
            "../secret",
            "a/../../b",
            "a//b",
            "./a",
            "C:/x",
            "a\\b",
            "%2e%2e/secret",
            "a%2fb",
            "a%5cb",
            "file.txt:stream",
            "a%00b",
            "%ff",
        ] {
            assert_eq!(safe_relative(bad), None, "{bad}");
        }
    }

    #[test]
    fn refuses_windows_device_names() {
        for bad in [
            "CON",
            "con.js",
            "aux.txt",
            "NUL",
            "nul.tar.gz",
            "COM1",
            "lpt9.log",
            "COM\u{b9}",
            "CON .txt",
            "conin$",
        ] {
            assert_eq!(safe_relative(bad), None, "{bad}");
        }
        assert!(has_device_name("/models/CON"));
        assert!(has_device_name("/models/%43ON.onnx"));
        assert!(!has_device_name("/models/whisper/encoder.onnx"));
    }
}
