// Rust port of lab/ui/e2e.js — agent-yes end-to-end encryption for the WebRTC
// share DataChannel (protocol "ay-e2e-1", URL marker "e1."). Must stay
// byte-identical to the JS implementation; see that file for the threat model.
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{anyhow, bail, Result};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

pub const PROTO: &str = "ay-e2e-1";
pub const MARKER: &str = "e1.";
const INFO_AUTH: &str = "ay/ay-e2e-1/auth";
const INFO_H2C: &str = "ay/ay-e2e-1/key/host->client";
const INFO_C2H: &str = "ay/ay-e2e-1/key/client->host";
pub const MAX_CHUNK: usize = 12_000; // plaintext bytes per sealed frame
pub const CONFIRM_TIMEOUT_MS: u64 = 5_000;

const VER: u8 = 0x01;
pub const FLAG_CONFIRM: u8 = 0x01;
const HEADER_LEN: usize = 14; // VER(1) + FLAGS(1) + NONCE(12)
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Reject anything that isn't a full-entropy 64-hex secret. Fail-closed and
/// never echoes the input.
pub fn validate_s(s: &str) -> Result<&str> {
    if !is_hex64(s) {
        bail!("invalid share token");
    }
    Ok(s)
}

fn ikm_from_s(s: &str) -> Result<Vec<u8>> {
    Ok(hex::decode(validate_s(s)?)?)
}

fn hkdf32(ikm: &[u8], salt: &[u8], info: &str) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut okm = [0u8; 32];
    hk.expand(info.as_bytes(), &mut okm).expect("hkdf expand 32");
    okm
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().into()
}

/// The ONLY value the signaling server sees; one-way from S.
pub fn derive_auth_token(s: &str, room: &str, sighost: &str) -> Result<String> {
    let salt = sha256(format!("{room}\n{sighost}").as_bytes());
    Ok(hex::encode(hkdf32(&ikm_from_s(s)?, &salt, INFO_AUTH)))
}

pub struct DirKeys {
    pub h2c: Aes256Gcm, // host encrypts with H2C
    pub c2h: Aes256Gcm, // host decrypts with C2H
}

pub fn derive_dir_keys(s: &str, transcript_hash: &[u8; 32]) -> Result<DirKeys> {
    let ikm = ikm_from_s(s)?;
    let h2c = hkdf32(&ikm, transcript_hash, INFO_H2C);
    let c2h = hkdf32(&ikm, transcript_hash, INFO_C2H);
    Ok(DirKeys {
        h2c: Aes256Gcm::new((&h2c).into()),
        c2h: Aes256Gcm::new((&c2h).into()),
    })
}

// ---- transcript hash (channel binding) ------------------------------------

fn all_fingerprints(sdp: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in sdp.lines() {
        let line = line.trim_end_matches('\r');
        // JS: /^a=fingerprint:(.*)$/gim — case-insensitive prefix match
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("a=fingerprint:") {
            // value taken from the ORIGINAL line then lowercased+trimmed,
            // which equals taking it from the lowered line
            out.push(rest.trim().to_string());
        }
    }
    out
}

fn first_attr(sdp: &str, name: &str) -> String {
    let prefix = format!("a={name}:");
    for line in sdp.lines() {
        let line = line.trim_end_matches('\r');
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix(&prefix) {
            return rest.trim().to_string();
        }
    }
    String::new()
}

/// Bind the session to the DTLS handshake; used as HKDF salt AND AEAD AAD.
/// Host passes offer=local / answer=remote.
pub fn compute_transcript_hash(offer_sdp: &str, answer_sdp: &str) -> Result<[u8; 32]> {
    let mut offer_fps = all_fingerprints(offer_sdp);
    let mut answer_fps = all_fingerprints(answer_sdp);
    offer_fps.sort();
    answer_fps.sort();
    if offer_fps.is_empty() || answer_fps.is_empty() {
        bail!("e2e: missing DTLS fingerprint");
    }
    for fp in offer_fps.iter().chain(answer_fps.iter()) {
        if !fp.starts_with("sha-256") {
            bail!("e2e: non-sha-256 DTLS fingerprint");
        }
    }
    let input = format!(
        "{PROTO}\noffer={};setup={};ufrag={}\nanswer={};setup={};ufrag={}",
        offer_fps.join(","),
        first_attr(offer_sdp, "setup"),
        first_attr(offer_sdp, "ice-ufrag"),
        answer_fps.join(","),
        first_attr(answer_sdp, "setup"),
        first_attr(answer_sdp, "ice-ufrag"),
    );
    Ok(sha256(input.as_bytes()))
}

// ---- AEAD frame seal / open -------------------------------------------------
// Wire frame: VER(1) | FLAGS(1) | NONCE(12) | CIPHERTEXT | TAG(16)
//   NONCE = [4-byte BE epoch = 0] | [8-byte BE monotonic per-direction counter]
//   AAD   = header(14) | transcriptHash(32)

fn nonce_from_counter(ctr: u64) -> [u8; NONCE_LEN] {
    let mut n = [0u8; NONCE_LEN];
    n[4..].copy_from_slice(&ctr.to_be_bytes());
    n
}

pub struct SendState {
    pub send_ctr: u64,
}
pub struct RecvState {
    /// None until the first frame; the JS side uses -1n.
    pub last_seen: Option<u64>,
}

pub fn seal(
    key: &Aes256Gcm,
    send: &mut SendState,
    flags: u8,
    th: &[u8; 32],
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    let ctr = send.send_ctr;
    if ctr == u64::MAX {
        bail!("e2e: nonce counter overflow");
    }
    send.send_ctr = ctr + 1;
    let nonce = nonce_from_counter(ctr);
    let mut header = [0u8; HEADER_LEN];
    header[0] = VER;
    header[1] = flags;
    header[2..].copy_from_slice(&nonce);
    let mut aad = Vec::with_capacity(HEADER_LEN + 32);
    aad.extend_from_slice(&header);
    aad.extend_from_slice(th);
    let sealed = key
        .encrypt((&nonce).into(), Payload { msg: plaintext, aad: &aad })
        .map_err(|_| anyhow!("e2e: encrypt failed"))?;
    let mut out = Vec::with_capacity(HEADER_LEN + sealed.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&sealed);
    Ok(out)
}

pub struct Opened {
    pub counter: u64,
    pub flags: u8,
    pub plaintext: Vec<u8>,
}

pub fn open(
    key: &Aes256Gcm,
    frame: &[u8],
    th: &[u8; 32],
    recv: &mut RecvState,
) -> Result<Opened> {
    if frame.len() < HEADER_LEN + TAG_LEN {
        bail!("e2e: short frame");
    }
    if frame[0] != VER {
        bail!("e2e: bad version");
    }
    let header = &frame[..HEADER_LEN];
    let nonce = &frame[2..HEADER_LEN];
    if nonce[..4] != [0, 0, 0, 0] {
        bail!("e2e: bad epoch");
    }
    let ctr = u64::from_be_bytes(nonce[4..12].try_into().unwrap());
    let mut aad = Vec::with_capacity(HEADER_LEN + 32);
    aad.extend_from_slice(header);
    aad.extend_from_slice(th);
    let plaintext = key
        .decrypt(&Nonce::try_from(nonce).expect("12-byte nonce"), Payload { msg: &frame[HEADER_LEN..], aad: &aad })
        .map_err(|_| anyhow!("e2e: auth failed"))?;
    // First accepted frame of a session MUST be counter-0 (the confirmation).
    match recv.last_seen {
        None if ctr != 0 => bail!("e2e: first frame must be counter-0"),
        Some(last) if ctr <= last => bail!("e2e: replay/reorder"),
        _ => {}
    }
    recv.last_seen = Some(ctr);
    Ok(Opened { counter: ctr, flags: header[1], plaintext })
}

/// Parse the secret slot of a share link. Ok((s, v2)).
pub fn parse_secret(token: &str) -> Result<(String, bool)> {
    if let Some(rest) = token.strip_prefix(MARKER) {
        if !is_hex64(rest) {
            bail!("malformed encrypted link");
        }
        return Ok((rest.to_string(), true));
    }
    // "e<digit>…" that isn't exactly e1.<64hex> must fail closed
    let b = token.as_bytes();
    if b.len() >= 2 && (b[0] == b'e' || b[0] == b'E') && b[1].is_ascii_digit() {
        bail!("malformed encrypted link");
    }
    Ok((token.to_string(), false))
}

pub fn random_hex(n_bytes: usize) -> String {
    use rand::RngCore;
    let mut b = vec![0u8; n_bytes];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: &str = "8b7df143d91c716ecfa5fc1730022f6b421b05cedee8fd52b1fc65a96030ad52";

    #[test]
    fn auth_token_matches_js() {
        // Vector generated with lab/ui/e2e.js under bun; pinned so any drift
        // from the JS implementation fails loudly.
        let t = derive_auth_token(S, "rdeadbeef0000", "s.agent-yes.com").unwrap();
        assert_eq!(t, "a50a14d9be1ce496e132a6b7147757b4e01b30876550f28f855f5089b6b9aa20");
    }

    #[test]
    fn opens_js_sealed_frame() {
        // Frame sealed by lab/ui/e2e.js (client->host key, counter 0,
        // FLAG_CONFIRM, th = 32×0x07) — must decrypt byte-identically.
        let th = [7u8; 32];
        let keys = derive_dir_keys(S, &th).unwrap();
        let frame = hex::decode(
            "010100000000000000000000000038c8b7906c875c4f489d24550a6d4a1d44e364598d86c4392c56d6b344308233e0216e64b0b7f077ef02a2c2",
        )
        .unwrap();
        let mut recv = RecvState { last_seen: None };
        let o = open(&keys.c2h, &frame, &th, &mut recv).unwrap();
        assert_eq!(o.flags, FLAG_CONFIRM);
        assert_eq!(o.plaintext, br#"{"t":"confirm","nonce":"aa"}"#);
    }

    #[test]
    fn seal_open_roundtrip() {
        let th = [7u8; 32];
        let keys = derive_dir_keys(S, &th).unwrap();
        let mut send = SendState { send_ctr: 0 };
        let mut recv = RecvState { last_seen: None };
        let f = seal(&keys.h2c, &mut send, FLAG_CONFIRM, &th, b"{\"t\":\"confirm\"}").unwrap();
        let o = open(&keys.h2c, &f, &th, &mut recv).unwrap();
        assert_eq!(o.counter, 0);
        assert_eq!(o.flags, FLAG_CONFIRM);
        assert_eq!(o.plaintext, b"{\"t\":\"confirm\"}");
        // replay must fail
        assert!(open(&keys.h2c, &f, &th, &mut recv).is_err());
    }

    #[test]
    fn first_frame_must_be_counter_zero() {
        let th = [9u8; 32];
        let keys = derive_dir_keys(S, &th).unwrap();
        let mut send = SendState { send_ctr: 5 };
        let mut recv = RecvState { last_seen: None };
        let f = seal(&keys.h2c, &mut send, 0, &th, b"x").unwrap();
        assert!(open(&keys.h2c, &f, &th, &mut recv).is_err());
    }

    #[test]
    fn parse_secret_grammar() {
        assert!(parse_secret(&format!("e1.{S}")).unwrap().1);
        assert!(parse_secret("e1.short").is_err());
        assert!(parse_secret("e2.0000").is_err());
        assert!(!parse_secret("customtoken").unwrap().1);
    }

    #[test]
    fn transcript_hash_symmetry_and_failclosed() {
        let offer = "v=0\r\na=fingerprint:sha-256 AA:BB\r\na=setup:actpass\r\na=ice-ufrag:abcd\r\n";
        let answer = "v=0\r\na=fingerprint:SHA-256 CC:DD\r\na=setup:active\r\na=ice-ufrag:efgh\r\n";
        let h = compute_transcript_hash(offer, answer).unwrap();
        assert_eq!(h, compute_transcript_hash(offer, answer).unwrap());
        assert!(compute_transcript_hash("v=0", answer).is_err());
        let sha1 = "a=fingerprint:sha-1 AA\r\na=setup:actpass\r\na=ice-ufrag:x\r\n";
        assert!(compute_transcript_hash(sha1, answer).is_err());
    }
}
