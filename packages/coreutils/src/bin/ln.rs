use std::env;
use std::fs;
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // Skip flags like -s, -f (symlinks not supported in VFS, just copy)
    let paths: Vec<&str> = args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(|s| s.as_str())
        .collect();
    if paths.len() != 2 {
        eprintln!("ln: usage: ln SOURCE DEST");
        process::exit(1);
    }
    match fs::copy(paths[0], paths[1]) {
        Ok(_) => {}
        Err(e) => {
            eprintln!("ln: {}: {e}", paths[0]);
            process::exit(1);
        }
    }
}
