//! stat - display file status

use std::env;
use std::fs;
use std::process;

fn file_type(metadata: &fs::Metadata) -> &'static str {
    if metadata.is_dir() {
        "directory"
    } else if metadata.is_symlink() {
        "symbolic link"
    } else {
        "regular file"
    }
}

fn stat_default(path: &str) -> i32 {
    match fs::metadata(path) {
        Ok(meta) => {
            println!("  File: {}", path);
            println!("  Size: {:<10} Type: {}", meta.len(), file_type(&meta));
            0
        }
        Err(e) => {
            eprintln!("stat: cannot stat '{}': {}", path, e);
            1
        }
    }
}

fn stat_format(path: &str, format: &str) -> i32 {
    match fs::metadata(path) {
        Ok(meta) => {
            let mut output = String::new();
            let chars: Vec<char> = format.chars().collect();
            let mut i = 0;
            // Synthetic permissions: 755 for dirs, 644 for files
            let mode: u32 = if meta.is_dir() { 0o40755 } else { 0o100644 };
            let perm_bits: u32 = mode & 0o7777;
            while i < chars.len() {
                if chars[i] == '%' && i + 1 < chars.len() {
                    match chars[i + 1] {
                        'n' => output.push_str(path),
                        's' => output.push_str(&meta.len().to_string()),
                        'F' => output.push_str(file_type(&meta)),
                        'a' => output.push_str(&format!("{:o}", perm_bits)),
                        'A' => output.push_str(&format_permissions(mode)),
                        'f' => output.push_str(&format!("{:x}", mode)),
                        'i' => output.push('0'), // inode not available in WASM VFS
                        'h' => output.push('1'), // hard link count
                        'd' => output.push('0'), // device number
                        'U' => output.push_str("root"),
                        'G' => output.push_str("root"),
                        'u' => output.push('0'), // uid
                        'g' => output.push('0'), // gid
                        'X' => output.push('0'), // atime epoch
                        'Y' => output.push('0'), // mtime epoch
                        'Z' => output.push('0'), // ctime epoch
                        'W' => output.push('0'), // birth epoch
                        other => {
                            output.push('%');
                            output.push(other);
                        }
                    }
                    i += 2;
                } else if chars[i] == '\\' && i + 1 < chars.len() {
                    match chars[i + 1] {
                        'n' => output.push('\n'),
                        't' => output.push('\t'),
                        '\\' => output.push('\\'),
                        other => {
                            output.push('\\');
                            output.push(other);
                        }
                    }
                    i += 2;
                } else {
                    output.push(chars[i]);
                    i += 1;
                }
            }
            println!("{}", output);
            0
        }
        Err(e) => {
            eprintln!("stat: cannot stat '{}': {}", path, e);
            1
        }
    }
}

/// Format permission bits as ls-style string (e.g. -rw-r--r--)
fn format_permissions(mode: u32) -> String {
    let file_type_ch = match mode & 0o170000 {
        0o040000 => 'd',
        0o120000 => 'l',
        _ => '-',
    };
    let perms = mode & 0o777;
    let mut s = String::with_capacity(10);
    s.push(file_type_ch);
    for shift in [6, 3, 0] {
        let bits = (perms >> shift) & 7;
        s.push(if bits & 4 != 0 { 'r' } else { '-' });
        s.push(if bits & 2 != 0 { 'w' } else { '-' });
        s.push(if bits & 1 != 0 { 'x' } else { '-' });
    }
    s
}

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--help") {
        println!("Usage: stat [-c FORMAT] FILE...");
        println!("Display file status.");
        println!("  -c FORMAT  use the specified FORMAT instead of the default");
        println!("  Format sequences: %n name, %s size, %F type");
        return;
    }

    let mut format: Option<String> = None;
    let mut files: Vec<String> = Vec::new();
    let mut i = 1;
    while i < args.len() {
        if args[i] == "-c" && i + 1 < args.len() {
            format = Some(args[i + 1].clone());
            i += 2;
        } else if args[i].starts_with('-') && args[i] != "-" {
            eprintln!("stat: unrecognized option '{}'", args[i]);
            process::exit(1);
        } else {
            files.push(args[i].clone());
            i += 1;
        }
    }

    if files.is_empty() {
        eprintln!("stat: missing operand");
        process::exit(1);
    }

    let mut exit_code = 0;
    for file in &files {
        let code = match &format {
            Some(fmt) => stat_format(file, fmt),
            None => stat_default(file),
        };
        if code != 0 {
            exit_code = code;
        }
    }

    process::exit(exit_code);
}
