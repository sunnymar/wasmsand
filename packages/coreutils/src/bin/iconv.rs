//! iconv - convert text from one character encoding to another
//!
//! In WASM sandbox: passes through UTF-8 input unchanged; any non-UTF-8
//! to/from conversion is not available without ICU, so we accept UTF-8
//! input and emit UTF-8 output (identity for common use cases).

use std::env;
use std::fs::File;
use std::io::{self, Read, Write};
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut from_enc: Option<String> = None;
    let mut to_enc: Option<String> = None;
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-f" | "--from-code" => {
                i += 1;
                if i < args.len() {
                    from_enc = Some(args[i].clone());
                }
            }
            "-t" | "--to-code" => {
                i += 1;
                if i < args.len() {
                    to_enc = Some(args[i].clone());
                }
            }
            "-l" | "--list" => {
                println!("UTF-8");
                return;
            }
            "--help" => {
                println!("Usage: iconv [-f FROM] [-t TO] [FILE...]");
                return;
            }
            a if a.starts_with("--from-code=") => {
                from_enc = Some(a["--from-code=".len()..].to_string());
            }
            a if a.starts_with("--to-code=") => {
                to_enc = Some(a["--to-code=".len()..].to_string());
            }
            f => files.push(f.to_string()),
        }
        i += 1;
    }

    // Only UTF-8 passthrough is supported
    let is_utf8 = |e: &Option<String>| {
        e.as_deref()
            .map(|s| s.to_ascii_uppercase().replace('-', "") == "UTF8")
            .unwrap_or(true)
    };

    if !is_utf8(&from_enc) || !is_utf8(&to_enc) {
        eprintln!(
            "iconv: conversion from '{}' to '{}' is not supported",
            from_enc.as_deref().unwrap_or("UTF-8"),
            to_enc.as_deref().unwrap_or("UTF-8")
        );
        process::exit(1);
    }

    let copy = |reader: &mut dyn Read, name: &str| -> io::Result<()> {
        let stdout = io::stdout();
        let mut out = stdout.lock();
        let mut buf = [0u8; 65536];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n])?;
        }
        let _ = name;
        Ok(())
    };

    if files.is_empty() {
        if let Err(e) = copy(&mut io::stdin(), "<stdin>") {
            eprintln!("iconv: {}", e);
            process::exit(1);
        }
    } else {
        for path in &files {
            let result = File::open(path).and_then(|mut f| copy(&mut f, path));
            if let Err(e) = result {
                eprintln!("iconv: {}: {}", path, e);
                process::exit(1);
            }
        }
    }
}
