use std::env;
use std::fs;
use std::path::Path;
use std::process;

struct Options {
    long: bool,
    all: bool,
    one_per_line: bool,
    recursive: bool,
}

fn parse_args() -> (Options, Vec<String>) {
    let mut opts = Options {
        long: false,
        all: false,
        one_per_line: false,
        recursive: false,
    };
    let mut paths = Vec::new();

    for arg in env::args().skip(1) {
        if arg == "--" {
            break;
        }
        if arg.starts_with('-') && arg.len() > 1 {
            for ch in arg[1..].chars() {
                match ch {
                    'l' => opts.long = true,
                    'a' => opts.all = true,
                    '1' => opts.one_per_line = true,
                    'R' => opts.recursive = true,
                    _ => {
                        eprintln!("ls: invalid option -- '{}'", ch);
                        process::exit(2);
                    }
                }
            }
        } else {
            paths.push(arg);
        }
    }

    if paths.is_empty() {
        paths.push(".".to_string());
    }

    (opts, paths)
}

fn format_size(size: u64) -> String {
    format!("{:>8}", size)
}

fn format_time(modified: std::io::Result<std::time::SystemTime>) -> String {
    match modified {
        Ok(time) => {
            match time.duration_since(std::time::UNIX_EPOCH) {
                Ok(dur) => {
                    let secs = dur.as_secs();
                    // Simple date formatting: compute year, month, day, hour, minute
                    let days = secs / 86400;
                    let time_of_day = secs % 86400;
                    let hour = time_of_day / 3600;
                    let minute = (time_of_day % 3600) / 60;

                    // Days since epoch to date (simplified)
                    let mut y = 1970i64;
                    let mut remaining = days as i64;
                    loop {
                        let days_in_year = if is_leap(y) { 366 } else { 365 };
                        if remaining < days_in_year {
                            break;
                        }
                        remaining -= days_in_year;
                        y += 1;
                    }
                    let month_days: [i64; 12] = if is_leap(y) {
                        [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
                    } else {
                        [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
                    };
                    let mut m = 0usize;
                    for (i, &md) in month_days.iter().enumerate() {
                        if remaining < md {
                            m = i;
                            break;
                        }
                        remaining -= md;
                    }
                    let day = remaining + 1;
                    let months = [
                        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
                        "Nov", "Dec",
                    ];
                    format!("{} {:>2} {:02}:{:02}", months[m], day, hour, minute)
                }
                Err(_) => "            ".to_string(),
            }
        }
        Err(_) => "            ".to_string(),
    }
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn file_type_char(metadata: &fs::Metadata) -> char {
    if metadata.is_dir() {
        'd'
    } else if metadata.is_symlink() {
        'l'
    } else {
        '-'
    }
}

/// Read permissions from the WASI filestat dev field for a given path.
/// Our WASI host encodes Unix permissions in the dev field.
fn permissions_str_for_path(path: &Path, metadata: &fs::Metadata) -> String {
    let ft = file_type_char(metadata);
    let mode = read_wasi_permissions(path, metadata);
    let perms = format_permissions(mode);
    format!("{}{}", ft, perms)
}

fn read_wasi_permissions(path: &Path, metadata: &fs::Metadata) -> u32 {
    // Try to read WASI filestat which has permissions in the dev field.
    // The dev field is the first u64 in the filestat structure.
    #[cfg(target_os = "wasi")]
    {
        if let Ok(path_str) = std::ffi::CString::new(path.to_string_lossy().as_bytes()) {
            // Use path_filestat_get via raw WASI call
            let mut buf = [0u8; 64];
            let ret = unsafe {
                // fd=3 is the preopened root dir, flags=1 for follow symlinks
                wasi_path_filestat_get(
                    3,
                    1,
                    path_str.as_ptr() as *const u8,
                    path_str.as_bytes().len(),
                    buf.as_mut_ptr(),
                )
            };
            if ret == 0 {
                // dev is the first u64 (little-endian)
                let dev = u64::from_le_bytes([
                    buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
                ]);
                if dev > 0 && dev <= 0o7777 {
                    return dev as u32;
                }
            }
        }
    }
    // Fallback: default permissions based on file type
    let _ = path; // suppress unused warning on non-wasi
    if metadata.is_dir() {
        0o755
    } else {
        0o644
    }
}

#[cfg(target_os = "wasi")]
#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    #[link_name = "path_filestat_get"]
    fn wasi_path_filestat_get(
        fd: i32,
        flags: i32,
        path: *const u8,
        path_len: usize,
        buf: *mut u8,
    ) -> i32;
}

fn format_permissions(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    let flags = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    for &(bit, ch) in &flags {
        s.push(if mode & bit != 0 { ch } else { '-' });
    }
    s
}

fn list_dir(path: &Path, opts: &Options, show_header: bool) -> i32 {
    let mut exit_code = 0;

    if show_header {
        println!("{}:", path.display());
    }

    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!("ls: cannot access '{}': {}", path.display(), e);
            return 1;
        }
    };

    let mut names: Vec<(String, fs::Metadata)> = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => {
                let name = entry.file_name().to_string_lossy().to_string();
                if !opts.all && name.starts_with('.') {
                    continue;
                }
                let metadata = entry.metadata().unwrap_or_else(|_| {
                    // Fallback to symlink metadata
                    fs::symlink_metadata(entry.path()).unwrap()
                });
                names.push((name, metadata));
            }
            Err(e) => {
                eprintln!("ls: error reading entry: {}", e);
                exit_code = 1;
            }
        }
    }

    names.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    if opts.long {
        for (name, metadata) in &names {
            let entry_path = path.join(name);
            let perms = permissions_str_for_path(&entry_path, metadata);
            let size = format_size(metadata.len());
            let time = format_time(metadata.modified());
            println!("{} {} {} {}", perms, size, time, name);
        }
    } else if opts.one_per_line {
        for (name, _) in &names {
            println!("{}", name);
        }
    } else {
        // Simple space-separated output
        let name_list: Vec<&str> = names.iter().map(|(n, _)| n.as_str()).collect();
        if !name_list.is_empty() {
            println!("{}", name_list.join("  "));
        }
    }

    if opts.recursive {
        for (name, metadata) in &names {
            if metadata.is_dir() && name != "." && name != ".." {
                println!();
                let sub = path.join(name);
                let code = list_dir(&sub, opts, true);
                if code != 0 {
                    exit_code = code;
                }
            }
        }
    }

    exit_code
}

fn main() {
    let (opts, paths) = parse_args();
    let mut exit_code = 0;
    let show_header = paths.len() > 1 || opts.recursive;

    for (i, p) in paths.iter().enumerate() {
        let path = Path::new(p);

        if !path.exists() {
            eprintln!("ls: cannot access '{}': No such file or directory", p);
            exit_code = 1;
            continue;
        }

        if path.is_file() {
            if opts.long {
                let metadata = fs::metadata(path).unwrap();
                let perms = permissions_str_for_path(path, &metadata);
                let size = format_size(metadata.len());
                let time = format_time(metadata.modified());
                println!("{} {} {} {}", perms, size, time, p);
            } else {
                println!("{}", p);
            }
            continue;
        }

        if i > 0 {
            println!();
        }
        let code = list_dir(path, &opts, show_header);
        if code != 0 {
            exit_code = code;
        }
    }

    process::exit(exit_code);
}
