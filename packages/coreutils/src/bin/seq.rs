use std::env;
use std::io::{self, BufWriter, Write};
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let (first, step, last) = match args.len() {
        1 => (
            1i64,
            1i64,
            args[0].parse::<i64>().unwrap_or_else(|_| {
                eprintln!("seq: invalid argument");
                process::exit(1);
            }),
        ),
        2 => {
            let a = args[0].parse::<i64>().unwrap_or_else(|_| {
                eprintln!("seq: invalid argument");
                process::exit(1);
            });
            let b = args[1].parse::<i64>().unwrap_or_else(|_| {
                eprintln!("seq: invalid argument");
                process::exit(1);
            });
            (a, 1, b)
        }
        3 => {
            let a = args[0].parse::<i64>().unwrap_or_else(|_| {
                eprintln!("seq: invalid argument");
                process::exit(1);
            });
            let s = args[1].parse::<i64>().unwrap_or_else(|_| {
                eprintln!("seq: invalid argument");
                process::exit(1);
            });
            let b = args[2].parse::<i64>().unwrap_or_else(|_| {
                eprintln!("seq: invalid argument");
                process::exit(1);
            });
            (a, s, b)
        }
        _ => {
            eprintln!("seq: usage: seq [FIRST [STEP]] LAST");
            process::exit(1);
        }
    };

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let mut i = first;
    if step > 0 {
        while i <= last {
            let _ = writeln!(out, "{i}");
            i += step;
        }
    } else if step < 0 {
        while i >= last {
            let _ = writeln!(out, "{i}");
            i += step;
        }
    }
}
