//! ConPTY's DECSET 9001 belongs to the inner PTY, not the outer terminal.
//! Leaking it across a byte-stream relay turns VT input into literal-character
//! INPUT_RECORDs in the child (arrows, modifiers, mouse and paste all break).
//! Keep every other mode and byte intact, including split UTF-8 and CSI chunks.
#[derive(Default)]
pub struct ConptyModeFilter {
    pending: String,
}
impl ConptyModeFilter {
    pub fn feed(&mut self, chunk: &str) -> String {
        let mut text = std::mem::take(&mut self.pending);
        text.push_str(chunk);
        let mut out = String::new();
        let mut i = 0;
        while i < text.len() {
            let Some(offset) = text[i..].find('\x1b') else {
                out.push_str(&text[i..]);
                break;
            };
            let start = i + offset;
            out.push_str(&text[i..start]);
            let rest = &text[start..];
            if "\x1b[?".starts_with(rest) {
                self.pending = rest.into();
                break;
            }
            if !rest.starts_with("\x1b[?") {
                out.push('\x1b');
                i = start + 1;
                continue;
            }
            let mut end = start + 3;
            while end < text.len()
                && (text.as_bytes()[end].is_ascii_digit() || text.as_bytes()[end] == b';')
            {
                end += 1;
            }
            if end == text.len() && end - start < 256 {
                self.pending = rest.into();
                break;
            }
            let params: Vec<_> = text[start + 3..end].split(';').collect();
            let final_byte = text.as_bytes().get(end).copied();
            if matches!(final_byte, Some(b'h' | b'l')) && params.contains(&"9001") {
                let kept: Vec<_> = params.into_iter().filter(|p| *p != "9001").collect();
                if !kept.is_empty() {
                    out.push_str("\x1b[?");
                    out.push_str(&kept.join(";"));
                    out.push(final_byte.unwrap() as char);
                }
                i = end + 1;
            } else {
                out.push_str(&text[start..end]);
                i = end;
            }
        }
        out
    }
    pub fn finish(&mut self) -> String {
        std::mem::take(&mut self.pending)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_application_protocols_at_every_chunk_boundary() {
        let input = "hello?\x1b[?9001h\x1b[?1004;9001;2004h\x1b[?1003;1006h\x1b[A\x1b[200~paste\x1b[201~\x1b[?9001l\x1b[6n\x1b]7;cwd\x07";
        let expected = "hello?\x1b[?1004;2004h\x1b[?1003;1006h\x1b[A\x1b[200~paste\x1b[201~\x1b[6n\x1b]7;cwd\x07";
        for split in (0..=input.len()).filter(|i| input.is_char_boundary(*i)) {
            let mut filter = ConptyModeFilter::default();
            let got =
                filter.feed(&input[..split]) + &filter.feed(&input[split..]) + &filter.finish();
            assert_eq!(got, expected, "split {split}");
        }
        let mut filter = ConptyModeFilter::default();
        let mut got = String::new();
        for c in input.chars() {
            got.push_str(&filter.feed(&c.to_string()));
        }
        got.push_str(&filter.finish());
        assert_eq!(got, expected);
    }
    #[test]
    fn incomplete_and_unrelated_sequences_are_not_lost() {
        for text in [
            "\x1b",
            "\x1b[?",
            "\x1b[?9001",
            "\x1b[?90010h",
            "\x1b[?9001$p",
            "\x1b[?9001?",
            "\x1b[31mred",
        ] {
            let mut filter = ConptyModeFilter::default();
            assert_eq!(filter.feed(text) + &filter.finish(), text);
        }
        let text = format!("\x1b[?{}", "1".repeat(300));
        let mut filter = ConptyModeFilter::default();
        assert_eq!(filter.feed(&text), text);
    }
}
