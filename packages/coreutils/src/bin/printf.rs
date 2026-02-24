//! printf - format and print data

use std::env;
use std::io::{self, Write};
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        // printf with no arguments does nothing (matching GNU behavior)
        return;
    }

    let format = &args[1];
    let mut arg_idx = 2; // Index into args for format arguments
    let stdout = io::stdout();
    let mut out = stdout.lock();

    let format_chars: Vec<char> = format.chars().collect();
    let mut i = 0;

    while i < format_chars.len() {
        if format_chars[i] == '\\' {
            // Handle escape sequences
            if i + 1 < format_chars.len() {
                match format_chars[i + 1] {
                    'n' => {
                        let _ = out.write_all(b"\n");
                        i += 2;
                    }
                    't' => {
                        let _ = out.write_all(b"\t");
                        i += 2;
                    }
                    'r' => {
                        let _ = out.write_all(b"\r");
                        i += 2;
                    }
                    '\\' => {
                        let _ = out.write_all(b"\\");
                        i += 2;
                    }
                    '0' => {
                        // Octal escape \0NNN
                        let mut octal = String::new();
                        let mut j = i + 2;
                        while j < format_chars.len()
                            && octal.len() < 3
                            && format_chars[j].is_digit(8)
                        {
                            octal.push(format_chars[j]);
                            j += 1;
                        }
                        let val = if octal.is_empty() {
                            0u32
                        } else {
                            u32::from_str_radix(&octal, 8).unwrap_or(0)
                        };
                        if let Some(ch) = char::from_u32(val) {
                            let mut buf = [0u8; 4];
                            let s = ch.encode_utf8(&mut buf);
                            let _ = out.write_all(s.as_bytes());
                        }
                        i = j;
                    }
                    _ => {
                        let _ = out.write_all(b"\\");
                        i += 1;
                    }
                }
            } else {
                let _ = out.write_all(b"\\");
                i += 1;
            }
        } else if format_chars[i] == '%' {
            if i + 1 < format_chars.len() {
                match format_chars[i + 1] {
                    '%' => {
                        let _ = out.write_all(b"%");
                        i += 2;
                    }
                    's' => {
                        let val = if arg_idx < args.len() {
                            arg_idx += 1;
                            args[arg_idx - 1].as_str()
                        } else {
                            ""
                        };
                        let _ = out.write_all(val.as_bytes());
                        i += 2;
                    }
                    'd' => {
                        let val: i64 = if arg_idx < args.len() {
                            arg_idx += 1;
                            args[arg_idx - 1].parse().unwrap_or(0)
                        } else {
                            0
                        };
                        let _ = write!(out, "{}", val);
                        i += 2;
                    }
                    'f' => {
                        let val: f64 = if arg_idx < args.len() {
                            arg_idx += 1;
                            args[arg_idx - 1].parse().unwrap_or(0.0)
                        } else {
                            0.0
                        };
                        let _ = write!(out, "{:.6}", val);
                        i += 2;
                    }
                    _ => {
                        // Unknown format specifier, print literally
                        let _ = out.write_all(b"%");
                        i += 1;
                    }
                }
            } else {
                let _ = out.write_all(b"%");
                i += 1;
            }
        } else {
            let mut buf = [0u8; 4];
            let s = format_chars[i].encode_utf8(&mut buf);
            let _ = out.write_all(s.as_bytes());
            i += 1;
        }
    }

    if let Err(e) = out.flush() {
        eprintln!("printf: write error: {}", e);
        process::exit(1);
    }
}
