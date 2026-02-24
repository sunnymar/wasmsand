//! base64 - encode or decode base64

use std::env;
use std::io::{self, Read, Write};
use std::process;

const ENCODE_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn decode_char(c: u8) -> Option<u8> {
    match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn encode(input: &[u8]) -> String {
    let mut output = Vec::new();
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i] as u32;
        let b1 = if i + 1 < input.len() {
            input[i + 1] as u32
        } else {
            0
        };
        let b2 = if i + 2 < input.len() {
            input[i + 2] as u32
        } else {
            0
        };

        let triple = (b0 << 16) | (b1 << 8) | b2;

        output.push(ENCODE_TABLE[((triple >> 18) & 0x3F) as usize]);
        output.push(ENCODE_TABLE[((triple >> 12) & 0x3F) as usize]);

        if i + 1 < input.len() {
            output.push(ENCODE_TABLE[((triple >> 6) & 0x3F) as usize]);
        } else {
            output.push(b'=');
        }

        if i + 2 < input.len() {
            output.push(ENCODE_TABLE[(triple & 0x3F) as usize]);
        } else {
            output.push(b'=');
        }

        i += 3;
    }

    String::from_utf8(output).unwrap()
}

fn decode(input: &str) -> Result<Vec<u8>, String> {
    let filtered: Vec<u8> = input
        .bytes()
        .filter(|&b| b != b'\n' && b != b'\r' && b != b' ')
        .collect();
    let mut output = Vec::new();
    let mut i = 0;

    while i < filtered.len() {
        // Skip padding at the end
        if filtered[i] == b'=' {
            break;
        }

        let c0 = decode_char(filtered[i])
            .ok_or_else(|| format!("invalid character: {}", filtered[i] as char))?;
        let c1 = if i + 1 < filtered.len() && filtered[i + 1] != b'=' {
            decode_char(filtered[i + 1])
                .ok_or_else(|| format!("invalid character: {}", filtered[i + 1] as char))?
        } else {
            0
        };
        let c2 = if i + 2 < filtered.len() && filtered[i + 2] != b'=' {
            decode_char(filtered[i + 2])
                .ok_or_else(|| format!("invalid character: {}", filtered[i + 2] as char))?
        } else {
            0
        };
        let c3 = if i + 3 < filtered.len() && filtered[i + 3] != b'=' {
            decode_char(filtered[i + 3])
                .ok_or_else(|| format!("invalid character: {}", filtered[i + 3] as char))?
        } else {
            0
        };

        let triple = ((c0 as u32) << 18) | ((c1 as u32) << 12) | ((c2 as u32) << 6) | (c3 as u32);

        output.push(((triple >> 16) & 0xFF) as u8);

        if i + 2 < filtered.len() && filtered[i + 2] != b'=' {
            output.push(((triple >> 8) & 0xFF) as u8);
        }

        if i + 3 < filtered.len() && filtered[i + 3] != b'=' {
            output.push((triple & 0xFF) as u8);
        }

        i += 4;
    }

    Ok(output)
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--help") {
        println!("Usage: base64 [-d]");
        println!("Encode or decode base64 from stdin.");
        println!("  -d  decode base64 input");
        return;
    }

    let do_decode = args.iter().any(|a| a == "-d" || a == "--decode");

    let mut input = Vec::new();
    if io::stdin().read_to_end(&mut input).is_err() {
        eprintln!("base64: read error");
        process::exit(1);
    }

    if do_decode {
        let input_str = String::from_utf8_lossy(&input);
        match decode(&input_str) {
            Ok(decoded) => {
                let stdout = io::stdout();
                let mut out = stdout.lock();
                let _ = out.write_all(&decoded);
                let _ = out.flush();
            }
            Err(e) => {
                eprintln!("base64: {}", e);
                process::exit(1);
            }
        }
    } else {
        let encoded = encode(&input);
        // Wrap at 76 characters
        let stdout = io::stdout();
        let mut out = stdout.lock();
        let bytes = encoded.as_bytes();
        let mut pos = 0;
        while pos < bytes.len() {
            let end = if pos + 76 < bytes.len() {
                pos + 76
            } else {
                bytes.len()
            };
            let _ = out.write_all(&bytes[pos..end]);
            let _ = out.write_all(b"\n");
            pos = end;
        }
        let _ = out.flush();
    }
}
