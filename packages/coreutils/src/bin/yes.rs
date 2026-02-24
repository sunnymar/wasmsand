use std::env;
use std::io::{self, BufWriter, Write};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let line = if args.is_empty() {
        "y".to_string()
    } else {
        args.join(" ")
    };
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    // Bounded output: WASI sandbox runs pipeline stages sequentially so an
    // infinite loop would accumulate unbounded stdout in memory. 10 000 lines
    // is plenty for any practical `yes | head -N` usage.
    for _ in 0..10_000 {
        if writeln!(out, "{line}").is_err() {
            break;
        }
    }
}
