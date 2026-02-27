//! find - search for files in a directory hierarchy

use std::env;
use std::fs;
use std::path::Path;
use std::process;
use std::time::SystemTime;

// ---------------------------------------------------------------------------
// Glob matching (supports *, ?, and [abc] character classes)
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
    match pattern[0] {
        '*' => {
            // * matches zero or more characters
            for i in 0..=text.len() {
                if glob_match_inner(&pattern[1..], &text[i..]) {
                    return true;
                }
            }
            false
        }
        '[' => {
            // Character class [abc] or [a-z]
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
                        // range like a-z
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
                // No closing ']', treat '[' as literal
                if text.is_empty() {
                    false
                } else if pattern[0] == text[0] {
                    glob_match_inner(&pattern[1..], &text[1..])
                } else {
                    false
                }
            }
        }
        '?' => {
            if text.is_empty() {
                false
            } else {
                glob_match_inner(&pattern[1..], &text[1..])
            }
        }
        _ => {
            if text.is_empty() {
                false
            } else if pattern[0] == text[0] {
                glob_match_inner(&pattern[1..], &text[1..])
            } else {
                false
            }
        }
    }
}

fn glob_match_ci(pattern: &str, text: &str) -> bool {
    glob_match(&pattern.to_lowercase(), &text.to_lowercase())
}

// ---------------------------------------------------------------------------
// Expression tree for predicates
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum Expr {
    // Predicates
    Name(String),
    IName(String),
    Path(String),
    Type(char),
    Size(SizeSpec),
    Mtime(MtimeSpec),
    Newer(SystemTime),
    Empty,
    // Logical
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    // Actions
    Print,
    Print0,
    Exec(Vec<String>),      // command tokens; {} is placeholder, terminated by ;
    ExecBatch(Vec<String>), // command tokens; {} is placeholder, terminated by +
    Delete,
    // Always true (no-op placeholder)
    True,
}

#[derive(Debug)]
struct SizeSpec {
    op: char,   // '+', '-', or '='
    bytes: u64, // value in bytes (only 'c' suffix supported for now)
}

#[derive(Debug)]
struct MtimeSpec {
    op: char,  // '+', '-', or '='
    days: u64, // number of days
}

/// Execute a command with {} replaced by paths.
/// For `-exec cmd {} ;`, paths will contain a single path.
/// For `-exec cmd {} +`, paths will contain all accumulated paths.
fn exec_command(tokens: &[String], paths: &[String], printed: &mut bool) -> bool {
    // Build the command with {} replaced by path(s)
    let mut output: Vec<String> = Vec::new();
    for t in tokens {
        if t == "{}" {
            output.extend(paths.iter().cloned());
        } else {
            output.push(t.clone());
        }
    }

    if output.is_empty() {
        return true;
    }

    let cmd = output[0].as_str();
    let args = &output[1..];

    match cmd {
        "echo" => {
            println!("{}", args.join(" "));
            *printed = true;
        }
        "cat" => {
            for arg in args {
                if let Ok(contents) = fs::read_to_string(arg) {
                    print!("{}", contents);
                }
            }
            *printed = true;
        }
        "wc" => {
            // Simple wc: parse flags, count for each file argument
            let mut flag_l = false;
            let mut flag_w = false;
            let mut flag_c = false;
            let mut files = Vec::new();
            for arg in args {
                if let Some(flags) = arg.strip_prefix('-') {
                    for ch in flags.chars() {
                        match ch {
                            'l' => flag_l = true,
                            'w' => flag_w = true,
                            'c' => flag_c = true,
                            _ => {}
                        }
                    }
                } else {
                    files.push(arg.as_str());
                }
            }
            // If no flags, show all
            if !flag_l && !flag_w && !flag_c {
                flag_l = true;
                flag_w = true;
                flag_c = true;
            }
            let mut total_lines = 0usize;
            let mut total_words = 0usize;
            let mut total_bytes = 0usize;
            for file in &files {
                if let Ok(contents) = fs::read_to_string(file) {
                    let lines = contents.lines().count();
                    let words = contents.split_whitespace().count();
                    let bytes = contents.len();
                    let mut parts = Vec::new();
                    if flag_l {
                        parts.push(format!("{:>8}", lines));
                    }
                    if flag_w {
                        parts.push(format!("{:>8}", words));
                    }
                    if flag_c {
                        parts.push(format!("{:>8}", bytes));
                    }
                    println!("{} {}", parts.join(""), file);
                    total_lines += lines;
                    total_words += words;
                    total_bytes += bytes;
                }
            }
            if files.len() > 1 {
                let mut parts = Vec::new();
                if flag_l {
                    parts.push(format!("{:>8}", total_lines));
                }
                if flag_w {
                    parts.push(format!("{:>8}", total_words));
                }
                if flag_c {
                    parts.push(format!("{:>8}", total_bytes));
                }
                println!("{} total", parts.join(""));
            }
            *printed = true;
        }
        "rm" => {
            for arg in args {
                if arg.starts_with('-') {
                    continue;
                }
                let p = std::path::Path::new(arg);
                if p.is_file() {
                    let _ = fs::remove_file(p);
                } else if p.is_dir() {
                    let _ = fs::remove_dir_all(p);
                }
            }
            *printed = true;
        }
        "ls" => {
            for arg in args {
                if arg.starts_with('-') {
                    continue;
                }
                println!("{}", arg);
            }
            *printed = true;
        }
        "chmod" => {
            // Best effort: just print (chmod doesn't work well in WASM VFS)
            *printed = true;
        }
        "grep" => {
            // Simple grep: first non-flag arg is pattern, rest are files
            let mut pattern = None;
            let mut files = Vec::new();
            for arg in args {
                if arg.starts_with('-') {
                    continue;
                }
                if pattern.is_none() {
                    pattern = Some(arg.as_str());
                } else {
                    files.push(arg.as_str());
                }
            }
            if let Some(pat) = pattern {
                for file in &files {
                    if let Ok(contents) = fs::read_to_string(file) {
                        for line in contents.lines() {
                            if line.contains(pat) {
                                if files.len() > 1 {
                                    println!("{}:{}", file, line);
                                } else {
                                    println!("{}", line);
                                }
                            }
                        }
                    }
                }
            }
            *printed = true;
        }
        _ => {
            // Unknown command: print the expanded command line (best effort)
            println!("{}", output.join(" "));
            *printed = true;
        }
    }
    true
}

fn eval_expr(expr: &Expr, path: &Path, printed: &mut bool) -> bool {
    match expr {
        Expr::True => true,
        Expr::Name(pat) => {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                glob_match(pat, name)
            } else {
                false
            }
        }
        Expr::IName(pat) => {
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                glob_match_ci(pat, name)
            } else {
                false
            }
        }
        Expr::Path(pat) => {
            if let Some(p) = path.to_str() {
                glob_match(pat, p)
            } else {
                false
            }
        }
        Expr::Type(t) => match t {
            'f' => path.is_file() && !is_symlink(path),
            'd' => path.is_dir() && !is_symlink(path),
            'l' => is_symlink(path),
            _ => false,
        },
        Expr::Size(spec) => {
            if let Ok(meta) = fs::symlink_metadata(path) {
                let size = meta.len();
                match spec.op {
                    '+' => size > spec.bytes,
                    '-' => size < spec.bytes,
                    _ => size == spec.bytes,
                }
            } else {
                false
            }
        }
        Expr::Mtime(spec) => {
            if let Ok(meta) = fs::symlink_metadata(path) {
                if let Ok(mtime) = meta.modified() {
                    let age = SystemTime::now().duration_since(mtime).unwrap_or_default();
                    let age_days = age.as_secs() / 86400;
                    match spec.op {
                        '+' => age_days > spec.days,
                        '-' => age_days < spec.days,
                        _ => age_days == spec.days,
                    }
                } else {
                    false
                }
            } else {
                false
            }
        }
        Expr::Newer(ref_time) => {
            if let Ok(meta) = fs::symlink_metadata(path) {
                if let Ok(mtime) = meta.modified() {
                    mtime > *ref_time
                } else {
                    false
                }
            } else {
                false
            }
        }
        Expr::Empty => {
            if path.is_file() {
                if let Ok(meta) = fs::symlink_metadata(path) {
                    meta.len() == 0
                } else {
                    false
                }
            } else if path.is_dir() {
                match fs::read_dir(path) {
                    Ok(mut rd) => rd.next().is_none(),
                    Err(_) => false,
                }
            } else {
                false
            }
        }
        Expr::And(a, b) => {
            if !eval_expr(a, path, printed) {
                false
            } else {
                eval_expr(b, path, printed)
            }
        }
        Expr::Or(a, b) => {
            if eval_expr(a, path, printed) {
                true
            } else {
                eval_expr(b, path, printed)
            }
        }
        Expr::Not(e) => !eval_expr(e, path, printed),
        Expr::Print => {
            println!("{}", path.display());
            *printed = true;
            true
        }
        Expr::Print0 => {
            print!("{}\0", path.display());
            *printed = true;
            true
        }
        Expr::Exec(tokens) => {
            let path_str = path.display().to_string();
            exec_command(tokens, &[path_str], printed)
        }
        Expr::ExecBatch(_) => {
            // Batch mode: always match, accumulation happens in walk()
            true
        }
        Expr::Delete => {
            if path.is_file() || is_symlink(path) {
                if fs::remove_file(path).is_err() {
                    eprintln!("find: cannot delete '{}'", path.display());
                    return false;
                }
            } else if path.is_dir() && fs::remove_dir(path).is_err() {
                eprintln!("find: cannot delete '{}'", path.display());
                return false;
            }
            true
        }
    }
}

fn is_symlink(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(meta) => meta.file_type().is_symlink(),
        Err(_) => false,
    }
}

/// Check whether the expression tree contains any action (Print, Exec, Delete).
fn has_action(expr: &Expr) -> bool {
    match expr {
        Expr::Print | Expr::Print0 | Expr::Exec(_) | Expr::ExecBatch(_) | Expr::Delete => true,
        Expr::And(a, b) | Expr::Or(a, b) => has_action(a) || has_action(b),
        Expr::Not(e) => has_action(e),
        _ => false,
    }
}

/// Collect ExecBatch tokens from expression tree (if any).
fn collect_exec_batch(expr: &Expr) -> Option<&Vec<String>> {
    match expr {
        Expr::ExecBatch(tokens) => Some(tokens),
        Expr::And(a, b) | Expr::Or(a, b) => collect_exec_batch(a).or_else(|| collect_exec_batch(b)),
        Expr::Not(e) => collect_exec_batch(e),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Argument parsing into expression tree
// ---------------------------------------------------------------------------

fn parse_args(args: &[String]) -> (Vec<String>, Option<usize>, Option<usize>, Expr) {
    let mut paths: Vec<String> = Vec::new();
    let mut min_depth: Option<usize> = None;
    let mut max_depth: Option<usize> = None;
    let mut i = 0;

    // First, consume paths and global options (before predicates start)
    while i < args.len() {
        let a = args[i].as_str();
        // If it starts with '-' (but not a bare '-'), or is '(' or '!' or '(', it's an expression
        if a == "!" || a == "(" || a == ")" {
            break;
        }
        if a.starts_with('-') {
            // Check if it's a global option
            match a {
                "-mindepth" => {
                    i += 1;
                    if i < args.len() {
                        min_depth = args[i].parse().ok();
                    }
                    i += 1;
                    continue;
                }
                "-maxdepth" => {
                    i += 1;
                    if i < args.len() {
                        max_depth = args[i].parse().ok();
                    }
                    i += 1;
                    continue;
                }
                _ => break, // other flags are predicates
            }
        }
        // Not a flag — must be a path
        paths.push(args[i].to_string());
        i += 1;
    }

    if paths.is_empty() {
        paths.push(".".to_string());
    }

    // Parse the rest as an expression
    let remaining = &args[i..];
    let expr = if remaining.is_empty() {
        Expr::True
    } else {
        let (e, rest) = parse_or(remaining);
        if !rest.is_empty() {
            eprintln!("find: unexpected argument '{}'", rest[0]);
            process::exit(1);
        }
        e
    };

    (paths, min_depth, max_depth, expr)
}

/// Parse OR expressions: A -or B
fn parse_or(tokens: &[String]) -> (Expr, &[String]) {
    let (mut left, mut rest) = parse_and(tokens);
    while !rest.is_empty() {
        let t = rest[0].as_str();
        if t == "-or" || t == "-o" {
            let (right, r) = parse_and(&rest[1..]);
            left = Expr::Or(Box::new(left), Box::new(right));
            rest = r;
        } else {
            break;
        }
    }
    (left, rest)
}

/// Parse AND expressions: A B (implicit AND) or A -and B
fn parse_and(tokens: &[String]) -> (Expr, &[String]) {
    let (mut left, mut rest) = parse_unary(tokens);
    loop {
        if rest.is_empty() {
            break;
        }
        let t = rest[0].as_str();
        // Stop if we see OR, close paren, or end-of-expression markers
        if t == "-or" || t == "-o" || t == ")" {
            break;
        }
        // Explicit -and / -a
        if t == "-and" || t == "-a" {
            let (right, r) = parse_unary(&rest[1..]);
            left = Expr::And(Box::new(left), Box::new(right));
            rest = r;
            continue;
        }
        // Implicit AND: next token is another primary
        let (right, r) = parse_unary(rest);
        left = Expr::And(Box::new(left), Box::new(right));
        rest = r;
    }
    (left, rest)
}

/// Parse unary: -not / ! or primary
fn parse_unary(tokens: &[String]) -> (Expr, &[String]) {
    if tokens.is_empty() {
        return (Expr::True, tokens);
    }
    let t = tokens[0].as_str();
    if t == "-not" || t == "!" {
        let (expr, rest) = parse_unary(&tokens[1..]);
        return (Expr::Not(Box::new(expr)), rest);
    }
    parse_primary(tokens)
}

/// Parse a primary expression
fn parse_primary(tokens: &[String]) -> (Expr, &[String]) {
    if tokens.is_empty() {
        return (Expr::True, tokens);
    }
    let t = tokens[0].as_str();
    match t {
        "(" => {
            let (expr, rest) = parse_or(&tokens[1..]);
            if rest.is_empty() || rest[0] != ")" {
                eprintln!("find: missing closing ')'");
                process::exit(1);
            }
            (expr, &rest[1..])
        }
        "-name" => {
            if tokens.len() < 2 {
                eprintln!("find: missing argument to '-name'");
                process::exit(1);
            }
            (Expr::Name(tokens[1].clone()), &tokens[2..])
        }
        "-iname" => {
            if tokens.len() < 2 {
                eprintln!("find: missing argument to '-iname'");
                process::exit(1);
            }
            (Expr::IName(tokens[1].clone()), &tokens[2..])
        }
        "-path" => {
            if tokens.len() < 2 {
                eprintln!("find: missing argument to '-path'");
                process::exit(1);
            }
            (Expr::Path(tokens[1].clone()), &tokens[2..])
        }
        "-type" => {
            if tokens.len() < 2 {
                eprintln!("find: missing argument to '-type'");
                process::exit(1);
            }
            let ch = tokens[1].chars().next().unwrap_or('f');
            (Expr::Type(ch), &tokens[2..])
        }
        "-size" => {
            if tokens.len() < 2 {
                eprintln!("find: missing argument to '-size'");
                process::exit(1);
            }
            let spec = parse_size(&tokens[1]);
            (Expr::Size(spec), &tokens[2..])
        }
        "-mtime" => {
            if tokens.len() < 2 {
                eprintln!("find: missing argument to '-mtime'");
                process::exit(1);
            }
            let spec = parse_mtime(&tokens[1]);
            (Expr::Mtime(spec), &tokens[2..])
        }
        "-newer" => {
            if tokens.len() < 2 {
                eprintln!("find: missing argument to '-newer'");
                process::exit(1);
            }
            let ref_time = match fs::metadata(&tokens[1]) {
                Ok(meta) => meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                Err(e) => {
                    eprintln!("find: '{}': {}", tokens[1], e);
                    process::exit(1);
                }
            };
            (Expr::Newer(ref_time), &tokens[2..])
        }
        "-empty" => (Expr::Empty, &tokens[1..]),
        "-print" => (Expr::Print, &tokens[1..]),
        "-print0" => (Expr::Print0, &tokens[1..]),
        "-delete" => (Expr::Delete, &tokens[1..]),
        "-exec" => {
            // Collect tokens until ";" or "+"
            let mut cmd_tokens = Vec::new();
            let mut idx = 1;
            let mut batch_mode = false;
            while idx < tokens.len() {
                if tokens[idx] == ";" {
                    idx += 1;
                    break;
                }
                if tokens[idx] == "+" {
                    batch_mode = true;
                    idx += 1;
                    break;
                }
                cmd_tokens.push(tokens[idx].clone());
                idx += 1;
            }
            if batch_mode {
                (Expr::ExecBatch(cmd_tokens), &tokens[idx..])
            } else {
                (Expr::Exec(cmd_tokens), &tokens[idx..])
            }
        }
        // Handle -mindepth / -maxdepth that might appear mixed with predicates
        "-mindepth" | "-maxdepth" => {
            // These are global options that should have been consumed earlier,
            // but if they appear here, skip them.
            if tokens.len() >= 2 {
                (Expr::True, &tokens[2..])
            } else {
                (Expr::True, &tokens[1..])
            }
        }
        _ => {
            eprintln!("find: unknown predicate '{}'", t);
            process::exit(1);
        }
    }
}

fn parse_size(s: &str) -> SizeSpec {
    let mut chars = s.chars().peekable();
    let op = match chars.peek() {
        Some('+') => {
            chars.next();
            '+'
        }
        Some('-') => {
            chars.next();
            '-'
        }
        _ => '=',
    };
    let num_str: String = chars.clone().take_while(|c| c.is_ascii_digit()).collect();
    let n: u64 = num_str.parse().unwrap_or(0);
    // Consume the digits
    for _ in 0..num_str.len() {
        chars.next();
    }
    // Check suffix
    let suffix = chars.next().unwrap_or('b');
    let bytes = match suffix {
        'c' => n,           // bytes
        'k' => n * 1024,    // kilobytes
        'M' => n * 1048576, // megabytes
        _ => n * 512,       // default: 512-byte blocks
    };
    SizeSpec { op, bytes }
}

fn parse_mtime(s: &str) -> MtimeSpec {
    let mut chars = s.chars().peekable();
    let op = match chars.peek() {
        Some('+') => {
            chars.next();
            '+'
        }
        Some('-') => {
            chars.next();
            '-'
        }
        _ => '=',
    };
    let num_str: String = chars.take_while(|c| c.is_ascii_digit()).collect();
    let days: u64 = num_str.parse().unwrap_or(0);
    MtimeSpec { op, days }
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

fn walk(
    dir: &Path,
    expr: &Expr,
    depth: usize,
    min_depth: Option<usize>,
    max_depth: Option<usize>,
    has_act: bool,
    batch_paths: &mut Vec<String>,
) {
    if let Some(max) = max_depth {
        if depth > max {
            return;
        }
    }

    let should_eval = match min_depth {
        Some(min) => depth >= min,
        None => true,
    };

    if should_eval {
        let mut printed = false;
        let matched = eval_expr(expr, dir, &mut printed);
        if matched {
            // Accumulate for batch exec
            if collect_exec_batch(expr).is_some() {
                batch_paths.push(dir.display().to_string());
            }
            // If there's no explicit action in the expression, default to -print
            if !has_act && !printed {
                println!("{}", dir.display());
            }
        }
    }

    if dir.is_dir() && !is_symlink(dir) {
        if let Some(max) = max_depth {
            if depth >= max {
                return;
            }
        }

        let mut entries: Vec<_> = match fs::read_dir(dir) {
            Ok(rd) => rd.filter_map(|e| e.ok()).collect(),
            Err(e) => {
                eprintln!("find: '{}': {}", dir.display(), e);
                return;
            }
        };
        entries.sort_by_key(|e| e.file_name());

        for entry in entries {
            let child = entry.path();
            if child.is_dir() && !is_symlink(&child) {
                walk(
                    &child,
                    expr,
                    depth + 1,
                    min_depth,
                    max_depth,
                    has_act,
                    batch_paths,
                );
            } else {
                // File or symlink
                if let Some(max) = max_depth {
                    if depth + 1 > max {
                        continue;
                    }
                }
                let should_eval_child = match min_depth {
                    Some(min) => depth + 1 >= min,
                    None => true,
                };
                if should_eval_child {
                    let mut printed = false;
                    let matched = eval_expr(expr, &child, &mut printed);
                    if matched {
                        if collect_exec_batch(expr).is_some() {
                            batch_paths.push(child.display().to_string());
                        }
                        if !has_act && !printed {
                            println!("{}", child.display());
                        }
                    }
                }
            }
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let (paths, min_depth, max_depth, expr) = parse_args(&args);
    let has_act = has_action(&expr);

    let mut batch_paths = Vec::new();

    for path in &paths {
        walk(
            Path::new(path),
            &expr,
            0,
            min_depth,
            max_depth,
            has_act,
            &mut batch_paths,
        );
    }

    // If there's a batch exec, run it now with all accumulated paths
    if let Some(tokens) = collect_exec_batch(&expr) {
        if !batch_paths.is_empty() {
            let mut printed = false;
            exec_command(tokens, &batch_paths, &mut printed);
        }
    }
}
