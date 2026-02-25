//! grep - search for patterns in files (with BRE regex support)

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
}

// ---------------------------------------------------------------------------
// Regex engine (BRE / ERE)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Re {
    Literal(char),
    Dot,
    Class(Vec<(char, char)>, bool), // ranges, negated
    Anchor(bool),                   // true = ^, false = $
    Group(Vec<(Re, Quantifier)>),
    Alternation(Vec<Vec<(Re, Quantifier)>>),
}

#[derive(Debug, Clone)]
enum Quantifier {
    One,
    Star,
    Plus,
    Question,
}

fn parse_char_class(chars: &[char], pos: &mut usize) -> Re {
    let mut ranges: Vec<(char, char)> = Vec::new();
    let negated = *pos < chars.len() && chars[*pos] == '^';
    if negated {
        *pos += 1;
    }

    // ] as first char is literal
    if *pos < chars.len() && chars[*pos] == ']' {
        ranges.push((']', ']'));
        *pos += 1;
    }

    while *pos < chars.len() && chars[*pos] != ']' {
        if chars[*pos] == '[' && *pos + 1 < chars.len() && chars[*pos + 1] == ':' {
            // POSIX class [:alpha:] etc.
            let start = *pos + 2;
            let mut end = start;
            while end + 1 < chars.len() && !(chars[end] == ':' && chars[end + 1] == ']') {
                end += 1;
            }
            let class_name: String = chars[start..end].iter().collect();
            *pos = end + 2; // skip :]
            match class_name.as_str() {
                "alpha" => {
                    ranges.push(('a', 'z'));
                    ranges.push(('A', 'Z'));
                }
                "digit" => ranges.push(('0', '9')),
                "alnum" => {
                    ranges.push(('a', 'z'));
                    ranges.push(('A', 'Z'));
                    ranges.push(('0', '9'));
                }
                "space" => {
                    ranges.push((' ', ' '));
                    ranges.push(('\t', '\t'));
                    ranges.push(('\n', '\n'));
                    ranges.push(('\r', '\r'));
                }
                "upper" => ranges.push(('A', 'Z')),
                "lower" => ranges.push(('a', 'z')),
                "blank" => {
                    ranges.push((' ', ' '));
                    ranges.push(('\t', '\t'));
                }
                "print" | "graph" => {
                    ranges.push((' ', '~'));
                }
                "punct" => {
                    ranges.push(('!', '/'));
                    ranges.push((':', '@'));
                    ranges.push(('[', '`'));
                    ranges.push(('{', '~'));
                }
                _ => {}
            }
            continue;
        }

        let ch = chars[*pos];
        *pos += 1;

        if *pos + 1 < chars.len() && chars[*pos] == '-' && chars[*pos + 1] != ']' {
            let end_ch = chars[*pos + 1];
            ranges.push((ch, end_ch));
            *pos += 2;
        } else {
            ranges.push((ch, ch));
        }
    }

    if *pos < chars.len() && chars[*pos] == ']' {
        *pos += 1; // skip ]
    }

    Re::Class(ranges, negated)
}

fn compile_regex(pattern: &str, extended: bool) -> Vec<(Re, Quantifier)> {
    let chars: Vec<char> = pattern.chars().collect();
    let tokens = compile_tokens(&chars, 0, chars.len(), extended);

    // Handle alternation at top level for ERE
    if extended {
        let mut alts: Vec<Vec<(Re, Quantifier)>> = Vec::new();
        let mut current: Vec<(Re, Quantifier)> = Vec::new();

        for (re, q) in tokens {
            if let Re::Literal('|') = &re {
                alts.push(current);
                current = Vec::new();
            } else {
                current.push((re, q));
            }
        }
        alts.push(current);

        if alts.len() > 1 {
            return vec![(Re::Alternation(alts), Quantifier::One)];
        }
        return alts.into_iter().next().unwrap_or_default();
    }

    tokens
}

fn compile_tokens(
    chars: &[char],
    start: usize,
    end: usize,
    extended: bool,
) -> Vec<(Re, Quantifier)> {
    let mut tokens: Vec<(Re, Quantifier)> = Vec::new();
    let mut i = start;

    while i < end {
        let ch = chars[i];

        // Anchors
        if ch == '^' && i == start {
            tokens.push((Re::Anchor(true), Quantifier::One));
            i += 1;
            continue;
        }
        if ch == '$' && i + 1 == end {
            tokens.push((Re::Anchor(false), Quantifier::One));
            i += 1;
            continue;
        }

        // Dot
        if ch == '.' {
            i += 1;
            let q = parse_quantifier(chars, &mut i, extended);
            tokens.push((Re::Dot, q));
            continue;
        }

        // Character class
        if ch == '[' {
            i += 1;
            let re = parse_char_class(chars, &mut i);
            let q = parse_quantifier(chars, &mut i, extended);
            tokens.push((re, q));
            continue;
        }

        // Escape
        if ch == '\\' && i + 1 < end {
            i += 1;
            let esc = chars[i];
            i += 1;

            match esc {
                // BRE grouping: \( ... \)
                '(' if !extended => {
                    let group_start = i;
                    let mut depth = 1;
                    while i < end && depth > 0 {
                        if chars[i] == '\\' && i + 1 < end {
                            if chars[i + 1] == '(' {
                                depth += 1;
                            } else if chars[i + 1] == ')' {
                                depth -= 1;
                            }
                            i += 2;
                        } else {
                            i += 1;
                        }
                    }
                    let inner = compile_tokens(chars, group_start, i - 2, extended);
                    let q = parse_quantifier(chars, &mut i, extended);
                    tokens.push((Re::Group(inner), q));
                }
                // BRE alternation: \|
                '|' if !extended => {
                    // Split at this point - convert to alternation
                    let right = compile_tokens(chars, i, end, extended);
                    let alts = vec![tokens.clone(), right];
                    return vec![(Re::Alternation(alts), Quantifier::One)];
                }
                'd' => {
                    let q = parse_quantifier(chars, &mut i, extended);
                    tokens.push((Re::Class(vec![('0', '9')], false), q));
                }
                'w' => {
                    let q = parse_quantifier(chars, &mut i, extended);
                    tokens.push((
                        Re::Class(vec![('a', 'z'), ('A', 'Z'), ('0', '9'), ('_', '_')], false),
                        q,
                    ));
                }
                's' => {
                    let q = parse_quantifier(chars, &mut i, extended);
                    tokens.push((
                        Re::Class(vec![(' ', ' '), ('\t', '\t'), ('\n', '\n')], false),
                        q,
                    ));
                }
                _ => {
                    let q = parse_quantifier(chars, &mut i, extended);
                    tokens.push((Re::Literal(esc), q));
                }
            }
            continue;
        }

        // ERE grouping: ( ... )
        if extended && ch == '(' {
            i += 1;
            let group_start = i;
            let mut depth = 1;
            while i < end && depth > 0 {
                if chars[i] == '\\' && i + 1 < end {
                    i += 2;
                } else if chars[i] == '(' {
                    depth += 1;
                    i += 1;
                } else if chars[i] == ')' {
                    depth -= 1;
                    if depth > 0 {
                        i += 1;
                    }
                } else {
                    i += 1;
                }
            }
            let inner_end = i;
            i += 1; // skip )
            let inner = compile_tokens(chars, group_start, inner_end, extended);
            let q = parse_quantifier(chars, &mut i, extended);
            tokens.push((Re::Group(inner), q));
            continue;
        }

        // ERE alternation
        if extended && ch == '|' {
            tokens.push((Re::Literal('|'), Quantifier::One));
            i += 1;
            continue;
        }

        // Literal character
        i += 1;
        let q = parse_quantifier(chars, &mut i, extended);
        tokens.push((Re::Literal(ch), q));
    }

    tokens
}

fn parse_quantifier(chars: &[char], pos: &mut usize, extended: bool) -> Quantifier {
    if *pos >= chars.len() {
        return Quantifier::One;
    }

    match chars[*pos] {
        '*' => {
            *pos += 1;
            Quantifier::Star
        }
        '+' if extended => {
            *pos += 1;
            Quantifier::Plus
        }
        '?' if extended => {
            *pos += 1;
            Quantifier::Question
        }
        '\\' if !extended && *pos + 1 < chars.len() => {
            if chars[*pos + 1] == '+' {
                *pos += 2;
                Quantifier::Plus
            } else if chars[*pos + 1] == '?' {
                *pos += 2;
                Quantifier::Question
            } else {
                Quantifier::One
            }
        }
        _ => Quantifier::One,
    }
}

fn match_char(re: &Re, ch: char) -> bool {
    match re {
        Re::Literal(expected) => ch == *expected,
        Re::Dot => ch != '\n',
        Re::Class(ranges, negated) => {
            let in_class = ranges.iter().any(|(lo, hi)| ch >= *lo && ch <= *hi);
            if *negated {
                !in_class
            } else {
                in_class
            }
        }
        _ => false,
    }
}

fn match_tokens(
    text: &[char],
    pos: usize,
    tokens: &[(Re, Quantifier)],
    tok_idx: usize,
) -> Option<usize> {
    if tok_idx >= tokens.len() {
        return Some(pos);
    }

    let (re, quant) = &tokens[tok_idx];

    // Handle anchors
    if let Re::Anchor(is_start) = re {
        if *is_start {
            if pos == 0 {
                return match_tokens(text, pos, tokens, tok_idx + 1);
            }
            return None;
        } else {
            if pos == text.len() {
                return match_tokens(text, pos, tokens, tok_idx + 1);
            }
            return None;
        }
    }

    // Handle groups and alternation
    if let Re::Group(inner) = re {
        match quant {
            Quantifier::One => {
                if let Some(end) = match_tokens(text, pos, inner, 0) {
                    return match_tokens(text, end, tokens, tok_idx + 1);
                }
                return None;
            }
            Quantifier::Star => {
                return match_repetition(text, pos, tokens, tok_idx, re, 0, usize::MAX);
            }
            Quantifier::Plus => {
                return match_repetition(text, pos, tokens, tok_idx, re, 1, usize::MAX);
            }
            Quantifier::Question => {
                return match_repetition(text, pos, tokens, tok_idx, re, 0, 1);
            }
        }
    }

    if let Re::Alternation(alts) = re {
        for alt in alts {
            if let Some(end) = match_tokens(text, pos, alt, 0) {
                if let Some(final_end) = match_tokens(text, end, tokens, tok_idx + 1) {
                    return Some(final_end);
                }
            }
        }
        return None;
    }

    match quant {
        Quantifier::One => {
            if pos < text.len() && match_char(re, text[pos]) {
                match_tokens(text, pos + 1, tokens, tok_idx + 1)
            } else {
                None
            }
        }
        Quantifier::Star => match_repetition(text, pos, tokens, tok_idx, re, 0, usize::MAX),
        Quantifier::Plus => match_repetition(text, pos, tokens, tok_idx, re, 1, usize::MAX),
        Quantifier::Question => match_repetition(text, pos, tokens, tok_idx, re, 0, 1),
    }
}

fn match_repetition(
    text: &[char],
    pos: usize,
    tokens: &[(Re, Quantifier)],
    tok_idx: usize,
    re: &Re,
    min: usize,
    max: usize,
) -> Option<usize> {
    // Collect greedy positions
    let mut positions = vec![pos];
    let mut current = pos;
    let mut count = 0;

    while count < max && current < text.len() {
        if let Re::Group(inner) = re {
            if let Some(end) = match_tokens(text, current, inner, 0) {
                if end == current {
                    break; // avoid infinite loop
                }
                current = end;
                count += 1;
                positions.push(current);
            } else {
                break;
            }
        } else if match_char(re, text[current]) {
            current += 1;
            count += 1;
            positions.push(current);
        } else {
            break;
        }
    }

    // Try greedy (most to least)
    for i in (min..positions.len()).rev() {
        if let Some(end) = match_tokens(text, positions[i], tokens, tok_idx + 1) {
            return Some(end);
        }
    }
    None
}

fn regex_matches(text: &str, tokens: &[(Re, Quantifier)]) -> bool {
    let chars: Vec<char> = text.chars().collect();

    // Check for ^ anchor
    let anchored_start = !tokens.is_empty() && matches!(&tokens[0].0, Re::Anchor(true));

    if anchored_start {
        return match_tokens(&chars, 0, tokens, 0).is_some();
    }

    // Try matching at each position
    for start in 0..=chars.len() {
        if match_tokens(&chars, start, tokens, 0).is_some() {
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// grep logic
// ---------------------------------------------------------------------------

fn matches(line: &str, compiled: &[(Re, Quantifier)], ignore_case: bool) -> bool {
    if ignore_case {
        let line_lower = line.to_lowercase();
        regex_matches(&line_lower, compiled)
    } else {
        regex_matches(line, compiled)
    }
}

fn grep_reader<R: io::Read>(
    reader: R,
    compiled: &[(Re, Quantifier)],
    opts: &Options,
    filename: &str,
    show_filename: bool,
) -> io::Result<bool> {
    let buf = BufReader::new(reader);
    let mut match_count: usize = 0;
    let mut found = false;

    for (i, line_result) in buf.lines().enumerate() {
        let line = line_result?;
        let is_match = matches(&line, compiled, opts.ignore_case);
        let selected = if opts.invert { !is_match } else { is_match };

        if selected {
            found = true;

            if opts.files_with_matches {
                println!("{}", filename);
                return Ok(true);
            }

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
            println!("{}{}", prefix, line);
        }
    }

    if opts.count_only {
        if show_filename {
            println!("{}:{}", filename, match_count);
        } else {
            println!("{}", match_count);
        }
    }

    Ok(found)
}

fn grep_path(
    path: &Path,
    compiled: &[(Re, Quantifier)],
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
            match grep_path(&child, compiled, opts, true) {
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
        let f = File::open(path)?;
        grep_reader(
            f,
            compiled,
            opts,
            &path.display().to_string(),
            show_filename,
        )
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
    };
    let mut positional: Vec<String> = Vec::new();
    let mut past_flags = false;

    for arg in &args[1..] {
        if past_flags {
            positional.push(arg.clone());
            continue;
        }
        if arg == "--" {
            past_flags = true;
            continue;
        }
        if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
            for ch in arg[1..].chars() {
                match ch {
                    'i' => opts.ignore_case = true,
                    'v' => opts.invert = true,
                    'c' => opts.count_only = true,
                    'n' => opts.line_numbers = true,
                    'l' => opts.files_with_matches = true,
                    'r' | 'R' => opts.recursive = true,
                    'E' => opts.extended = true,
                    _ => {
                        eprintln!("grep: invalid option -- '{}'", ch);
                        process::exit(2);
                    }
                }
            }
        } else {
            positional.push(arg.clone());
        }
    }

    if positional.is_empty() {
        eprintln!("grep: missing pattern");
        eprintln!("Usage: grep [OPTION]... PATTERN [FILE]...");
        process::exit(2);
    }

    let pattern = &positional[0];
    let compiled = if opts.ignore_case {
        compile_regex(&pattern.to_lowercase(), opts.extended)
    } else {
        compile_regex(pattern, opts.extended)
    };
    let files = &positional[1..];

    let mut found_any = false;
    let mut had_error = false;

    if files.is_empty() {
        let stdin = io::stdin();
        match grep_reader(stdin.lock(), &compiled, &opts, "(standard input)", false) {
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
        let show_filename = files.len() > 1 || opts.recursive;
        for file in files {
            let path = Path::new(file);
            match grep_path(path, &compiled, &opts, show_filename) {
                Ok(found) => {
                    if found {
                        found_any = true;
                    }
                }
                Err(e) => {
                    eprintln!("grep: {}: {}", file, e);
                    had_error = true;
                }
            }
        }
    }

    if had_error {
        process::exit(2);
    } else if found_any {
        process::exit(0);
    } else {
        process::exit(1);
    }
}
