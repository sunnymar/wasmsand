//! printf - format and print data

use std::env;
use std::io::{self, Write};
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        return;
    }

    let format = &args[1];
    let mut arg_idx = 2;
    let stdout = io::stdout();
    let mut out = stdout.lock();

    let format_chars: Vec<char> = format.chars().collect();
    let mut i = 0;

    while i < format_chars.len() {
        if format_chars[i] == '\\' {
            i += 1;
            if i < format_chars.len() {
                match format_chars[i] {
                    'n' => {
                        let _ = out.write_all(b"\n");
                    }
                    't' => {
                        let _ = out.write_all(b"\t");
                    }
                    'r' => {
                        let _ = out.write_all(b"\r");
                    }
                    '\\' => {
                        let _ = out.write_all(b"\\");
                    }
                    'a' => {
                        let _ = out.write_all(b"\x07");
                    }
                    'b' => {
                        let _ = out.write_all(b"\x08");
                    }
                    'f' => {
                        let _ = out.write_all(b"\x0c");
                    }
                    'v' => {
                        let _ = out.write_all(b"\x0b");
                    }
                    '0' => {
                        let mut octal = String::new();
                        i += 1;
                        while i < format_chars.len()
                            && octal.len() < 3
                            && format_chars[i].is_digit(8)
                        {
                            octal.push(format_chars[i]);
                            i += 1;
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
                        continue; // i already advanced past octal digits
                    }
                    _ => {
                        let _ = out.write_all(b"\\");
                        let mut buf = [0u8; 4];
                        let s = format_chars[i].encode_utf8(&mut buf);
                        let _ = out.write_all(s.as_bytes());
                    }
                }
                i += 1;
            } else {
                let _ = out.write_all(b"\\");
            }
        } else if format_chars[i] == '%' {
            i += 1;
            if i >= format_chars.len() {
                let _ = out.write_all(b"%");
                break;
            }

            if format_chars[i] == '%' {
                let _ = out.write_all(b"%");
                i += 1;
                continue;
            }

            // Parse flags
            let mut left_align = false;
            let mut zero_pad = false;
            let mut plus_sign = false;
            let mut space_sign = false;
            let mut alt_form = false;

            while i < format_chars.len() {
                match format_chars[i] {
                    '-' => left_align = true,
                    '0' => zero_pad = true,
                    '+' => plus_sign = true,
                    ' ' => space_sign = true,
                    '#' => alt_form = true,
                    _ => break,
                }
                i += 1;
            }

            // Parse width
            let mut width: usize = 0;
            let mut has_width = false;
            if i < format_chars.len() && format_chars[i] == '*' {
                if arg_idx < args.len() {
                    width = args[arg_idx].parse().unwrap_or(0);
                    arg_idx += 1;
                }
                has_width = true;
                i += 1;
            } else {
                while i < format_chars.len() && format_chars[i].is_ascii_digit() {
                    has_width = true;
                    width = width * 10 + (format_chars[i] as usize - '0' as usize);
                    i += 1;
                }
            }

            // Parse precision
            let mut precision: Option<usize> = None;
            if i < format_chars.len() && format_chars[i] == '.' {
                i += 1;
                let mut prec: usize = 0;
                if i < format_chars.len() && format_chars[i] == '*' {
                    if arg_idx < args.len() {
                        prec = args[arg_idx].parse().unwrap_or(0);
                        arg_idx += 1;
                    }
                    i += 1;
                } else {
                    while i < format_chars.len() && format_chars[i].is_ascii_digit() {
                        prec = prec * 10 + (format_chars[i] as usize - '0' as usize);
                        i += 1;
                    }
                }
                precision = Some(prec);
            }

            if i >= format_chars.len() {
                let _ = out.write_all(b"%");
                break;
            }

            let spec = format_chars[i];
            i += 1;

            let arg_str = if arg_idx < args.len() {
                arg_idx += 1;
                args[arg_idx - 1].clone()
            } else {
                String::new()
            };

            let formatted = match spec {
                's' => {
                    let mut s = arg_str;
                    if let Some(prec) = precision {
                        if s.len() > prec {
                            s = s[..prec].to_string();
                        }
                    }
                    s
                }
                'd' | 'i' => {
                    let val: i64 = arg_str.parse().unwrap_or(0);
                    let sign = if val < 0 {
                        "-".to_string()
                    } else if plus_sign {
                        "+".to_string()
                    } else if space_sign {
                        " ".to_string()
                    } else {
                        String::new()
                    };
                    let digits = format!("{}", val.unsigned_abs());
                    format!("{}{}", sign, digits)
                }
                'u' => {
                    let val: u64 = arg_str.parse().unwrap_or(0);
                    format!("{}", val)
                }
                'o' => {
                    let val: u64 = arg_str.parse().unwrap_or(0);
                    if alt_form && val != 0 {
                        format!("0{:o}", val)
                    } else {
                        format!("{:o}", val)
                    }
                }
                'x' => {
                    let val: u64 = arg_str.parse().unwrap_or(0);
                    if alt_form && val != 0 {
                        format!("0x{:x}", val)
                    } else {
                        format!("{:x}", val)
                    }
                }
                'X' => {
                    let val: u64 = arg_str.parse().unwrap_or(0);
                    if alt_form && val != 0 {
                        format!("0X{:X}", val)
                    } else {
                        format!("{:X}", val)
                    }
                }
                'f' => {
                    let val: f64 = arg_str.parse().unwrap_or(0.0);
                    let prec = precision.unwrap_or(6);
                    format!("{:.*}", prec, val)
                }
                'e' => {
                    let val: f64 = arg_str.parse().unwrap_or(0.0);
                    let prec = precision.unwrap_or(6);
                    format_scientific(val, prec, false)
                }
                'E' => {
                    let val: f64 = arg_str.parse().unwrap_or(0.0);
                    let prec = precision.unwrap_or(6);
                    format_scientific(val, prec, true)
                }
                'g' | 'G' => {
                    let val: f64 = arg_str.parse().unwrap_or(0.0);
                    let prec = precision.unwrap_or(6);
                    format!("{:.*}", prec, val)
                }
                'c' => {
                    if arg_str.is_empty() {
                        String::new()
                    } else {
                        arg_str.chars().next().unwrap().to_string()
                    }
                }
                _ => {
                    // Unknown specifier, print literally
                    format!("%{}", spec)
                }
            };

            // Apply width and padding
            let pad_char = if zero_pad && !left_align && !matches!(spec, 's' | 'c') {
                '0'
            } else {
                ' '
            };

            if has_width || width > 0 {
                if left_align {
                    let _ = write!(out, "{:<width$}", formatted, width = width);
                } else if pad_char == '0' && matches!(spec, 'd' | 'i') {
                    // Zero-pad: sign goes before zeros
                    let sign_len = if formatted.starts_with('-')
                        || formatted.starts_with('+')
                        || formatted.starts_with(' ')
                    {
                        1
                    } else {
                        0
                    };
                    if sign_len > 0 && width > formatted.len() {
                        let _ = out.write_all(&formatted.as_bytes()[..sign_len]);
                        for _ in 0..(width - formatted.len()) {
                            let _ = out.write_all(b"0");
                        }
                        let _ = out.write_all(&formatted.as_bytes()[sign_len..]);
                    } else if width > formatted.len() {
                        for _ in 0..(width - formatted.len()) {
                            let _ = out.write_all(b"0");
                        }
                        let _ = out.write_all(formatted.as_bytes());
                    } else {
                        let _ = out.write_all(formatted.as_bytes());
                    }
                } else {
                    let _ = write!(out, "{:>width$}", formatted, width = width);
                }
            } else {
                let _ = out.write_all(formatted.as_bytes());
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

fn format_scientific(val: f64, prec: usize, upper: bool) -> String {
    if val == 0.0 {
        let e_char = if upper { 'E' } else { 'e' };
        return format!("0.{:0>prec$}{e_char}+00", "", prec = prec, e_char = e_char);
    }
    let abs = val.abs();
    let exp = abs.log10().floor() as i32;
    let mantissa = val / 10f64.powi(exp);
    let e_char = if upper { 'E' } else { 'e' };
    format!("{:.*}{}{:+03}", prec, mantissa, e_char, exp)
}
