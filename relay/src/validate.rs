//! Runtime validation for untrusted input, mirroring `packages/protocol/src/schema.ts`.
//!
//! Frames are deserialized into loose serde shapes first, then checked against
//! the same limits as the zod schema. Lengths are counted in UTF-16 code units
//! (what JavaScript's `string.length` and zod use) so both servers agree on
//! exactly which inputs are accepted.

use serde::{Deserialize, Deserializer};
use serde_json::error::Category;

use crate::protocol::{ClientMsg, CreateRoomRequest, Role, RoomStatus, limits};

/// One inbound WebSocket frame as the transport delivered it.
#[derive(Clone, Copy, Debug)]
pub enum Frame<'a> {
    Text(&'a str),
    Binary,
}

/// Largest integer JavaScript represents exactly (`Number.MAX_SAFE_INTEGER`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Treat an explicit JSON `null` as invalid, like zod's `.optional()` does.
fn non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum RawStatus {
    Live,
    Paused,
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase", rename_all_fields = "camelCase")]
enum RawClientMsg {
    Hello {
        role: Role,
        #[serde(default, deserialize_with = "non_null")]
        token: Option<String>,
        #[serde(default, deserialize_with = "non_null")]
        since: Option<f64>,
        #[serde(default, deserialize_with = "non_null")]
        v: Option<f64>,
    },
    Partial {
        id: String,
        text: String,
    },
    Final {
        id: String,
        text: String,
        #[serde(default, deserialize_with = "non_null")]
        start_ms: Option<f64>,
        #[serde(default, deserialize_with = "non_null")]
        end_ms: Option<f64>,
    },
    Correct {
        seq: f64,
        text: String,
    },
    Meta {
        #[serde(default, deserialize_with = "non_null")]
        title: Option<String>,
        #[serde(default, deserialize_with = "non_null")]
        lang: Option<String>,
        #[serde(default, deserialize_with = "non_null")]
        allow_export: Option<bool>,
    },
    Status {
        status: RawStatus,
    },
    History {
        before: f64,
        #[serde(default, deserialize_with = "non_null")]
        limit: Option<f64>,
    },
    End {},
    Ping {
        ts: serde_json::Number,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCreateRoom {
    #[serde(default, deserialize_with = "non_null")]
    title: Option<String>,
    #[serde(default, deserialize_with = "non_null")]
    lang: Option<String>,
    #[serde(default, deserialize_with = "non_null")]
    allow_export: Option<bool>,
}

/// Parse a raw WebSocket frame into a validated client message.
/// The error string is sent back to the client in an `error bad-frame`.
pub fn parse_client_frame(frame: Frame<'_>) -> Result<ClientMsg, String> {
    let raw = match frame {
        Frame::Binary => return Err("binary frames are not supported".into()),
        Frame::Text(raw) => raw,
    };
    if exceeds_frame_limit(raw) {
        return Err("frame too large".into());
    }
    // serde would also accept a JSON array for a struct or tagged enum; zod does not.
    if !is_json_object(raw.as_bytes()) {
        return Err(if is_json(raw.as_bytes()) {
            "frame: expected a JSON object".to_string()
        } else {
            "frame is not valid JSON".to_string()
        });
    }
    let parsed: RawClientMsg = serde_json::from_str(raw).map_err(|e| match e.classify() {
        Category::Syntax | Category::Eof | Category::Io => "frame is not valid JSON".to_string(),
        Category::Data => format!("invalid frame: {e}"),
    })?;
    validate_client_msg(parsed)
}

/// True when the first non-whitespace byte opens a JSON object.
fn is_json_object(raw: &[u8]) -> bool {
    raw.iter().find(|b| !b" \t\n\r".contains(b)) == Some(&b'{')
}

fn is_json(raw: &[u8]) -> bool {
    serde_json::from_slice::<serde::de::IgnoredAny>(raw).is_ok()
}

fn validate_client_msg(raw: RawClientMsg) -> Result<ClientMsg, String> {
    Ok(match raw {
        RawClientMsg::Hello {
            role,
            token,
            since,
            v,
        } => {
            if let Some(token) = &token {
                check_len(
                    "token",
                    token,
                    limits::MIN_TOKEN_CHARS,
                    limits::MAX_TOKEN_CHARS,
                )?;
            }
            if let Some(v) = v {
                int_in("v", v, 1, None)?;
            }
            let since = since.map(|s| int_in("since", s, 0, None)).transpose()?;
            ClientMsg::Hello { role, token, since }
        }
        RawClientMsg::Partial { id, text } => {
            check_id(&id)?;
            check_text(&text)?;
            ClientMsg::Partial { id, text }
        }
        RawClientMsg::Final {
            id,
            text,
            start_ms,
            end_ms,
        } => {
            check_id(&id)?;
            check_text(&text)?;
            let max = Some(limits::MAX_OFFSET_MS);
            let start_ms = start_ms.map(|v| int_in("startMs", v, 0, max)).transpose()?;
            let end_ms = end_ms.map(|v| int_in("endMs", v, 0, max)).transpose()?;
            ClientMsg::Final {
                id,
                text,
                start_ms,
                end_ms,
            }
        }
        RawClientMsg::Correct { seq, text } => {
            let seq = int_in("seq", seq, 1, None)?;
            check_text(&text)?;
            ClientMsg::Correct { seq, text }
        }
        RawClientMsg::Meta {
            title,
            lang,
            allow_export,
        } => {
            if let Some(title) = &title {
                check_len("title", title, 0, limits::MAX_TITLE_CHARS)?;
            }
            if let Some(lang) = &lang {
                check_lang(lang)?;
            }
            ClientMsg::Meta {
                title,
                lang,
                allow_export,
            }
        }
        RawClientMsg::Status { status } => ClientMsg::Status {
            status: match status {
                RawStatus::Live => RoomStatus::Live,
                RawStatus::Paused => RoomStatus::Paused,
            },
        },
        RawClientMsg::History { before, limit } => {
            let before = int_in("before", before, 1, None)?;
            let max = Some(limits::HISTORY_PAGE as u64);
            let limit = limit.map(|l| int_in("limit", l, 1, max)).transpose()?;
            // Bounded by HISTORY_PAGE above, so the cast cannot truncate.
            ClientMsg::History {
                before,
                limit: limit.map(|l| l as usize),
            }
        }
        RawClientMsg::End {} => ClientMsg::End,
        RawClientMsg::Ping { ts } => ClientMsg::Ping { ts },
    })
}

/// Parse a `POST /api/rooms` body. An empty body or `null` means `{}`.
pub fn parse_create_room(body: &[u8]) -> Result<CreateRoomRequest, String> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(CreateRoomRequest::default());
    }
    if !is_json_object(body) {
        // `null` means `{}` (the reference does `data ?? {}`); anything else must be an object.
        return match serde_json::from_slice::<serde_json::Value>(body) {
            Ok(serde_json::Value::Null) => Ok(CreateRoomRequest::default()),
            Ok(_) => Err("Invalid request: expected a JSON object".to_string()),
            Err(_) => Err("Body must be JSON.".to_string()),
        };
    }
    let raw: RawCreateRoom = serde_json::from_slice(body).map_err(|e| match e.classify() {
        Category::Syntax | Category::Eof | Category::Io => "Body must be JSON.".to_string(),
        Category::Data => format!("Invalid request: {e}"),
    })?;
    if let Some(title) = &raw.title {
        check_len("title", title, 0, limits::MAX_TITLE_CHARS)?;
    }
    if let Some(lang) = &raw.lang {
        check_lang(lang)?;
    }
    Ok(CreateRoomRequest {
        title: raw.title,
        lang: raw.lang,
        allow_export: raw.allow_export,
    })
}

/// More than 8192 UTF-16 units (JavaScript's `string.length`).
pub fn exceeds_frame_limit(raw: &str) -> bool {
    // UTF-16 length never exceeds UTF-8 length, so only count when it might matter.
    raw.len() > limits::MAX_FRAME_UNITS && utf16_len(raw) > limits::MAX_FRAME_UNITS
}

/// `cleanText` from room-core.ts. Captions are single-line plain text: control
/// characters become spaces (they could forge extra cues in SRT/VTT exports),
/// bidi overrides are removed (they can spoof titles), runs of spaces collapse,
/// and the result is trimmed like JavaScript's `trim()`.
pub fn clean_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let c = if matches!(c, '\u{0000}'..='\u{001F}' | '\u{007F}') {
            ' '
        } else {
            c
        };
        let bidi = matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}');
        if bidi || (c == ' ' && out.ends_with(' ')) {
            continue;
        }
        out.push(c);
    }
    js_trim(&out).to_string()
}

/// Length in UTF-16 code units, matching JavaScript's `string.length`.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// Truncate to at most `max` UTF-16 code units without splitting a character.
pub fn truncate_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (idx, ch) in s.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return &s[..idx];
        }
    }
    s
}

/// `String.prototype.trim()`: JavaScript's whitespace set differs slightly from Rust's.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `^[A-Za-z0-9_.:-]{1,64}$`
pub fn is_valid_id(id: &str) -> bool {
    (1..=limits::MAX_ID_CHARS).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// `^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$`, 2 to 35 characters.
pub fn is_valid_lang(lang: &str) -> bool {
    if !(limits::MIN_LANG_CHARS..=limits::MAX_LANG_CHARS).contains(&lang.len()) {
        return false;
    }
    let mut parts = lang.split('-');
    let primary_ok = parts
        .next()
        .is_some_and(|p| (2..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphabetic()));
    primary_ok
        && parts.all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn check_id(id: &str) -> Result<(), String> {
    if is_valid_id(id) {
        Ok(())
    } else {
        Err("id: must be 1-64 characters from A-Z a-z 0-9 _ . : -".into())
    }
}

fn check_text(text: &str) -> Result<(), String> {
    check_len("text", text, 0, limits::MAX_TEXT_CHARS)
}

fn check_lang(lang: &str) -> Result<(), String> {
    if is_valid_lang(lang) {
        Ok(())
    } else {
        Err("lang: must be a language tag like en-US".into())
    }
}

fn check_len(field: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    let len = utf16_len(value);
    if len < min {
        return Err(format!("{field}: must be at least {min} characters"));
    }
    if len > max {
        return Err(format!("{field}: must be at most {max} characters"));
    }
    Ok(())
}

/// A JSON number that must be a safe integer within `[min, max]`.
fn int_in(field: &str, value: f64, min: u64, max: Option<u64>) -> Result<u64, String> {
    if !value.is_finite() || value.fract() != 0.0 || value.abs() > MAX_SAFE_INTEGER {
        return Err(format!("{field}: must be an integer"));
    }
    if value < min as f64 {
        return Err(format!("{field}: must be at least {min}"));
    }
    if let Some(max) = max.filter(|&m| value > m as f64) {
        return Err(format!("{field}: must be at most {max}"));
    }
    // Non-negative, integral and at most 2^53 - 1: the conversion is exact.
    Ok(value as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Result<ClientMsg, String> {
        parse_client_frame(Frame::Text(json))
    }

    #[test]
    fn parses_every_message_type() {
        assert_eq!(
            parse(r#"{"t":"hello","role":"speaker","token":"0123456789abcdef","since":3,"v":1}"#),
            Ok(ClientMsg::Hello {
                role: Role::Speaker,
                token: Some("0123456789abcdef".into()),
                since: Some(3)
            })
        );
        assert_eq!(
            parse(r#"{"t":"partial","id":"s1-1","text":"hi"}"#),
            Ok(ClientMsg::Partial {
                id: "s1-1".into(),
                text: "hi".into()
            })
        );
        assert_eq!(
            parse(r#"{"t":"final","id":"a","text":"Hi.","startMs":0,"endMs":1800}"#),
            Ok(ClientMsg::Final {
                id: "a".into(),
                text: "Hi.".into(),
                start_ms: Some(0),
                end_ms: Some(1800)
            })
        );
        assert_eq!(
            parse(r#"{"t":"correct","seq":1,"text":""}"#),
            Ok(ClientMsg::Correct {
                seq: 1,
                text: String::new()
            })
        );
        assert_eq!(
            parse(r#"{"t":"meta","title":"Bio","lang":"en-IN","allowExport":false}"#),
            Ok(ClientMsg::Meta {
                title: Some("Bio".into()),
                lang: Some("en-IN".into()),
                allow_export: Some(false)
            })
        );
        assert_eq!(
            parse(r#"{"t":"status","status":"paused"}"#),
            Ok(ClientMsg::Status {
                status: RoomStatus::Paused
            })
        );
        assert_eq!(
            parse(r#"{"t":"history","before":5,"limit":3}"#),
            Ok(ClientMsg::History {
                before: 5,
                limit: Some(3)
            })
        );
        assert_eq!(parse(r#"{"t":"end"}"#), Ok(ClientMsg::End));
        assert_eq!(parse(r#"{"t":"end","extra":1}"#), Ok(ClientMsg::End));
        assert!(matches!(
            parse(r#"{"t":"ping","ts":1.5}"#),
            Ok(ClientMsg::Ping { .. })
        ));
    }

    #[test]
    fn accepts_integral_floats_like_javascript() {
        assert_eq!(
            parse(r#"{"t":"correct","seq":2.0,"text":"x"}"#),
            Ok(ClientMsg::Correct {
                seq: 2,
                text: "x".into()
            })
        );
    }

    #[test]
    fn rejects_bad_frames() {
        assert_eq!(
            parse_client_frame(Frame::Binary),
            Err("binary frames are not supported".into())
        );
        assert_eq!(parse("not json"), Err("frame is not valid JSON".into()));
        assert_eq!(
            parse(r#"["end"]"#),
            Err("frame: expected a JSON object".into())
        );
        assert_eq!(
            parse(r#"["ping", 5]"#),
            Err("frame: expected a JSON object".into())
        );
        assert_eq!(parse("[oops"), Err("frame is not valid JSON".into()));
        assert!(parse(" \n{\"t\":\"end\"}").is_ok());
        for bad in [
            r#"[]"#,
            r#"{"t":"nope"}"#,
            r#"{"role":"listener"}"#,
            r#"{"t":"hello","role":"admin"}"#,
            r#"{"t":"hello","role":"speaker","token":"short"}"#,
            r#"{"t":"hello","role":"speaker","token":null}"#,
            r#"{"t":"hello","role":"listener","since":-1}"#,
            r#"{"t":"hello","role":"listener","since":1.5}"#,
            r#"{"t":"hello","role":"listener","v":0}"#,
            r#"{"t":"final","id":"bad id!","text":"x"}"#,
            r#"{"t":"final","id":"","text":"x"}"#,
            r#"{"t":"final","id":"a","text":"x","startMs":259200001}"#,
            r#"{"t":"final","id":"a","text":"x","endMs":-5}"#,
            r#"{"t":"partial","id":"a"}"#,
            r#"{"t":"correct","seq":0,"text":"x"}"#,
            r#"{"t":"meta","lang":"english!"}"#,
            r#"{"t":"status","status":"ended"}"#,
            r#"{"t":"history","before":0}"#,
            r#"{"t":"history","before":5,"limit":501}"#,
            r#"{"t":"history","before":5,"limit":0}"#,
            r#"{"t":"ping"}"#,
            r#"{"t":"ping","ts":"1"}"#,
        ] {
            assert!(parse(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn enforces_text_and_frame_limits() {
        let ok = format!(
            r#"{{"t":"partial","id":"a","text":"{}"}}"#,
            "x".repeat(2000)
        );
        assert!(parse(&ok).is_ok());
        let long = format!(
            r#"{{"t":"partial","id":"a","text":"{}"}}"#,
            "x".repeat(2001)
        );
        assert!(parse(&long).is_err());
        // 2000 astral characters are 4000 UTF-16 units: too long, as in JavaScript.
        let emoji = format!(
            r#"{{"t":"partial","id":"a","text":"{}"}}"#,
            "\u{1F600}".repeat(1001)
        );
        assert!(parse(&emoji).is_err());
        let huge = format!(r#"{{"t":"ping","ts":1,"pad":"{}"}}"#, "x".repeat(9000));
        assert_eq!(parse(&huge), Err("frame too large".into()));
        // Under 8192 UTF-16 units is accepted even above 8 KiB of UTF-8, as in JavaScript.
        let wide = format!(
            r#"{{"t":"ping","ts":1,"pad":"{}"}}"#,
            "\u{20AC}".repeat(3000)
        );
        assert!(wide.len() > 8192);
        assert!(parse(&wide).is_ok());
    }

    #[test]
    fn validates_ids_and_languages() {
        assert!(is_valid_id("s1a2-1"));
        assert!(is_valid_id("a.b:c_d-e"));
        assert!(is_valid_id(&"a".repeat(64)));
        assert!(!is_valid_id(&"a".repeat(65)));
        assert!(!is_valid_id("a b"));
        for good in ["en", "en-US", "zh-Hant-TW", "yue", "sgn-BE-FR", "es-419"] {
            assert!(is_valid_lang(good), "{good}");
        }
        for bad in [
            "e",
            "english",
            "en-",
            "en--US",
            "-en",
            "en-123456789",
            "e1",
            "en_US",
        ] {
            assert!(!is_valid_lang(bad), "{bad}");
        }
    }

    #[test]
    fn parses_create_room_bodies() {
        assert_eq!(parse_create_room(b""), Ok(CreateRoomRequest::default()));
        assert_eq!(parse_create_room(b"null"), Ok(CreateRoomRequest::default()));
        assert_eq!(parse_create_room(b"{}"), Ok(CreateRoomRequest::default()));
        assert_eq!(
            parse_create_room(br#"{"title":"Physics","lang":"fr-CA","allowExport":false,"x":1}"#),
            Ok(CreateRoomRequest {
                title: Some("Physics".into()),
                lang: Some("fr-CA".into()),
                allow_export: Some(false)
            })
        );
        let long_title = format!(r#"{{"title":"{}"}}"#, "t".repeat(121));
        assert!(parse_create_room(long_title.as_bytes()).is_err());
        assert!(parse_create_room(br#"{"lang":"nope!"}"#).is_err());
        assert!(parse_create_room(br#"{"allowExport":"yes"}"#).is_err());
        assert!(parse_create_room(br#"{"title":null}"#).is_err());
        assert!(parse_create_room(b"[1]").is_err());
        assert!(parse_create_room(b"[]").is_err());
        assert!(parse_create_room(br#"["Title"]"#).is_err());
        assert!(parse_create_room(b"42").is_err());
        assert_eq!(
            parse_create_room(b" null "),
            Ok(CreateRoomRequest::default())
        );
        assert!(parse_create_room(b"{oops").is_err());
    }

    #[test]
    fn cleans_text_like_room_core() {
        assert_eq!(
            clean_text("a\n\n2\n00:00 --> 99:00\nFAKE"),
            "a 2 00:00 --> 99:00 FAKE"
        );
        assert_eq!(clean_text("\u{202E}evil\u{202C} title\t"), "evil title");
        assert_eq!(clean_text("line one\r\nline two"), "line one line two");
        assert_eq!(clean_text("a \u{2066} b\u{7F}c"), "a b c");
        assert_eq!(clean_text("  many    spaces  "), "many spaces");
        assert_eq!(clean_text("\u{FEFF}\u{00A0}x\u{3000}"), "x");
        assert_eq!(clean_text("\n\t\u{202A}"), "");
        // Non-breaking spaces inside are kept (only U+0020 runs collapse).
        assert_eq!(clean_text("a\u{00A0}\u{00A0}b"), "a\u{00A0}\u{00A0}b");
    }

    #[test]
    fn trims_like_javascript() {
        assert_eq!(js_trim("\u{FEFF} hi \u{3000}\n"), "hi");
        assert_eq!(js_trim("\u{0085}x"), "\u{0085}x");
        assert_eq!(truncate_utf16("abc", 2), "ab");
        assert_eq!(truncate_utf16("a\u{1F600}b", 2), "a");
        assert_eq!(truncate_utf16("a\u{1F600}b", 3), "a\u{1F600}");
    }
}
