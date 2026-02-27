//! grep - search for patterns in files (using regex crate)

use regex::RegexBuilder;
use std::env;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader};
use std::path::Path;
use std::process;

struct Options {
    ignore_case: bool,
    invert: bool,
    count_only: bool,
    line_numbers: bool,
    files_with_matches: bool,
    recursive: bool,
    extended: bool,
    only_matching: bool,
    word_match: bool,
    quiet: bool,
    fixed_string: bool,
    suppress_errors: bool,
    after_context: usize,
    before_context: usize,
    max_count: usize,
    no_filename: bool,
    with_filename: bool,
    include_globs: Vec<String>,
    exclude_globs: Vec<String>,
}

// ---------------------------------------------------------------------------
// BRE to ERE translation
// ---------------------------------------------------------------------------

/// Convert a BRE (Basic Regular Expression) pattern to ERE syntax for the regex crate.
fn bre_to_ere(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            match chars[i + 1] {
                // BRE escaped specials → ERE unescaped
                '(' | ')' | '+' | '?' | '{' | '}' | '|' => {
                    result.push(chars[i + 1]);
                    i += 2;
                }
                _ => {
                    result.push('\\');
                    result.push(chars[i + 1]);
                    i += 2;
                }
            }
        } else {
            match chars[i] {
                // Literal in BRE, special in ERE → escape them
                '(' | ')' | '+' | '?' | '{' | '}' | '|' => {
                    result.push('\\');
                    result.push(chars[i]);
                    i += 1;
                }
                _ => {
                    result.push(chars[i]);
                    i += 1;
                }
            }
        }
    }
    result
}

// ---------------------------------------------------------------------------
// grep logic
// ---------------------------------------------------------------------------

fn grep_reader<R: io::Read>(
    reader: R,
    re: &regex::Regex,
    opts: &Options,
    filename: &str,
    show_filename: bool,
) -> io::Result<bool> {
    let buf = BufReader::new(reader);
    let mut match_count: usize = 0;
    let mut line_match_count: usize = 0;
    let mut found = false;
    let has_context = opts.before_context > 0 || opts.after_context > 0;

    // For -B context: ring buffer of previous lines
    let mut before_buf: Vec<(usize, String)> = Vec::new();
    // Track how many after-context lines remain to print
    let mut after_remaining: usize = 0;
    // Track last printed line number to insert "--" separators
    let mut last_printed_line: Option<usize> = None;

    let lines: Vec<String> = buf.lines().collect::<io::Result<Vec<_>>>()?;

    for (i, line) in lines.iter().enumerate() {
        let is_match = re.is_match(line);
        let selected = if opts.invert { !is_match } else { is_match };

        if selected {
            found = true;
            line_match_count += 1;

            if opts.quiet {
                return Ok(true);
            }

            if opts.files_with_matches {
                println!("{}", filename);
                return Ok(true);
            }

            // -o with -v is undefined; ignore -o in that case
            if opts.only_matching && !opts.invert {
                for m in re.find_iter(line) {
                    if opts.count_only {
                        match_count += 1;
                        continue;
                    }
                    let mut prefix = String::new();
                    if show_filename {
                        prefix.push_str(filename);
                        prefix.push(':');
                    }
                    if opts.line_numbers {
                        prefix.push_str(&format!("{}:", i + 1));
                    }
                    println!("{}{}", prefix, m.as_str());
                }
                if opts.max_count > 0 && line_match_count >= opts.max_count {
                    break;
                }
                continue;
            }

            if opts.count_only {
                match_count += 1;
                if opts.max_count > 0 && line_match_count >= opts.max_count {
                    break;
                }
                continue;
            }

            // Print before-context lines
            if has_context {
                for (bi, bline) in &before_buf {
                    // Add group separator if there's a gap
                    if let Some(lp) = last_printed_line {
                        if *bi > lp + 1 {
                            println!("--");
                        }
                    }
                    let mut prefix = String::new();
                    if show_filename {
                        prefix.push_str(filename);
                        prefix.push('-');
                    }
                    if opts.line_numbers {
                        prefix.push_str(&format!("{}-", bi + 1));
                    }
                    println!("{}{}", prefix, bline);
                    last_printed_line = Some(*bi);
                }
                before_buf.clear();
            }

            // Add group separator if there's a gap
            if has_context {
                if let Some(lp) = last_printed_line {
                    if i > lp + 1 {
                        println!("--");
                    }
                }
            }

            let mut prefix = String::new();
            if show_filename {
                prefix.push_str(filename);
                prefix.push(':');
            }
            if opts.line_numbers {
                prefix.push_str(&format!("{}:", i + 1));
            }
            println!("{}{}", prefix, line);
            last_printed_line = Some(i);
            after_remaining = opts.after_context;
            if opts.max_count > 0 && line_match_count >= opts.max_count {
                // Still need to print after-context lines
                // But stop matching new lines
                for (j, aline) in lines.iter().enumerate().skip(i + 1) {
                    if after_remaining == 0 {
                        break;
                    }
                    let mut apfx = String::new();
                    if show_filename {
                        apfx.push_str(filename);
                        apfx.push('-');
                    }
                    if opts.line_numbers {
                        apfx.push_str(&format!("{}-", j + 1));
                    }
                    println!("{}{}", apfx, aline);
                    after_remaining -= 1;
                }
                break;
            }
        } else if after_remaining > 0 && !opts.count_only && !opts.quiet && !opts.files_with_matches
        {
            // Print after-context line
            let mut prefix = String::new();
            if show_filename {
                prefix.push_str(filename);
                prefix.push('-');
            }
            if opts.line_numbers {
                prefix.push_str(&format!("{}-", i + 1));
            }
            println!("{}{}", prefix, line);
            last_printed_line = Some(i);
            after_remaining -= 1;
        } else {
            // Buffer for before-context
            if opts.before_context > 0 {
                before_buf.push((i, line.clone()));
                if before_buf.len() > opts.before_context {
                    before_buf.remove(0);
                }
            }
            after_remaining = 0;
        }
    }

    if opts.count_only {
        if opts.quiet {
            return Ok(found);
        }
        if show_filename {
            println!("{}:{}", filename, match_count);
        } else {
            println!("{}", match_count);
        }
    }

    Ok(found)
}

/// Simple glob match supporting * and ? wildcards.
fn glob_matches(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    let (plen, nlen) = (p.len(), n.len());
    let mut dp = vec![vec![false; nlen + 1]; plen + 1];
    dp[0][0] = true;
    for i in 1..=plen {
        if p[i - 1] == '*' {
            dp[i][0] = dp[i - 1][0];
        }
    }
    for i in 1..=plen {
        for j in 1..=nlen {
            if p[i - 1] == '*' {
                dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
            } else if p[i - 1] == '?' || p[i - 1] == n[j - 1] {
                dp[i][j] = dp[i - 1][j - 1];
            }
        }
    }
    dp[plen][nlen]
}

fn grep_path(
    path: &Path,
    re: &regex::Regex,
    opts: &Options,
    show_filename: bool,
) -> io::Result<bool> {
    if path.is_dir() {
        if !opts.recursive {
            eprintln!("grep: {}: Is a directory", path.display());
            return Ok(false);
        }
        let mut found = false;
        let mut entries: Vec<_> = fs::read_dir(path)?.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let child = entry.path();
            match grep_path(&child, re, opts, true) {
                Ok(f) => {
                    if f {
                        found = true;
                    }
                }
                Err(e) => {
                    eprintln!("grep: {}: {}", child.display(), e);
                }
            }
        }
        Ok(found)
    } else {
        // Apply --include/--exclude filters on filename
        if let Some(fname) = path.file_name().and_then(|n| n.to_str()) {
            if !opts.include_globs.is_empty()
                && !opts.include_globs.iter().any(|g| glob_matches(g, fname))
            {
                return Ok(false);
            }
            if opts.exclude_globs.iter().any(|g| glob_matches(g, fname)) {
                return Ok(false);
            }
        }
        let f = match File::open(path) {
            Ok(f) => f,
            Err(e) => {
                if !opts.suppress_errors {
                    eprintln!("grep: {}: {}", path.display(), e);
                }
                return Err(e);
            }
        };
        grep_reader(f, re, opts, &path.display().to_string(), show_filename)
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut opts = Options {
        ignore_case: false,
        invert: false,
        count_only: false,
        line_numbers: false,
        files_with_matches: false,
        recursive: false,
        extended: false,
        only_matching: false,
        word_match: false,
        quiet: false,
        fixed_string: false,
        suppress_errors: false,
        after_context: 0,
        before_context: 0,
        max_count: 0,
        no_filename: false,
        with_filename: false,
        include_globs: Vec::new(),
        exclude_globs: Vec::new(),
    };
    let mut positional: Vec<String> = Vec::new();
    let mut past_flags = false;

    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if past_flags {
            positional.push(arg.clone());
            i += 1;
            continue;
        }
        if arg == "--" {
            past_flags = true;
            i += 1;
            continue;
        }
        // Long options and options with values
        if let Some(val) = arg.strip_prefix("--include=") {
            opts.include_globs.push(val.to_string());
            i += 1;
            continue;
        }
        if arg == "--include" {
            i += 1;
            if i < args.len() {
                opts.include_globs.push(args[i].clone());
            }
            i += 1;
            continue;
        }
        if let Some(val) = arg.strip_prefix("--exclude=") {
            opts.exclude_globs.push(val.to_string());
            i += 1;
            continue;
        }
        if arg == "--exclude" {
            i += 1;
            if i < args.len() {
                opts.exclude_globs.push(args[i].clone());
            }
            i += 1;
            continue;
        }
        if arg == "-A" || arg == "--after-context" {
            i += 1;
            if i < args.len() {
                opts.after_context = args[i].parse().unwrap_or(0);
            }
            i += 1;
            continue;
        }
        if arg == "-B" || arg == "--before-context" {
            i += 1;
            if i < args.len() {
                opts.before_context = args[i].parse().unwrap_or(0);
            }
            i += 1;
            continue;
        }
        if arg == "-C" || arg == "--context" {
            i += 1;
            if i < args.len() {
                let n = args[i].parse().unwrap_or(0);
                opts.before_context = n;
                opts.after_context = n;
            }
            i += 1;
            continue;
        }
        if arg == "-m" || arg == "--max-count" {
            i += 1;
            if i < args.len() {
                opts.max_count = args[i].parse().unwrap_or(0);
            }
            i += 1;
            continue;
        }
        if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
            let chars: Vec<char> = arg[1..].chars().collect();
            let mut ci = 0;
            while ci < chars.len() {
                match chars[ci] {
                    'i' => opts.ignore_case = true,
                    'v' => opts.invert = true,
                    'c' => opts.count_only = true,
                    'n' => opts.line_numbers = true,
                    'l' => opts.files_with_matches = true,
                    'r' | 'R' => opts.recursive = true,
                    'E' => opts.extended = true,
                    'o' => opts.only_matching = true,
                    'w' => opts.word_match = true,
                    'q' => opts.quiet = true,
                    'F' => opts.fixed_string = true,
                    's' => opts.suppress_errors = true,
                    'h' => opts.no_filename = true,
                    'H' => opts.with_filename = true,
                    'A' | 'B' | 'C' | 'm' => {
                        // Value may be remainder of this arg or the next arg
                        let val_str = if ci + 1 < chars.len() {
                            chars[ci + 1..].iter().collect::<String>()
                        } else {
                            i += 1;
                            if i < args.len() {
                                args[i].clone()
                            } else {
                                "0".to_string()
                            }
                        };
                        let val: usize = val_str.parse().unwrap_or(0);
                        match chars[ci] {
                            'A' => opts.after_context = val,
                            'B' => opts.before_context = val,
                            'C' => {
                                opts.before_context = val;
                                opts.after_context = val;
                            }
                            'm' => opts.max_count = val,
                            _ => unreachable!(),
                        }
                        break; // consumed rest of this arg
                    }
                    _ => {
                        eprintln!("grep: invalid option -- '{}'", chars[ci]);
                        process::exit(2);
                    }
                }
                ci += 1;
            }
        } else {
            positional.push(arg.clone());
        }
        i += 1;
    }

    if positional.is_empty() {
        eprintln!("grep: missing pattern");
        eprintln!("Usage: grep [OPTION]... PATTERN [FILE]...");
        process::exit(2);
    }

    let pattern = &positional[0];
    let mut pattern_str = if opts.fixed_string {
        regex::escape(pattern)
    } else if opts.extended {
        pattern.clone()
    } else {
        bre_to_ere(pattern)
    };
    if opts.word_match {
        pattern_str = format!(r"\b{}\b", pattern_str);
    }
    let re = RegexBuilder::new(&pattern_str)
        .case_insensitive(opts.ignore_case)
        .build()
        .unwrap_or_else(|e| {
            eprintln!("grep: Invalid regular expression: {}", e);
            process::exit(2);
        });
    let files = &positional[1..];

    let mut found_any = false;
    let mut had_error = false;

    if files.is_empty() {
        let stdin = io::stdin();
        match grep_reader(stdin.lock(), &re, &opts, "(standard input)", false) {
            Ok(found) => {
                if found {
                    found_any = true;
                }
            }
            Err(e) => {
                eprintln!("grep: (standard input): {}", e);
                had_error = true;
            }
        }
    } else {
        let show_filename = if opts.no_filename {
            false
        } else if opts.with_filename {
            true
        } else {
            files.len() > 1 || opts.recursive
        };
        for file in files {
            let path = Path::new(file);
            match grep_path(path, &re, &opts, show_filename) {
                Ok(found) => {
                    if found {
                        found_any = true;
                    }
                }
                Err(e) => {
                    if !opts.suppress_errors {
                        eprintln!("grep: {}: {}", file, e);
                    }
                    had_error = true;
                }
            }
        }
    }

    if found_any {
        process::exit(0);
    } else if had_error && !opts.suppress_errors {
        process::exit(2);
    } else {
        process::exit(1);
    }
}
