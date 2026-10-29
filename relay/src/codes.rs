//! Room codes and secrets, mirroring `packages/protocol/src/codes.ts`.
//!
//! Codes use a 31-character alphabet with no 0/O or 1/I/L so they survive
//! being read aloud or copied off a projector.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::{Rng, RngExt};
use sha2::{Digest, Sha256};

pub const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const CODE_LENGTH: usize = 6;
const TOKEN_BYTES: usize = 32;

/// Uniformly random room code.
pub fn generate_room_code() -> String {
    let mut rng = rand::rng();
    (0..CODE_LENGTH)
        .map(|_| char::from(CODE_ALPHABET[rng.random_range(0..CODE_ALPHABET.len())]))
        .collect()
}

/// Exactly six characters from the alphabet (no normalisation: servers reject anything else).
pub fn is_valid_room_code(code: &str) -> bool {
    code.len() == CODE_LENGTH && code.bytes().all(|b| CODE_ALPHABET.contains(&b))
}

/// 32 random bytes, base64url without padding (43 characters).
pub fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// SHA-256 hex digest. Only hashes of room secrets are ever stored.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Length-checked constant-time comparison.
pub fn timing_safe_equal(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_valid_codes() {
        for _ in 0..200 {
            let code = generate_room_code();
            assert!(is_valid_room_code(&code), "{code}");
        }
    }

    #[test]
    fn rejects_bad_codes() {
        assert!(is_valid_room_code("K7QF3M"));
        for bad in [
            "", "K7QF3", "K7QF3MM", "k7qf3m", "K7QF0M", "K7QF1M", "K7QFOM", "K7QFIM", "K7QFLM",
            "K7-F3M", "ÄÄÄ",
        ] {
            assert!(!is_valid_room_code(bad), "{bad}");
        }
    }

    #[test]
    fn tokens_are_43_url_safe_chars() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
        assert!(
            a.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        );
    }

    #[test]
    fn hashes_with_sha256_hex() {
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn compares_in_constant_time() {
        assert!(timing_safe_equal("abc", "abc"));
        assert!(!timing_safe_equal("abc", "abd"));
        assert!(!timing_safe_equal("abc", "abcd"));
    }
}
