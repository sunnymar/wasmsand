use std::env;
use std::fs;
use std::io::{self, Write};
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let paths: Vec<&str> = args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(|s| s.as_str())
        .collect();
    if paths.len() != 2 {
        eprintln!("diff: usage: diff FILE1 FILE2");
        process::exit(2);
    }

    let content1 = match fs::read_to_string(paths[0]) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("diff: {}: {e}", paths[0]);
            process::exit(2);
        }
    };
    let content2 = match fs::read_to_string(paths[1]) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("diff: {}: {e}", paths[1]);
            process::exit(2);
        }
    };

    let lines1: Vec<&str> = content1.lines().collect();
    let lines2: Vec<&str> = content2.lines().collect();

    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut differs = false;
    let max = lines1.len().max(lines2.len());

    for i in 0..max {
        let l1 = lines1.get(i).copied().unwrap_or("");
        let l2 = lines2.get(i).copied().unwrap_or("");
        if l1 != l2 {
            differs = true;
            let _ = writeln!(out, "{}c{}", i + 1, i + 1);
            let _ = writeln!(out, "< {l1}");
            let _ = writeln!(out, "---");
            let _ = writeln!(out, "> {l2}");
        }
    }

    process::exit(if differs { 1 } else { 0 });
}
