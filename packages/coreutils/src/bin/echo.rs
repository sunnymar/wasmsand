//! echo - display a line of text

use std::env;
use std::io::{self, Write};
use std::process;

/// Process escape sequences in a string, returning the processed bytes.
/// Returns (bytes, should_stop) where should_stop is true if \c was encountered.
fn process_escapes(s: &str) -> (Vec<u8>, bool) {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            i += 1;
            match bytes[i] {
                b'\\' => out.push(b'\\'),
                b'a' => out.push(0x07),
                b'b' => out.push(0x08),
                b'c' => return (out, true), // stop output, no trailing newline
                b'e' => out.push(0x1B),
                b'f' => out.push(0x0C),
                b'n' => out.push(b'\n'),
                b'r' => out.push(b'\r'),
                b't' => out.push(b'\t'),
                b'v' => out.push(0x0B),
                b'0' => {
                    // Octal: \0NNN (up to 3 octal digits after the 0)
                    let mut val: u8 = 0;
                    let mut count = 0;
                    while count < 3
                        && i + 1 < bytes.len()
                        && bytes[i + 1] >= b'0'
                        && bytes[i + 1] <= b'7'
                    {
                        val = val.wrapping_mul(8).wrapping_add(bytes[i + 1] - b'0');
                        i += 1;
                        count += 1;
                    }
                    out.push(val);
                }
                b'x' => {
                    // Hex: \xHH (up to 2 hex digits)
                    let mut val: u8 = 0;
                    let mut count = 0;
                    while count < 2 && i + 1 < bytes.len() {
                        let next = bytes[i + 1];
                        let digit = match next {
                            b'0'..=b'9' => next - b'0',
                            b'a'..=b'f' => next - b'a' + 10,
                            b'A'..=b'F' => next - b'A' + 10,
                            _ => break,
                        };
                        val = val.wrapping_mul(16).wrapping_add(digit);
                        i += 1;
                        count += 1;
                    }
                    if count > 0 {
                        out.push(val);
                    } else {
                        // No hex digits followed \x, output literal
                        out.push(b'\\');
                        out.push(b'x');
                    }
                }
                other => {
                    // Unknown escape: output the backslash and the character literally
                    out.push(b'\\');
                    out.push(other);
                }
            }
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    (out, false)
}

fn run() -> i32 {
    let args: Vec<String> = env::args().collect();
    let mut trailing_newline = true;
    let mut interpret_escapes = false;
    let mut arg_start = 1;

    // Parse leading flags. echo stops parsing flags at the first non-flag argument.
    while arg_start < args.len() {
        let arg = &args[arg_start];
        if arg == "-n" {
            trailing_newline = false;
            arg_start += 1;
        } else if arg == "-e" {
            interpret_escapes = true;
            arg_start += 1;
        } else if arg == "-E" {
            interpret_escapes = false;
            arg_start += 1;
        } else if arg == "-ne" || arg == "-en" {
            trailing_newline = false;
            interpret_escapes = true;
            arg_start += 1;
        } else if arg == "-nE" || arg == "-En" {
            trailing_newline = false;
            interpret_escapes = false;
            arg_start += 1;
        } else {
            break;
        }
    }

    let stdout = io::stdout();
    let mut out = stdout.lock();

    let remaining = &args[arg_start..];
    for (i, arg) in remaining.iter().enumerate() {
        if i > 0 && out.write_all(b" ").is_err() {
            return 1;
        }
        if interpret_escapes {
            let (bytes, stop) = process_escapes(arg);
            if out.write_all(&bytes).is_err() {
                return 1;
            }
            if stop {
                // \c means suppress further output including trailing newline
                let _ = out.flush();
                return 0;
            }
        } else if out.write_all(arg.as_bytes()).is_err() {
            return 1;
        }
    }

    if trailing_newline && out.write_all(b"\n").is_err() {
        return 1;
    }

    let _ = out.flush();
    0
}

fn main() {
    process::exit(run());
}
