//! df - report file system disk space usage

use std::fs;

fn extract_u64(json: &str, key: &str) -> u64 {
    let pattern = format!("\"{}\":", key);
    if let Some(pos) = json.find(&pattern) {
        let rest = &json[pos + pattern.len()..];
        let rest = rest.trim_start();
        let end = rest
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(rest.len());
        rest[..end].parse().unwrap_or(0)
    } else {
        0
    }
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1_073_741_824 {
        format!("{:.1}G", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1}M", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1}K", bytes as f64 / 1024.0)
    } else {
        format!("{}B", bytes)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let human = args.iter().any(|a| a == "-h" || a == "--human-readable");

    let json = match fs::read_to_string("/proc/diskstats") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("df: cannot read /proc/diskstats: {}", e);
            std::process::exit(1);
        }
    };

    let total_bytes = extract_u64(&json, "totalBytes");
    let limit_bytes = extract_u64(&json, "limitBytes");
    let file_count = extract_u64(&json, "fileCount");
    let file_count_limit = extract_u64(&json, "fileCountLimit");

    let (size_str, used_str, avail_str, pct_str) = if limit_bytes == 0 {
        (
            "-".to_string(),
            format_val(total_bytes, human),
            "-".to_string(),
            "-".to_string(),
        )
    } else {
        let available = limit_bytes.saturating_sub(total_bytes);
        let pct = if limit_bytes > 0 {
            (total_bytes as f64 / limit_bytes as f64 * 100.0).round() as u64
        } else {
            0
        };
        (
            format_val(limit_bytes, human),
            format_val(total_bytes, human),
            format_val(available, human),
            format!("{}%", pct),
        )
    };

    let file_limit_str = if file_count_limit == 0 {
        "-".to_string()
    } else {
        file_count_limit.to_string()
    };

    if human {
        println!(
            "{:<15}{:>10}{:>10}{:>10}{:>5}{:>9}{:>10}",
            "Filesystem", "Size", "Used", "Avail", "Use%", "Files", "FileLimit"
        );
        println!(
            "{:<15}{:>10}{:>10}{:>10}{:>5}{:>9}{:>10}",
            "codepod", size_str, used_str, avail_str, pct_str, file_count, file_limit_str
        );
    } else {
        println!(
            "{:<15}{:>12}{:>12}{:>12}{:>5}{:>9}{:>10}",
            "Filesystem", "1B-blocks", "Used", "Available", "Use%", "Files", "FileLimit"
        );
        println!(
            "{:<15}{:>12}{:>12}{:>12}{:>5}{:>9}{:>10}",
            "codepod", size_str, used_str, avail_str, pct_str, file_count, file_limit_str
        );
    }
}

fn format_val(bytes: u64, human: bool) -> String {
    if human {
        human_size(bytes)
    } else {
        bytes.to_string()
    }
}
