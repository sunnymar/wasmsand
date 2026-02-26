//! rg - ripgrep-like recursive code search

use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read};
use std::path::Path;
use std::process;

use regex::{Regex, RegexBuilder};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

struct Options {
    pattern: String,
    paths: Vec<String>,
    ignore_case: bool,
    case_sensitive: bool,
    smart_case: bool,
    fixed_strings: bool,
    word_regexp: bool,
    invert_match: bool,
    line_number: bool,
    no_line_number: bool,
    count: bool,
    files_with_matches: bool,
    after_context: usize,
    before_context: usize,
    context: usize,
    file_types: Vec<String>,
    file_types_not: Vec<String>,
    globs: Vec<String>,
    hidden: bool,
    no_ignore: bool,
    max_count: Option<usize>,
    max_depth: Option<usize>,
    type_list: bool,
}

// ---------------------------------------------------------------------------
// File type map
// ---------------------------------------------------------------------------

fn build_type_map() -> HashMap<&'static str, &'static [&'static str]> {
    let mut m: HashMap<&str, &[&str]> = HashMap::new();
    m.insert("c", &["*.c", "*.h"]);
    m.insert(
        "cpp",
        &["*.cpp", "*.cc", "*.cxx", "*.hpp", "*.hh", "*.hxx", "*.h"],
    );
    m.insert("css", &["*.css", "*.scss", "*.less"]);
    m.insert("go", &["*.go"]);
    m.insert("html", &["*.html", "*.htm"]);
    m.insert("java", &["*.java"]);
    m.insert("js", &["*.js", "*.mjs", "*.cjs"]);
    m.insert("json", &["*.json"]);
    m.insert("kt", &["*.kt", "*.kts"]);
    m.insert("md", &["*.md", "*.markdown"]);
    m.insert("php", &["*.php"]);
    m.insert("py", &["*.py", "*.pyi"]);
    m.insert("rb", &["*.rb"]);
    m.insert("rs", &["*.rs"]);
    m.insert("sh", &["*.sh", "*.bash", "*.zsh"]);
    m.insert("sql", &["*.sql"]);
    m.insert("swift", &["*.swift"]);
    m.insert("toml", &["*.toml"]);
    m.insert("ts", &["*.ts", "*.tsx", "*.mts", "*.cts"]);
    m.insert("xml", &["*.xml"]);
    m.insert("yaml", &["*.yml", "*.yaml"]);
    m
}

fn print_type_list(type_map: &HashMap<&str, &[&str]>) {
    let mut types: Vec<&&str> = type_map.keys().collect();
    types.sort();
    for t in types {
        let exts: Vec<&str> = type_map[*t].to_vec();
        println!("{}: {}", t, exts.join(", "));
    }
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

fn print_usage() {
    eprintln!("Usage: rg [OPTIONS] PATTERN [PATH ...]");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  -i, --ignore-case       Case insensitive search");
    eprintln!("  -s, --case-sensitive    Case sensitive search");
    eprintln!("  -S, --smart-case        Smart case (default)");
    eprintln!("  -F, --fixed-strings     Treat pattern as literal string");
    eprintln!("  -w, --word-regexp       Match whole words only");
    eprintln!("  -v, --invert-match      Invert match");
    eprintln!("  -n, --line-number       Show line numbers (default)");
    eprintln!("  -N, --no-line-number    Suppress line numbers");
    eprintln!("  -l, --files-with-matches  Print only filenames");
    eprintln!("  -c, --count             Print match count per file");
    eprintln!("  -t TYPE, --type TYPE    Filter by file type");
    eprintln!("  -T TYPE, --type-not TYPE  Exclude file type");
    eprintln!("  -g GLOB, --glob GLOB    Filter by glob pattern");
    eprintln!("  -A N, --after-context N   Show N lines after match");
    eprintln!("  -B N, --before-context N  Show N lines before match");
    eprintln!("  -C N, --context N       Show N lines before and after");
    eprintln!("  --hidden                Include hidden files");
    eprintln!("  --no-ignore             Don't respect gitignore");
    eprintln!("  --max-count N           Stop after N matches per file");
    eprintln!("  --max-depth N           Limit directory recursion depth");
    eprintln!("  --type-list             List known file types");
    eprintln!("  --help                  Show this help");
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

fn parse_args(args: &[String]) -> Options {
    let mut opts = Options {
        pattern: String::new(),
        paths: Vec::new(),
        ignore_case: false,
        case_sensitive: false,
        smart_case: true,
        fixed_strings: false,
        word_regexp: false,
        invert_match: false,
        line_number: true,
        no_line_number: false,
        count: false,
        files_with_matches: false,
        after_context: 0,
        before_context: 0,
        context: 0,
        file_types: Vec::new(),
        file_types_not: Vec::new(),
        globs: Vec::new(),
        hidden: false,
        no_ignore: false,
        max_count: None,
        max_depth: None,
        type_list: false,
    };

    let mut positional: Vec<String> = Vec::new();
    let mut past_flags = false;
    let mut i = 0;

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

        if arg == "--help" {
            print_usage();
            process::exit(0);
        }

        // Long flags
        if arg.starts_with("--") {
            if arg == "--ignore-case" {
                opts.ignore_case = true;
                opts.case_sensitive = false;
                opts.smart_case = false;
            } else if arg == "--case-sensitive" {
                opts.case_sensitive = true;
                opts.ignore_case = false;
                opts.smart_case = false;
            } else if arg == "--smart-case" {
                opts.smart_case = true;
                opts.ignore_case = false;
                opts.case_sensitive = false;
            } else if arg == "--fixed-strings" {
                opts.fixed_strings = true;
            } else if arg == "--word-regexp" {
                opts.word_regexp = true;
            } else if arg == "--invert-match" {
                opts.invert_match = true;
            } else if arg == "--line-number" {
                opts.line_number = true;
                opts.no_line_number = false;
            } else if arg == "--no-line-number" {
                opts.no_line_number = true;
                opts.line_number = false;
            } else if arg == "--count" {
                opts.count = true;
            } else if arg == "--files-with-matches" {
                opts.files_with_matches = true;
            } else if arg == "--hidden" {
                opts.hidden = true;
            } else if arg == "--no-ignore" {
                opts.no_ignore = true;
            } else if arg == "--type-list" {
                opts.type_list = true;
            } else if let Some(val) = arg.strip_prefix("--max-count=") {
                opts.max_count = Some(val.parse().unwrap_or_else(|_| {
                    eprintln!("rg: invalid number for --max-count: {}", val);
                    process::exit(2);
                }));
            } else if arg == "--max-count" {
                i += 1;
                if i >= args.len() {
                    eprintln!("rg: --max-count requires a value");
                    process::exit(2);
                }
                opts.max_count = Some(args[i].parse().unwrap_or_else(|_| {
                    eprintln!("rg: invalid number for --max-count: {}", args[i]);
                    process::exit(2);
                }));
            } else if let Some(val) = arg.strip_prefix("--max-depth=") {
                opts.max_depth = Some(val.parse().unwrap_or_else(|_| {
                    eprintln!("rg: invalid number for --max-depth: {}", val);
                    process::exit(2);
                }));
            } else if arg == "--max-depth" {
                i += 1;
                if i >= args.len() {
                    eprintln!("rg: --max-depth requires a value");
                    process::exit(2);
                }
                opts.max_depth = Some(args[i].parse().unwrap_or_else(|_| {
                    eprintln!("rg: invalid number for --max-depth: {}", args[i]);
                    process::exit(2);
                }));
            } else if let Some(val) = arg.strip_prefix("--after-context=") {
                opts.after_context = val.parse().unwrap_or(0);
            } else if arg == "--after-context" {
                i += 1;
                if i < args.len() {
                    opts.after_context = args[i].parse().unwrap_or(0);
                }
            } else if let Some(val) = arg.strip_prefix("--before-context=") {
                opts.before_context = val.parse().unwrap_or(0);
            } else if arg == "--before-context" {
                i += 1;
                if i < args.len() {
                    opts.before_context = args[i].parse().unwrap_or(0);
                }
            } else if let Some(val) = arg.strip_prefix("--context=") {
                opts.context = val.parse().unwrap_or(0);
            } else if arg == "--context" {
                i += 1;
                if i < args.len() {
                    opts.context = args[i].parse().unwrap_or(0);
                }
            } else if let Some(val) = arg.strip_prefix("--type=") {
                opts.file_types.push(val.to_string());
            } else if arg == "--type" {
                i += 1;
                if i < args.len() {
                    opts.file_types.push(args[i].clone());
                }
            } else if let Some(val) = arg.strip_prefix("--type-not=") {
                opts.file_types_not.push(val.to_string());
            } else if arg == "--type-not" {
                i += 1;
                if i < args.len() {
                    opts.file_types_not.push(args[i].clone());
                }
            } else if let Some(val) = arg.strip_prefix("--glob=") {
                opts.globs.push(val.to_string());
            } else if arg == "--glob" {
                i += 1;
                if i < args.len() {
                    opts.globs.push(args[i].clone());
                }
            } else {
                eprintln!("rg: unrecognized option '{}'", arg);
                process::exit(2);
            }
            i += 1;
            continue;
        }

        // Short flags
        if arg.starts_with('-') && arg.len() > 1 {
            let chars: Vec<char> = arg[1..].chars().collect();
            let mut j = 0;
            while j < chars.len() {
                match chars[j] {
                    'i' => {
                        opts.ignore_case = true;
                        opts.case_sensitive = false;
                        opts.smart_case = false;
                    }
                    's' => {
                        opts.case_sensitive = true;
                        opts.ignore_case = false;
                        opts.smart_case = false;
                    }
                    'S' => {
                        opts.smart_case = true;
                        opts.ignore_case = false;
                        opts.case_sensitive = false;
                    }
                    'F' => opts.fixed_strings = true,
                    'w' => opts.word_regexp = true,
                    'v' => opts.invert_match = true,
                    'n' => {
                        opts.line_number = true;
                        opts.no_line_number = false;
                    }
                    'N' => {
                        opts.no_line_number = true;
                        opts.line_number = false;
                    }
                    'l' => opts.files_with_matches = true,
                    'c' => opts.count = true,
                    't' => {
                        // Value is remainder of this arg or next arg
                        let rest: String = chars[j + 1..].iter().collect();
                        if !rest.is_empty() {
                            opts.file_types.push(rest);
                        } else {
                            i += 1;
                            if i < args.len() {
                                opts.file_types.push(args[i].clone());
                            }
                        }
                        j = chars.len(); // consumed rest
                        continue;
                    }
                    'T' => {
                        let rest: String = chars[j + 1..].iter().collect();
                        if !rest.is_empty() {
                            opts.file_types_not.push(rest);
                        } else {
                            i += 1;
                            if i < args.len() {
                                opts.file_types_not.push(args[i].clone());
                            }
                        }
                        j = chars.len();
                        continue;
                    }
                    'g' => {
                        let rest: String = chars[j + 1..].iter().collect();
                        if !rest.is_empty() {
                            opts.globs.push(rest);
                        } else {
                            i += 1;
                            if i < args.len() {
                                opts.globs.push(args[i].clone());
                            }
                        }
                        j = chars.len();
                        continue;
                    }
                    'A' => {
                        let rest: String = chars[j + 1..].iter().collect();
                        if !rest.is_empty() {
                            opts.after_context = rest.parse().unwrap_or(0);
                        } else {
                            i += 1;
                            if i < args.len() {
                                opts.after_context = args[i].parse().unwrap_or(0);
                            }
                        }
                        j = chars.len();
                        continue;
                    }
                    'B' => {
                        let rest: String = chars[j + 1..].iter().collect();
                        if !rest.is_empty() {
                            opts.before_context = rest.parse().unwrap_or(0);
                        } else {
                            i += 1;
                            if i < args.len() {
                                opts.before_context = args[i].parse().unwrap_or(0);
                            }
                        }
                        j = chars.len();
                        continue;
                    }
                    'C' => {
                        let rest: String = chars[j + 1..].iter().collect();
                        if !rest.is_empty() {
                            opts.context = rest.parse().unwrap_or(0);
                        } else {
                            i += 1;
                            if i < args.len() {
                                opts.context = args[i].parse().unwrap_or(0);
                            }
                        }
                        j = chars.len();
                        continue;
                    }
                    _ => {
                        eprintln!("rg: invalid option -- '{}'", chars[j]);
                        process::exit(2);
                    }
                }
                j += 1;
            }
            i += 1;
            continue;
        }

        // Positional argument
        positional.push(arg.clone());
        i += 1;
    }

    if !opts.type_list {
        if positional.is_empty() {
            eprintln!("rg: no pattern provided");
            print_usage();
            process::exit(2);
        }
        opts.pattern = positional.remove(0);
        opts.paths = positional;
    }

    // Context flag overrides A/B
    if opts.context > 0 {
        if opts.after_context == 0 {
            opts.after_context = opts.context;
        }
        if opts.before_context == 0 {
            opts.before_context = opts.context;
        }
    }

    opts
}

// ---------------------------------------------------------------------------
// Regex compilation
// ---------------------------------------------------------------------------

fn compile_pattern(opts: &Options) -> Regex {
    let mut pat = opts.pattern.clone();

    if opts.fixed_strings {
        pat = regex::escape(&pat);
    }

    if opts.word_regexp {
        pat = format!(r"\b{}\b", pat);
    }

    let case_insensitive = if opts.ignore_case {
        true
    } else if opts.case_sensitive {
        false
    } else {
        // Smart case: if pattern has any uppercase chars, case-sensitive
        !pat.chars().any(|c| c.is_uppercase())
    };

    RegexBuilder::new(&pat)
        .case_insensitive(case_insensitive)
        .build()
        .unwrap_or_else(|e| {
            eprintln!("rg: regex error: {}", e);
            process::exit(2);
        })
}

fn matches_line(line: &str, re: &Regex, invert: bool) -> bool {
    let m = re.is_match(line);
    if invert {
        !m
    } else {
        m
    }
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

fn is_binary(buf: &[u8]) -> bool {
    let check_len = buf.len().min(8192);
    buf[..check_len].contains(&0)
}

// ---------------------------------------------------------------------------
// Search result
// ---------------------------------------------------------------------------

struct SearchResult {
    match_count: usize,
}

// ---------------------------------------------------------------------------
// File search
// ---------------------------------------------------------------------------

fn search_reader<R: BufRead>(
    reader: R,
    re: &Regex,
    opts: &Options,
    filename: &str,
    show_path: bool,
) -> io::Result<SearchResult> {
    let lines: Vec<String> = reader.lines().collect::<io::Result<Vec<_>>>()?;
    let mut match_count: usize = 0;

    // For files-with-matches mode
    if opts.files_with_matches {
        for line in &lines {
            if matches_line(line, re, opts.invert_match) {
                println!("{}", filename);
                return Ok(SearchResult { match_count: 1 });
            }
        }
        return Ok(SearchResult { match_count: 0 });
    }

    // For count mode
    if opts.count {
        for line in &lines {
            if matches_line(line, re, opts.invert_match) {
                match_count += 1;
                if let Some(max) = opts.max_count {
                    if match_count >= max {
                        break;
                    }
                }
            }
        }
        if show_path {
            println!("{}:{}", filename, match_count);
        } else {
            println!("{}", match_count);
        }
        return Ok(SearchResult { match_count });
    }

    // Normal mode (with context support)
    let show_line_numbers = opts.line_number && !opts.no_line_number;
    let has_context = opts.before_context > 0 || opts.after_context > 0;
    let mut last_printed_line: Option<usize> = None;
    let mut printed_separator = false;

    for (idx, line) in lines.iter().enumerate() {
        if !matches_line(line, re, opts.invert_match) {
            continue;
        }

        match_count += 1;

        if has_context {
            // Before-context lines
            let ctx_start = idx.saturating_sub(opts.before_context);

            for (ctx_idx, ctx_line) in lines.iter().enumerate().take(idx).skip(ctx_start) {
                if let Some(last) = last_printed_line {
                    if ctx_idx <= last {
                        continue;
                    }
                    if ctx_idx > last + 1 && printed_separator {
                        println!("--");
                    }
                } else if printed_separator && ctx_idx > 0 {
                    println!("--");
                }

                print_context_line(
                    ctx_line,
                    ctx_idx + 1,
                    filename,
                    show_path,
                    show_line_numbers,
                );
                last_printed_line = Some(ctx_idx);
            }

            // Check if we need a separator before this match
            if let Some(last) = last_printed_line {
                if idx > last + 1 && printed_separator {
                    println!("--");
                }
            }
        }

        // Print the match line
        print_match_line(line, idx + 1, filename, show_path, show_line_numbers);
        last_printed_line = Some(idx);

        if has_context {
            // After-context lines
            let ctx_end = (idx + opts.after_context + 1).min(lines.len());
            for (ctx_idx, ctx_line) in lines.iter().enumerate().take(ctx_end).skip(idx + 1) {
                if let Some(last) = last_printed_line {
                    if ctx_idx <= last {
                        continue;
                    }
                }
                print_context_line(
                    ctx_line,
                    ctx_idx + 1,
                    filename,
                    show_path,
                    show_line_numbers,
                );
                last_printed_line = Some(ctx_idx);
            }
            printed_separator = true;
        }

        if let Some(max) = opts.max_count {
            if match_count >= max {
                break;
            }
        }
    }

    Ok(SearchResult { match_count })
}

fn print_match_line(
    line: &str,
    line_num: usize,
    filename: &str,
    show_path: bool,
    show_line_numbers: bool,
) {
    let mut prefix = String::new();
    if show_path {
        prefix.push_str(filename);
        prefix.push(':');
    }
    if show_line_numbers {
        prefix.push_str(&line_num.to_string());
        prefix.push(':');
    }
    println!("{}{}", prefix, line);
}

fn print_context_line(
    line: &str,
    line_num: usize,
    filename: &str,
    show_path: bool,
    show_line_numbers: bool,
) {
    let mut prefix = String::new();
    if show_path {
        prefix.push_str(filename);
        prefix.push('-');
    }
    if show_line_numbers {
        prefix.push_str(&line_num.to_string());
        prefix.push('-');
    }
    println!("{}{}", prefix, line);
}

fn search_file(
    path: &Path,
    re: &Regex,
    opts: &Options,
    show_path: bool,
) -> io::Result<SearchResult> {
    let mut f = File::open(path)?;

    // Binary detection: read first 8KB
    let mut header = vec![0u8; 8192];
    let n = f.read(&mut header)?;
    header.truncate(n);

    if is_binary(&header) {
        return Ok(SearchResult { match_count: 0 });
    }

    // Read the rest of the file
    let mut rest = Vec::new();
    f.read_to_end(&mut rest)?;

    let mut full = header;
    full.append(&mut rest);

    let content = String::from_utf8_lossy(&full);
    let cursor = io::Cursor::new(content.as_bytes());
    let reader = BufReader::new(cursor);

    search_reader(reader, re, opts, &path.display().to_string(), show_path)
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    glob_match_inner(&p, &t)
}

fn glob_match_inner(pattern: &[char], text: &[char]) -> bool {
    if pattern.is_empty() {
        return text.is_empty();
    }

    // Handle ** (matches any path segments)
    if pattern.len() >= 2 && pattern[0] == '*' && pattern[1] == '*' {
        // Skip the **
        let rest = if pattern.len() > 2 && pattern[2] == '/' {
            &pattern[3..]
        } else {
            &pattern[2..]
        };
        // Try matching rest against every suffix of text
        for i in 0..=text.len() {
            if glob_match_inner(rest, &text[i..]) {
                return true;
            }
        }
        return false;
    }

    match pattern[0] {
        '*' => {
            // * matches any sequence except /
            for i in 0..=text.len() {
                if i > 0 && text[i - 1] == '/' {
                    break;
                }
                if glob_match_inner(&pattern[1..], &text[i..]) {
                    return true;
                }
            }
            false
        }
        '?' => {
            if text.is_empty() || text[0] == '/' {
                false
            } else {
                glob_match_inner(&pattern[1..], &text[1..])
            }
        }
        '[' => {
            if text.is_empty() {
                return false;
            }
            if let Some(end) = pattern.iter().position(|&c| c == ']') {
                let class = &pattern[1..end];
                let ch = text[0];
                let mut matched = false;
                let mut ci = 0;
                while ci < class.len() {
                    if ci + 2 < class.len() && class[ci + 1] == '-' {
                        if ch >= class[ci] && ch <= class[ci + 2] {
                            matched = true;
                        }
                        ci += 3;
                    } else {
                        if ch == class[ci] {
                            matched = true;
                        }
                        ci += 1;
                    }
                }
                if matched {
                    glob_match_inner(&pattern[end + 1..], &text[1..])
                } else {
                    false
                }
            } else {
                // No closing ']'
                if !text.is_empty() && pattern[0] == text[0] {
                    glob_match_inner(&pattern[1..], &text[1..])
                } else {
                    false
                }
            }
        }
        _ => {
            if text.is_empty() || pattern[0] != text[0] {
                false
            } else {
                glob_match_inner(&pattern[1..], &text[1..])
            }
        }
    }
}

// ---------------------------------------------------------------------------
// File type filtering
// ---------------------------------------------------------------------------

fn matches_file_type(
    path: &Path,
    types: &[String],
    types_not: &[String],
    type_map: &HashMap<&str, &[&str]>,
) -> bool {
    let filename = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return false,
    };

    // Check exclusions first
    if !types_not.is_empty() {
        for t in types_not {
            if let Some(patterns) = type_map.get(t.as_str()) {
                for pat in *patterns {
                    if glob_match(pat, filename) {
                        return false;
                    }
                }
            }
        }
    }

    // Check inclusions
    if !types.is_empty() {
        for t in types {
            if let Some(patterns) = type_map.get(t.as_str()) {
                for pat in *patterns {
                    if glob_match(pat, filename) {
                        return true;
                    }
                }
            }
        }
        return false; // types specified but none matched
    }

    true
}

// ---------------------------------------------------------------------------
// Glob filtering (-g flag)
// ---------------------------------------------------------------------------

fn matches_glob_filters(path: &Path, globs: &[String]) -> bool {
    if globs.is_empty() {
        return true;
    }

    let filename = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n,
        None => return true,
    };
    let path_str = path.display().to_string();

    let mut positive_globs: Vec<&str> = Vec::new();
    let mut negative_globs: Vec<&str> = Vec::new();

    for g in globs {
        if let Some(neg) = g.strip_prefix('!') {
            negative_globs.push(neg);
        } else {
            positive_globs.push(g);
        }
    }

    // Check negative globs (exclusions)
    for neg in &negative_globs {
        if glob_match(neg, filename) || glob_match(neg, &path_str) {
            return false;
        }
    }

    // Check positive globs
    if positive_globs.is_empty() {
        return true;
    }

    for pos in &positive_globs {
        if glob_match(pos, filename) || glob_match(pos, &path_str) {
            return true;
        }
    }

    false
}

// ---------------------------------------------------------------------------
// Gitignore parsing
// ---------------------------------------------------------------------------

struct IgnoreRule {
    pattern: String,
    negation: bool,
    dir_only: bool,
    anchored: bool,
}

struct IgnoreRules {
    rules: Vec<IgnoreRule>,
}

impl IgnoreRules {
    fn new() -> Self {
        IgnoreRules { rules: Vec::new() }
    }

    fn load(dir: &Path) -> Self {
        let mut rules = IgnoreRules::new();
        // Load .gitignore
        let gitignore = dir.join(".gitignore");
        if let Ok(content) = fs::read_to_string(&gitignore) {
            rules.parse_file(&content);
        }
        // Load .ignore (ripgrep convention)
        let ignore = dir.join(".ignore");
        if let Ok(content) = fs::read_to_string(&ignore) {
            rules.parse_file(&content);
        }
        rules
    }

    fn parse_file(&mut self, content: &str) {
        for line in content.lines() {
            let line = line.trim_end();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }

            let mut pattern = line.to_string();
            let negation = pattern.starts_with('!');
            if negation {
                pattern = pattern[1..].to_string();
            }

            let dir_only = pattern.ends_with('/');
            if dir_only {
                pattern = pattern[..pattern.len() - 1].to_string();
            }

            let anchored = pattern.starts_with('/');
            if anchored {
                pattern = pattern[1..].to_string();
            }

            // A pattern containing / (other than trailing) is anchored
            let has_slash = pattern.contains('/');

            self.rules.push(IgnoreRule {
                pattern,
                negation,
                dir_only,
                anchored: anchored || has_slash,
            });
        }
    }

    fn is_ignored(&self, rel_path: &str, is_dir: bool) -> bool {
        let filename = rel_path.rsplit('/').next().unwrap_or(rel_path);
        let mut ignored = false;

        for rule in &self.rules {
            if rule.dir_only && !is_dir {
                continue;
            }

            let matched = if rule.anchored {
                glob_match(&rule.pattern, rel_path)
            } else {
                // Match against just the filename
                glob_match(&rule.pattern, filename) || glob_match(&rule.pattern, rel_path)
            };

            if matched {
                ignored = !rule.negation;
            }
        }

        ignored
    }

    fn merge(&self, other: &IgnoreRules) -> IgnoreRules {
        let mut merged = IgnoreRules::new();
        merged.rules.extend(self.rules.iter().map(|r| IgnoreRule {
            pattern: r.pattern.clone(),
            negation: r.negation,
            dir_only: r.dir_only,
            anchored: r.anchored,
        }));
        merged.rules.extend(other.rules.iter().map(|r| IgnoreRule {
            pattern: r.pattern.clone(),
            negation: r.negation,
            dir_only: r.dir_only,
            anchored: r.anchored,
        }));
        merged
    }
}

// ---------------------------------------------------------------------------
// Directory walking
// ---------------------------------------------------------------------------

fn walk_dir(
    path: &Path,
    re: &Regex,
    opts: &Options,
    type_map: &HashMap<&str, &[&str]>,
    ignore_rules: &IgnoreRules,
    depth: usize,
    total_matches: &mut usize,
) -> io::Result<()> {
    if let Some(max) = opts.max_depth {
        if depth > max {
            return Ok(());
        }
    }

    // Load ignore rules for this directory
    let local_rules = if opts.no_ignore {
        IgnoreRules::new()
    } else {
        IgnoreRules::load(path)
    };
    let merged_rules = if opts.no_ignore {
        IgnoreRules::new()
    } else {
        ignore_rules.merge(&local_rules)
    };

    let mut entries: Vec<_> = match fs::read_dir(path) {
        Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
        Err(e) => {
            eprintln!("rg: {}: {}", path.display(), e);
            return Ok(());
        }
    };
    entries.sort_by_key(|e| e.file_name());

    for entry in entries {
        let child = entry.path();
        let file_name = match child.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        // Skip hidden files/dirs unless --hidden
        if !opts.hidden && file_name.starts_with('.') {
            continue;
        }

        // Build relative path for ignore checking
        let rel_path = &file_name;
        let is_dir = child.is_dir();

        // Check ignore rules
        if !opts.no_ignore && merged_rules.is_ignored(rel_path, is_dir) {
            continue;
        }

        if is_dir {
            walk_dir(
                &child,
                re,
                opts,
                type_map,
                &merged_rules,
                depth + 1,
                total_matches,
            )?;
        } else {
            // Apply file type filter
            if !matches_file_type(&child, &opts.file_types, &opts.file_types_not, type_map) {
                continue;
            }

            // Apply glob filter
            if !matches_glob_filters(&child, &opts.globs) {
                continue;
            }

            match search_file(&child, re, opts, true) {
                Ok(result) => {
                    *total_matches += result.match_count;
                }
                Err(e) => {
                    eprintln!("rg: {}: {}", child.display(), e);
                }
            }
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        print_usage();
        process::exit(2);
    }

    let opts = parse_args(&args);

    // Handle --type-list
    if opts.type_list {
        let type_map = build_type_map();
        print_type_list(&type_map);
        process::exit(0);
    }

    // Compile regex
    let re = compile_pattern(&opts);
    let type_map = build_type_map();

    let mut total_matches: usize = 0;

    if opts.paths.is_empty() {
        // Default: search current directory recursively
        let path = Path::new(".");
        if path.is_dir() {
            let ignore_rules = if opts.no_ignore {
                IgnoreRules::new()
            } else {
                IgnoreRules::load(path)
            };
            if let Err(e) = walk_dir(
                path,
                &re,
                &opts,
                &type_map,
                &ignore_rules,
                0,
                &mut total_matches,
            ) {
                eprintln!("rg: {}", e);
                process::exit(2);
            }
        }
    } else {
        let show_path = opts.paths.len() > 1 || opts.paths.iter().any(|p| Path::new(p).is_dir());

        for p in &opts.paths {
            let path = Path::new(p);
            if path.is_dir() {
                let ignore_rules = if opts.no_ignore {
                    IgnoreRules::new()
                } else {
                    IgnoreRules::load(path)
                };
                if let Err(e) = walk_dir(
                    path,
                    &re,
                    &opts,
                    &type_map,
                    &ignore_rules,
                    0,
                    &mut total_matches,
                ) {
                    eprintln!("rg: {}", e);
                }
            } else if path.is_file() {
                match search_file(path, &re, &opts, show_path) {
                    Ok(result) => {
                        total_matches += result.match_count;
                    }
                    Err(e) => {
                        eprintln!("rg: {}: {}", p, e);
                        process::exit(2);
                    }
                }
            } else {
                eprintln!("rg: {}: No such file or directory", p);
                process::exit(2);
            }
        }
    }

    if total_matches > 0 {
        process::exit(0);
    } else {
        process::exit(1);
    }
}
