use std::{
    env,
    io::{self, BufRead},
    process,
};

fn factorize(mut n: u64) -> Vec<u64> {
    let mut factors = Vec::new();
    let mut d = 2u64;
    while d * d <= n {
        while n.is_multiple_of(d) {
            factors.push(d);
            n /= d;
        }
        d += 1;
    }
    if n > 1 {
        factors.push(n);
    }
    factors
}

fn process_number(s: &str) {
    let s = s.trim();
    if s.is_empty() {
        return;
    }
    match s.parse::<u64>() {
        Ok(n) => {
            let factors = factorize(n);
            let parts: Vec<String> = factors.iter().map(|f| f.to_string()).collect();
            println!("{}: {}", n, parts.join(" "));
        }
        Err(_) => {
            eprintln!("factor: '{}' is not a valid positive integer", s);
            process::exit(1);
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        // Read from stdin
        let stdin = io::stdin();
        for line in stdin.lock().lines().map_while(Result::ok) {
            for word in line.split_whitespace() {
                process_number(word);
            }
        }
    } else {
        for arg in &args {
            process_number(arg);
        }
    }
}
