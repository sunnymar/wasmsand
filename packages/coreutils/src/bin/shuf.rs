use std::{
    env,
    io::{self, BufRead, Write},
    process,
};

// Simple PRNG (xorshift64)
fn xorshift64(state: &mut u64) -> u64 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    *state = x;
    x
}

fn shuffle(lines: &mut [String], seed: u64) {
    let mut state = seed;
    let n = lines.len();
    for i in (1..n).rev() {
        let j = (xorshift64(&mut state) as usize) % (i + 1);
        lines.swap(i, j);
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut input_range: Option<(i64, i64)> = None;
    let mut count: Option<usize> = None;
    let mut files: Vec<String> = Vec::new();
    let mut zero_terminated = false;

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-i" | "--input-range" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("shuf: missing argument for -i");
                    process::exit(1);
                }
                let parts: Vec<&str> = args[i].split('-').collect();
                if parts.len() == 2 {
                    if let (Ok(lo), Ok(hi)) = (parts[0].parse::<i64>(), parts[1].parse::<i64>()) {
                        input_range = Some((lo, hi));
                    }
                }
            }
            "-n" | "--head-count" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("shuf: missing argument for -n");
                    process::exit(1);
                }
                count = args[i].parse().ok();
            }
            "-z" | "--zero-terminated" => {
                zero_terminated = true;
            }
            "-e" | "--echo" => {
                // Rest of args are items to shuffle
                i += 1;
                let mut items: Vec<String> = args[i..].to_vec();
                let seed = items.len() as u64 ^ 0xdeadbeef;
                shuffle(&mut items, seed);
                if let Some(n) = count {
                    items.truncate(n);
                }
                let sep = if zero_terminated { "\0" } else { "\n" };
                for item in &items {
                    print!("{}{}", item, sep);
                }
                return;
            }
            arg if !arg.starts_with('-') => {
                files.push(arg.to_string());
            }
            _ => {}
        }
        i += 1;
    }

    let mut lines: Vec<String> = if let Some((lo, hi)) = input_range {
        (lo..=hi).map(|n| n.to_string()).collect()
    } else {
        let stdin = io::stdin();
        let reader: Box<dyn BufRead> = if files.is_empty() {
            Box::new(stdin.lock())
        } else {
            Box::new(io::BufReader::new(
                std::fs::File::open(&files[0]).unwrap_or_else(|e| {
                    eprintln!("shuf: {}: {}", files[0], e);
                    process::exit(1);
                }),
            ))
        };
        reader.lines().map_while(Result::ok).collect()
    };

    let seed = lines.len() as u64 ^ 0xcafebabe;
    shuffle(&mut lines, seed);
    if let Some(n) = count {
        lines.truncate(n);
    }
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let sep = if zero_terminated { "\0" } else { "\n" };
    for line in &lines {
        let _ = write!(out, "{}{}", line, sep);
    }
}
