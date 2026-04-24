use std::env;
use std::io::{self, BufWriter, Write};
use std::process;

fn die(msg: &str) -> ! {
    eprintln!("seq: {msg}");
    // Flush stdout so WASM proc_exit doesn't leave open pipe ends.
    let _ = io::stdout().flush();
    process::exit(1);
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    let mut separator = String::from("\n");
    let mut equal_width = false;
    let mut pos: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-s" => {
                i += 1;
                if i >= args.len() {
                    die("option requires an argument -- 's'");
                }
                separator = args[i].clone();
            }
            "-w" => {
                equal_width = true;
            }
            "--" => {
                // Remaining args are positional
                i += 1;
                while i < args.len() {
                    pos.push(args[i].clone());
                    i += 1;
                }
                break;
            }
            a if a.starts_with("-s") => {
                // -sSEP (separator glued to flag)
                separator = a[2..].to_string();
            }
            a if a.starts_with('-') && a.len() > 1 && !a.starts_with("--") => {
                // Unknown flag — try treating as a negative number
                pos.push(a.to_string());
            }
            _ => {
                pos.push(args[i].clone());
            }
        }
        i += 1;
    }

    let (first, step, last): (f64, f64, f64) = match pos.len() {
        1 => (
            1.0,
            1.0,
            pos[0].parse::<f64>().unwrap_or_else(|_| die("invalid argument")),
        ),
        2 => {
            let a = pos[0].parse::<f64>().unwrap_or_else(|_| die("invalid argument"));
            let b = pos[1].parse::<f64>().unwrap_or_else(|_| die("invalid argument"));
            (a, if a <= b { 1.0 } else { -1.0 }, b)
        }
        3 => {
            let a = pos[0].parse::<f64>().unwrap_or_else(|_| die("invalid argument"));
            let s = pos[1].parse::<f64>().unwrap_or_else(|_| die("invalid argument"));
            let b = pos[2].parse::<f64>().unwrap_or_else(|_| die("invalid argument"));
            (a, s, b)
        }
        _ => {
            die("usage: seq [FIRST [STEP]] LAST");
        }
    };

    if step == 0.0 {
        die("invalid Zero increment value: '0'");
    }

    // Determine format string
    let fmt_int = first.fract() == 0.0 && step.fract() == 0.0 && last.fract() == 0.0;

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    let mut values: Vec<String> = Vec::new();
    let mut current = first;
    if step > 0.0 {
        while current <= last + step * 1e-10 {
            if fmt_int {
                values.push(format!("{}", current as i64));
            } else {
                values.push(format!("{}", current));
            }
            current += step;
            // Guard against float overflow/infinite loop
            if values.len() > 10_000_000 {
                break;
            }
        }
    } else {
        while current >= last + step * 1e-10 {
            if fmt_int {
                values.push(format!("{}", current as i64));
            } else {
                values.push(format!("{}", current));
            }
            current += step;
            if values.len() > 10_000_000 {
                break;
            }
        }
    }

    if equal_width && fmt_int {
        // Pad all values to the same width
        let max_width = values.iter().map(|v| v.len()).max().unwrap_or(0);
        for v in &mut values {
            while v.len() < max_width {
                v.insert(0, '0');
            }
        }
    }

    for (idx, v) in values.iter().enumerate() {
        let _ = out.write_all(v.as_bytes());
        if idx + 1 < values.len() {
            let _ = out.write_all(separator.as_bytes());
        } else {
            let _ = out.write_all(b"\n");
        }
    }

    let _ = out.flush();
}
