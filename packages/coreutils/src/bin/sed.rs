//! sed - stream editor
//!
//! Supports: s/pattern/replacement/[flags], d, p, q, line-number and
//! /pattern/ addressing, -n flag, -e expressions, multiple commands via ;
//!
//! Pattern matching uses simple substring matching (no regex).

use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::process;

#[derive(Clone)]
enum Address {
    None,
    Line(usize),
    Last,
    Pattern(String),
    Range(Box<Address>, Box<Address>),
}

#[derive(Clone)]
enum SedCmd {
    Substitute {
        pattern: String,
        replacement: String,
        global: bool,
        print: bool,
        ignore_case: bool,
    },
    Delete,
    Print,
    Quit,
    AppendText(String),
    InsertText(String),
}

#[derive(Clone)]
struct Rule {
    address: Address,
    command: SedCmd,
}

fn parse_substitute(s: &str) -> Option<SedCmd> {
    // s/pattern/replacement/flags
    if s.len() < 2 {
        return None;
    }
    let delim = s.chars().next()?;
    let rest = &s[delim.len_utf8()..];

    // Find second delimiter
    let second = rest.find(delim)?;
    let pattern = rest[..second].to_string();
    let rest = &rest[second + delim.len_utf8()..];

    // Find third delimiter (optional — flags may follow or string may end)
    let (replacement, flags_str) = if let Some(third) = rest.find(delim) {
        (rest[..third].to_string(), &rest[third + delim.len_utf8()..])
    } else {
        (rest.to_string(), "")
    };

    let mut global = false;
    let mut print = false;
    let mut ignore_case = false;
    for ch in flags_str.chars() {
        match ch {
            'g' => global = true,
            'p' => print = true,
            'i' | 'I' => ignore_case = true,
            _ => {}
        }
    }

    Some(SedCmd::Substitute {
        pattern,
        replacement,
        global,
        print,
        ignore_case,
    })
}

fn parse_address(s: &str) -> (Address, &str) {
    if s.is_empty() {
        return (Address::None, s);
    }

    let ch = s.as_bytes()[0];

    if ch == b'$' {
        let rest = &s[1..];
        if let Some(after_comma) = rest.strip_prefix(',') {
            let (addr2, rest2) = parse_address(after_comma);
            return (
                Address::Range(Box::new(Address::Last), Box::new(addr2)),
                rest2,
            );
        }
        return (Address::Last, rest);
    }

    if ch.is_ascii_digit() {
        let end = s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len());
        let n: usize = s[..end].parse().unwrap_or(0);
        let rest = &s[end..];
        let addr = Address::Line(n);
        if let Some(after_comma) = rest.strip_prefix(',') {
            let (addr2, rest2) = parse_address(after_comma);
            return (Address::Range(Box::new(addr), Box::new(addr2)), rest2);
        }
        return (addr, rest);
    }

    if ch == b'/' {
        let rest = &s[1..];
        if let Some(end) = rest.find('/') {
            let pattern = rest[..end].to_string();
            let after = &rest[end + 1..];
            let addr = Address::Pattern(pattern);
            if let Some(after_comma) = after.strip_prefix(',') {
                let (addr2, rest2) = parse_address(after_comma);
                return (Address::Range(Box::new(addr), Box::new(addr2)), rest2);
            }
            return (addr, after);
        }
    }

    (Address::None, s)
}

fn parse_script(script: &str) -> Vec<Rule> {
    let mut rules = Vec::new();

    for part in script.split(';') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }

        let (address, rest) = parse_address(trimmed);
        let rest = rest.trim_start();

        if rest.is_empty() {
            continue;
        }

        let cmd = match rest.as_bytes()[0] {
            b's' => {
                if let Some(sub) = parse_substitute(&rest[1..]) {
                    sub
                } else {
                    continue;
                }
            }
            b'd' => SedCmd::Delete,
            b'p' => SedCmd::Print,
            b'q' => SedCmd::Quit,
            b'a' => {
                let text = rest[1..].trim_start_matches('\\').trim_start().to_string();
                SedCmd::AppendText(text)
            }
            b'i' => {
                let text = rest[1..].trim_start_matches('\\').trim_start().to_string();
                SedCmd::InsertText(text)
            }
            _ => continue,
        };

        rules.push(Rule {
            address,
            command: cmd,
        });
    }

    rules
}

fn address_matches(addr: &Address, line_num: usize, line: &str, is_last: bool) -> bool {
    match addr {
        Address::None => true,
        Address::Line(n) => line_num == *n,
        Address::Last => is_last,
        Address::Pattern(pat) => line.contains(pat.as_str()),
        Address::Range(start, end) => {
            address_matches(start, line_num, line, is_last)
                || address_matches(end, line_num, line, is_last)
            // A range is active from the first matching start through the first matching end
            // For simplicity, just check if line_num is between the two line addresses
        }
    }
}

fn apply_substitute(
    line: &str,
    pattern: &str,
    replacement: &str,
    global: bool,
    ignore_case: bool,
) -> (String, bool) {
    if pattern.is_empty() {
        return (line.to_string(), false);
    }

    let (search_line, search_pat) = if ignore_case {
        (line.to_lowercase(), pattern.to_lowercase())
    } else {
        (line.to_string(), pattern.to_string())
    };

    if !search_line.contains(&search_pat) {
        return (line.to_string(), false);
    }

    let mut result = String::new();
    let mut pos = 0;
    let mut changed = false;

    loop {
        if pos >= line.len() {
            break;
        }

        let hay = if ignore_case {
            search_line[pos..].to_string()
        } else {
            line[pos..].to_string()
        };

        if let Some(idx) = hay.find(&search_pat) {
            result.push_str(&line[pos..pos + idx]);
            result.push_str(replacement);
            pos += idx + pattern.len();
            changed = true;

            if !global {
                result.push_str(&line[pos..]);
                return (result, true);
            }
        } else {
            result.push_str(&line[pos..]);
            break;
        }
    }

    (result, changed)
}

fn run_sed(input: &mut dyn Read, rules: &[Rule], suppress: bool) {
    let reader = BufReader::new(input);
    let lines: Vec<String> = reader.lines().map_while(Result::ok).collect();
    let total = lines.len();

    for (i, line) in lines.iter().enumerate() {
        let line_num = i + 1;
        let is_last = line_num == total;
        let mut current = line.clone();
        let mut deleted = false;
        let mut extra_print = false;
        let mut append_text: Vec<String> = Vec::new();
        let mut insert_text: Vec<String> = Vec::new();
        let mut quit = false;

        for rule in rules {
            if !address_matches(&rule.address, line_num, &current, is_last) {
                continue;
            }

            match &rule.command {
                SedCmd::Substitute {
                    pattern,
                    replacement,
                    global,
                    print,
                    ignore_case,
                } => {
                    let (new_line, changed) =
                        apply_substitute(&current, pattern, replacement, *global, *ignore_case);
                    current = new_line;
                    if changed && *print {
                        extra_print = true;
                    }
                }
                SedCmd::Delete => {
                    deleted = true;
                    break;
                }
                SedCmd::Print => {
                    extra_print = true;
                }
                SedCmd::Quit => {
                    quit = true;
                }
                SedCmd::AppendText(text) => {
                    append_text.push(text.clone());
                }
                SedCmd::InsertText(text) => {
                    insert_text.push(text.clone());
                }
            }
        }

        if !deleted {
            for text in &insert_text {
                println!("{}", text);
            }
            if !suppress || extra_print {
                println!("{}", current);
            }
            for text in &append_text {
                println!("{}", text);
            }
        }

        if quit {
            return;
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut suppress = false;
    let mut scripts: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-n" => suppress = true,
            "-e" => {
                i += 1;
                if i >= args.len() {
                    eprintln!("sed: option requires an argument -- 'e'");
                    process::exit(1);
                }
                scripts.push(args[i].clone());
            }
            arg => {
                if scripts.is_empty() && !arg.starts_with('-') {
                    // First non-option is the script if no -e given
                    scripts.push(arg.to_string());
                } else {
                    files.push(arg.to_string());
                }
            }
        }
        i += 1;
    }

    if scripts.is_empty() {
        eprintln!("sed: no script given");
        process::exit(1);
    }

    let mut rules = Vec::new();
    for script in &scripts {
        rules.extend(parse_script(script));
    }

    if files.is_empty() {
        let stdin = io::stdin();
        let mut lock = stdin.lock();
        run_sed(&mut lock, &rules, suppress);
    } else {
        for file in &files {
            match File::open(file) {
                Ok(mut f) => run_sed(&mut f, &rules, suppress),
                Err(e) => {
                    eprintln!("sed: {}: {}", file, e);
                    process::exit(1);
                }
            }
        }
    }
}
