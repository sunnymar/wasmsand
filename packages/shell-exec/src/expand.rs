use codepod_shell::ast::{Word, WordPart};

use crate::state::{ShellFlag, ShellState};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Expand all parts of a `Word` into a single string.
pub fn expand_word(state: &mut ShellState, word: &Word) -> String {
    word.parts
        .iter()
        .map(|part| expand_word_part(state, part))
        .collect()
}

/// Determine whether a word's expansion should be subject to word splitting.
///
/// A word needs splitting when it contains a substitution (Variable or
/// CommandSub) but is not quoted.
pub fn word_needs_splitting(word: &Word) -> bool {
    let has_substitution = word
        .parts
        .iter()
        .any(|p| matches!(p, WordPart::CommandSub(_) | WordPart::Variable(_)));
    let is_quoted = word
        .parts
        .iter()
        .any(|p| matches!(p, WordPart::QuotedLiteral(_)));
    has_substitution && !is_quoted
}

/// Expand a list of words, applying word splitting to unquoted substitutions.
pub fn expand_words_with_splitting(state: &mut ShellState, words: &[Word]) -> Vec<String> {
    let mut result = Vec::new();
    for w in words {
        let expanded = expand_word(state, w);
        if word_needs_splitting(w) {
            let split: Vec<&str> = expanded.split_whitespace().collect();
            for s in split {
                if !s.is_empty() {
                    result.push(s.to_string());
                }
            }
        } else {
            result.push(expanded);
        }
    }
    result
}

/// Expand a single `WordPart` into a string.
///
/// Takes `&mut ShellState` because the `:=` operator can mutate the
/// environment.
pub fn expand_word_part(state: &mut ShellState, part: &WordPart) -> String {
    match part {
        WordPart::Literal(s) => expand_literal(s, state),

        WordPart::QuotedLiteral(s) => {
            // Protect braces inside quoted literals so they survive brace
            // expansion (matching the TypeScript behavior that uses PUA chars).
            s.replace('{', "\u{E000}").replace('}', "\u{E001}")
        }

        WordPart::Variable(name) => expand_variable(state, name),

        WordPart::CommandSub(_) => {
            // Task 9 will implement command substitution.
            String::new()
        }

        WordPart::ProcessSub(_) => {
            // Not yet implemented.
            String::new()
        }

        WordPart::ParamExpansion { var, op, default } => expand_param(state, var, op, default),

        WordPart::ArithmeticExpansion(_) => {
            // Task 7 will implement arithmetic expansion.
            String::new()
        }
    }
}

// ---------------------------------------------------------------------------
// Literal and tilde expansion
// ---------------------------------------------------------------------------

fn expand_literal(s: &str, state: &ShellState) -> String {
    if s == "~" {
        return state
            .env
            .get("HOME")
            .cloned()
            .unwrap_or_else(|| "/home/user".to_string());
    }
    if let Some(rest) = s.strip_prefix("~/") {
        let home = state
            .env
            .get("HOME")
            .cloned()
            .unwrap_or_else(|| "/home/user".to_string());
        return format!("{home}/{rest}");
    }
    s.to_string()
}

// ---------------------------------------------------------------------------
// Variable expansion ($VAR, $?, $#, $@, $*, $0–$9, specials)
// ---------------------------------------------------------------------------

fn expand_variable(state: &mut ShellState, name: &str) -> String {
    // Special variables
    match name {
        "?" => return state.last_exit_code.to_string(),
        "@" | "*" => return state.positional_args.join(" "),
        "#" => return state.positional_args.len().to_string(),
        "RANDOM" => return random_u15().to_string(),
        "SECONDS" => return "0".to_string(), // placeholder — no start_time yet
        "LINENO" => return "0".to_string(),  // placeholder — no line tracking yet
        _ => {}
    }

    // Positional parameters ($0–$9 and beyond)
    if let Ok(idx) = name.parse::<usize>() {
        if idx == 0 {
            return "codepod-shell".to_string();
        }
        return state
            .positional_args
            .get(idx - 1)
            .cloned()
            .unwrap_or_default();
    }

    // Array access with slicing: arr[@]:offset:length  (encoded by parser)
    if let Some(caps) = parse_array_slice_access(name) {
        let (arr_name, subscript, slice_spec) = caps;
        if subscript == "@" || subscript == "*" {
            if let Some(arr) = state.arrays.get(&arr_name) {
                return apply_array_slice(arr, &slice_spec);
            }
        }
        return String::new();
    }

    // Array access: arr[n], arr[@], arr[*]
    if let Some((arr_name, index)) = parse_array_access(name) {
        // Check associative arrays first
        if let Some(assoc) = state.assoc_arrays.get(&arr_name) {
            if index == "@" || index == "*" {
                return assoc.values().cloned().collect::<Vec<_>>().join(" ");
            }
            return assoc.get(&index).cloned().unwrap_or_default();
        }
        // Then indexed arrays
        if let Some(arr) = state.arrays.get(&arr_name) {
            if index == "@" || index == "*" {
                return arr.join(" ");
            }
            if let Ok(mut idx) = index.parse::<isize>() {
                if idx < 0 {
                    idx += arr.len() as isize;
                }
                if idx >= 0 && (idx as usize) < arr.len() {
                    return arr[idx as usize].clone();
                }
            }
            return String::new();
        }
        return String::new();
    }

    // Regular variable lookup
    if let Some(val) = state.env.get(name) {
        return val.clone();
    }

    // Nounset / set -u: error on unbound non-numeric variables
    if state.flags.contains(&ShellFlag::Nounset) {
        // Numeric names are positional params and shouldn't error here
        if name.parse::<usize>().is_err() {
            // In the TypeScript version this throws. We return empty for now
            // since we don't have an error return path in expand_word_part.
            // A future refactor could return Result<String, ShellError>.
            return String::new();
        }
    }

    String::new()
}

/// Generate a pseudo-random number in [0, 32768).
fn random_u15() -> u32 {
    // Simple deterministic-ish random without pulling in a crate.
    // We use the address of a stack variable plus a simple hash.
    // For production correctness we'd want a proper RNG, but for
    // shell $RANDOM this is acceptable.
    let mut x: u32 = 0;
    // Use the address as entropy seed (this is a deliberately simple approach).
    let ptr = &x as *const u32 as usize;
    x = (ptr as u32).wrapping_mul(2654435769);
    x ^= x >> 16;
    x.wrapping_mul(2246822507) % 32768
}

// ---------------------------------------------------------------------------
// Parameter expansion  ${var op default}
// ---------------------------------------------------------------------------

fn expand_param(state: &mut ShellState, var: &str, op: &str, operand: &str) -> String {
    let val = state.env.get(var).cloned();

    match op {
        ":-" => match &val {
            Some(v) if !v.is_empty() => v.clone(),
            _ => operand.to_string(),
        },

        ":=" => match &val {
            Some(v) if !v.is_empty() => v.clone(),
            _ => {
                state.env.insert(var.to_string(), operand.to_string());
                operand.to_string()
            }
        },

        ":+" => match &val {
            Some(v) if !v.is_empty() => operand.to_string(),
            _ => String::new(),
        },

        ":?" => {
            match &val {
                Some(v) if !v.is_empty() => v.clone(),
                _ => {
                    // In the TypeScript version this throws an error.
                    // For now we return the error message as output.
                    // A future refactor could propagate errors.
                    let msg = if operand.is_empty() {
                        "parameter null or not set"
                    } else {
                        operand
                    };
                    format!("{var}: {msg}")
                }
            }
        }

        "#" => {
            // ${#VAR} — string length
            // When var is empty and operand is set, it's ${#operand}
            if var.is_empty() && !operand.is_empty() {
                // Array length: ${#arr[@]}
                if let Some((arr_name, sub)) = parse_array_access(operand) {
                    if sub == "@" || sub == "*" {
                        if let Some(assoc) = state.assoc_arrays.get(&arr_name) {
                            return assoc.len().to_string();
                        }
                        if let Some(arr) = state.arrays.get(&arr_name) {
                            return arr.len().to_string();
                        }
                        return "0".to_string();
                    }
                }
                // String length of variable value: ${#VAR}
                let v = state.env.get(operand).cloned().unwrap_or_default();
                return v.len().to_string();
            }
            // ${VAR#pattern} — trim shortest prefix
            match &val {
                None => String::new(),
                Some(v) => trim_prefix(v, operand, false),
            }
        }

        "##" => match &val {
            None => String::new(),
            Some(v) => trim_prefix(v, operand, true),
        },

        "%" => match &val {
            None => String::new(),
            Some(v) => trim_suffix(v, operand, false),
        },

        "%%" => match &val {
            None => String::new(),
            Some(v) => trim_suffix(v, operand, true),
        },

        "/" => match &val {
            None => String::new(),
            Some(v) => replace_pattern(v, operand, false),
        },

        "//" => match &val {
            None => String::new(),
            Some(v) => replace_pattern(v, operand, true),
        },

        "^^" => val.unwrap_or_default().to_uppercase(),

        ",," => val.unwrap_or_default().to_lowercase(),

        "^" => {
            let s = val.unwrap_or_default();
            let mut chars = s.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => {
                    let upper: String = c.to_uppercase().collect();
                    format!("{upper}{}", chars.as_str())
                }
            }
        }

        "," => {
            let s = val.unwrap_or_default();
            let mut chars = s.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => {
                    let lower: String = c.to_lowercase().collect();
                    format!("{lower}{}", chars.as_str())
                }
            }
        }

        ":" => {
            // Substring / array slicing: ${var:offset} or ${var:offset:length}
            // First check if var is an array reference like arr[@]
            if let Some((arr_name, sub)) = parse_array_access(var) {
                if sub == "@" || sub == "*" {
                    if let Some(arr) = state.arrays.get(&arr_name) {
                        return apply_array_slice(arr, operand);
                    }
                    return String::new();
                }
            }
            let s = val.unwrap_or_default();
            apply_substring(&s, operand)
        }

        // Unknown op — just return the value
        _ => val.unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// Substring helper
// ---------------------------------------------------------------------------

fn apply_substring(s: &str, operand: &str) -> String {
    let parts: Vec<&str> = operand.splitn(2, ':').collect();
    let mut offset = parts[0].parse::<isize>().unwrap_or(0);
    let len = s.len() as isize;

    if offset < 0 {
        offset = (len + offset).max(0);
    }

    let offset = offset as usize;

    if parts.len() > 1 {
        let length = parts[1].parse::<isize>().unwrap_or(0);
        if length < 0 {
            // Negative length means "up to len+length from the end"
            let end_pos = (len + length).max(0) as usize;
            if offset <= s.len() && end_pos <= s.len() && offset <= end_pos {
                return s[offset..end_pos].to_string();
            }
            return String::new();
        }
        let length = length as usize;
        let end = (offset + length).min(s.len());
        if offset <= s.len() {
            return s[offset..end].to_string();
        }
        return String::new();
    }

    if offset <= s.len() {
        s[offset..].to_string()
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Array slice helper
// ---------------------------------------------------------------------------

fn apply_array_slice(arr: &[String], operand: &str) -> String {
    let parts: Vec<&str> = operand.splitn(2, ':').collect();
    let mut offset = parts[0].parse::<isize>().unwrap_or(0);

    if offset < 0 {
        offset = (arr.len() as isize + offset).max(0);
    }
    let offset = offset as usize;

    if parts.len() > 1 {
        let length = parts[1].parse::<usize>().unwrap_or(0);
        let end = (offset + length).min(arr.len());
        if offset <= arr.len() {
            return arr[offset..end].join(" ");
        }
        return String::new();
    }

    if offset <= arr.len() {
        arr[offset..].join(" ")
    } else {
        String::new()
    }
}

// ---------------------------------------------------------------------------
// Array access parsing helpers
// ---------------------------------------------------------------------------

/// Parse `name[subscript]` → Some((name, subscript))
fn parse_array_access(s: &str) -> Option<(String, String)> {
    let open = s.find('[')?;
    if !s.ends_with(']') {
        return None;
    }
    let name = &s[..open];
    let index = &s[open + 1..s.len() - 1];
    if name.is_empty() {
        return None;
    }
    // Verify name is a valid identifier (word chars)
    if !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }
    Some((name.to_string(), index.to_string()))
}

/// Parse `name[subscript]:slice_spec` → Some((name, subscript, slice_spec))
fn parse_array_slice_access(s: &str) -> Option<(String, String, String)> {
    // Look for pattern: word[something]:rest
    let open = s.find('[')?;
    let close = s.find(']')?;
    if close <= open {
        return None;
    }
    // After ']' there must be ':'
    let after_close = &s[close + 1..];
    if !after_close.starts_with(':') {
        return None;
    }
    let name = &s[..open];
    let subscript = &s[open + 1..close];
    let slice_spec = &s[close + 2..]; // skip ']:'

    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_') {
        return None;
    }

    Some((
        name.to_string(),
        subscript.to_string(),
        slice_spec.to_string(),
    ))
}

// ---------------------------------------------------------------------------
// Glob matching (simple shell glob → match)
// ---------------------------------------------------------------------------

/// Match a string against a shell glob pattern.
/// Supports `*` (match any sequence), `?` (match one char), and character
/// classes `[abc]`.
fn glob_matches(pattern: &str, text: &str) -> bool {
    glob_match_inner(pattern.as_bytes(), text.as_bytes())
}

fn glob_match_inner(pat: &[u8], txt: &[u8]) -> bool {
    let mut pi = 0;
    let mut ti = 0;
    let mut star_pi = usize::MAX; // pattern index after last '*'
    let mut star_ti = usize::MAX; // text index at last '*'

    while ti < txt.len() {
        if pi < pat.len() && pat[pi] == b'?' {
            // '?' matches any single character
            pi += 1;
            ti += 1;
        } else if pi < pat.len() && pat[pi] == b'*' {
            // '*' — record position and try matching zero chars
            star_pi = pi + 1;
            star_ti = ti;
            pi += 1;
        } else if pi < pat.len() && pat[pi] == b'[' {
            // Character class
            if let Some((matched, end)) = match_char_class(&pat[pi..], txt[ti]) {
                if matched {
                    pi += end;
                    ti += 1;
                } else if star_pi != usize::MAX {
                    star_ti += 1;
                    pi = star_pi;
                    ti = star_ti;
                } else {
                    return false;
                }
            } else {
                // Malformed class — treat '[' as literal
                if pat[pi] == txt[ti] {
                    pi += 1;
                    ti += 1;
                } else if star_pi != usize::MAX {
                    star_ti += 1;
                    pi = star_pi;
                    ti = star_ti;
                } else {
                    return false;
                }
            }
        } else if pi < pat.len() && pat[pi] == txt[ti] {
            pi += 1;
            ti += 1;
        } else if star_pi != usize::MAX {
            // Backtrack: consume one more char via the last '*'
            star_ti += 1;
            pi = star_pi;
            ti = star_ti;
        } else {
            return false;
        }
    }

    // Skip trailing '*' in pattern
    while pi < pat.len() && pat[pi] == b'*' {
        pi += 1;
    }

    pi == pat.len()
}

/// Try to match a character class at the start of `pat` against `ch`.
/// Returns Some((matched, bytes_consumed)) or None if the class is malformed.
fn match_char_class(pat: &[u8], ch: u8) -> Option<(bool, usize)> {
    if pat.is_empty() || pat[0] != b'[' {
        return None;
    }
    let mut i = 1;
    let mut matched = false;
    let negate = i < pat.len() && (pat[i] == b'!' || pat[i] == b'^');
    if negate {
        i += 1;
    }
    while i < pat.len() && pat[i] != b']' {
        if i + 2 < pat.len() && pat[i + 1] == b'-' && pat[i + 2] != b']' {
            // Range: a-z
            let lo = pat[i];
            let hi = pat[i + 2];
            if ch >= lo && ch <= hi {
                matched = true;
            }
            i += 3;
        } else {
            if pat[i] == ch {
                matched = true;
            }
            i += 1;
        }
    }
    if i >= pat.len() {
        return None; // No closing ']'
    }
    // i is now at ']'
    if negate {
        matched = !matched;
    }
    Some((matched, i + 1))
}

// ---------------------------------------------------------------------------
// Trim prefix / suffix / replace helpers
// ---------------------------------------------------------------------------

/// Remove shortest (greedy=false) or longest (greedy=true) prefix matching
/// the glob pattern.
fn trim_prefix(val: &str, pattern: &str, greedy: bool) -> String {
    if greedy {
        // Try longest prefix first
        for i in (0..=val.len()).rev() {
            if glob_matches(pattern, &val[..i]) {
                return val[i..].to_string();
            }
        }
    } else {
        // Try shortest prefix first
        for i in 0..=val.len() {
            if glob_matches(pattern, &val[..i]) {
                return val[i..].to_string();
            }
        }
    }
    val.to_string()
}

/// Remove shortest (greedy=false) or longest (greedy=true) suffix matching
/// the glob pattern.
fn trim_suffix(val: &str, pattern: &str, greedy: bool) -> String {
    if greedy {
        // Try longest suffix first (start from beginning)
        for i in 0..=val.len() {
            if glob_matches(pattern, &val[i..]) {
                return val[..i].to_string();
            }
        }
    } else {
        // Try shortest suffix first (start from end)
        for i in (0..=val.len()).rev() {
            if glob_matches(pattern, &val[i..]) {
                return val[..i].to_string();
            }
        }
    }
    val.to_string()
}

/// Replace the first (all=false) or all (all=true) occurrences of a glob
/// pattern in `val`.
fn replace_pattern(val: &str, operand: &str, all: bool) -> String {
    let slash_idx = operand.find('/');
    let pattern = match slash_idx {
        Some(idx) => &operand[..idx],
        None => operand,
    };
    let replacement = match slash_idx {
        Some(idx) => &operand[idx + 1..],
        None => "",
    };

    if all {
        let mut result = String::new();
        let mut i = 0;
        while i < val.len() {
            let mut matched = false;
            // Try longest match first
            for j in (i + 1..=val.len()).rev() {
                if glob_matches(pattern, &val[i..j]) {
                    result.push_str(replacement);
                    i = j;
                    matched = true;
                    break;
                }
            }
            if !matched {
                // Advance one character
                if let Some(ch) = val[i..].chars().next() {
                    result.push(ch);
                    i += ch.len_utf8();
                } else {
                    break;
                }
            }
        }
        result
    } else {
        // Replace first occurrence
        for i in 0..val.len() {
            for j in (i + 1..=val.len()).rev() {
                if glob_matches(pattern, &val[i..j]) {
                    return format!("{}{}{}", &val[..i], replacement, &val[j..]);
                }
            }
        }
        val.to_string()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a state with some variables set for testing.
    fn test_state() -> ShellState {
        let mut state = ShellState::new_default();
        state.env.insert("FOO".into(), "hello".into());
        state.env.insert("BAR".into(), "world".into());
        state.env.insert("EMPTY".into(), String::new());
        state
            .env
            .insert("PATH_VAR".into(), "/usr/local/bin:/usr/bin:/bin".into());
        state.env.insert("GREETING".into(), "Hello, World!".into());
        state.env.insert("MIXED".into(), "hElLo WoRlD".into());
        state.positional_args = vec!["arg1".into(), "arg2".into(), "arg3".into()];
        state.last_exit_code = 42;
        state
    }

    // ---- Simple variable lookup ----

    #[test]
    fn simple_variable_lookup() {
        let mut state = test_state();
        let part = WordPart::Variable("FOO".into());
        assert_eq!(expand_word_part(&mut state, &part), "hello");
    }

    #[test]
    fn variable_lookup_missing() {
        let mut state = test_state();
        let part = WordPart::Variable("NONEXISTENT".into());
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    #[test]
    fn variable_lookup_empty() {
        let mut state = test_state();
        let part = WordPart::Variable("EMPTY".into());
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    // ---- Special variables ----

    #[test]
    fn special_var_exit_code() {
        let mut state = test_state();
        let part = WordPart::Variable("?".into());
        assert_eq!(expand_word_part(&mut state, &part), "42");
    }

    #[test]
    fn special_var_arg_count() {
        let mut state = test_state();
        let part = WordPart::Variable("#".into());
        assert_eq!(expand_word_part(&mut state, &part), "3");
    }

    #[test]
    fn special_var_all_args_at() {
        let mut state = test_state();
        let part = WordPart::Variable("@".into());
        assert_eq!(expand_word_part(&mut state, &part), "arg1 arg2 arg3");
    }

    #[test]
    fn special_var_all_args_star() {
        let mut state = test_state();
        let part = WordPart::Variable("*".into());
        assert_eq!(expand_word_part(&mut state, &part), "arg1 arg2 arg3");
    }

    #[test]
    fn special_var_random() {
        let mut state = test_state();
        let part = WordPart::Variable("RANDOM".into());
        let val: u32 = expand_word_part(&mut state, &part).parse().unwrap();
        assert!(val < 32768);
    }

    #[test]
    fn positional_param_1() {
        let mut state = test_state();
        let part = WordPart::Variable("1".into());
        assert_eq!(expand_word_part(&mut state, &part), "arg1");
    }

    #[test]
    fn positional_param_3() {
        let mut state = test_state();
        let part = WordPart::Variable("3".into());
        assert_eq!(expand_word_part(&mut state, &part), "arg3");
    }

    #[test]
    fn positional_param_out_of_range() {
        let mut state = test_state();
        let part = WordPart::Variable("9".into());
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    #[test]
    fn positional_param_zero() {
        let mut state = test_state();
        let part = WordPart::Variable("0".into());
        assert_eq!(expand_word_part(&mut state, &part), "codepod-shell");
    }

    // ---- Parameter expansion: default value (:-, :=, :+, :?) ----

    #[test]
    fn param_default_when_set() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":-".into(),
            default: "fallback".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "hello");
    }

    #[test]
    fn param_default_when_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NOVAR".into(),
            op: ":-".into(),
            default: "fallback".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "fallback");
    }

    #[test]
    fn param_default_when_empty() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "EMPTY".into(),
            op: ":-".into(),
            default: "fallback".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "fallback");
    }

    #[test]
    fn param_assign_when_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NEWVAR".into(),
            op: ":=".into(),
            default: "assigned".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "assigned");
        // Verify the variable was actually set
        assert_eq!(state.env.get("NEWVAR").unwrap(), "assigned");
    }

    #[test]
    fn param_assign_when_set() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":=".into(),
            default: "other".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "hello");
        // Original value preserved
        assert_eq!(state.env.get("FOO").unwrap(), "hello");
    }

    #[test]
    fn param_alternate_when_set() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":+".into(),
            default: "alternate".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "alternate");
    }

    #[test]
    fn param_alternate_when_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NOVAR".into(),
            op: ":+".into(),
            default: "alternate".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    #[test]
    fn param_error_when_set() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":?".into(),
            default: "errmsg".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "hello");
    }

    #[test]
    fn param_error_when_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NOVAR".into(),
            op: ":?".into(),
            default: "custom error".into(),
        };
        let result = expand_word_part(&mut state, &part);
        assert!(result.contains("NOVAR"));
        assert!(result.contains("custom error"));
    }

    // ---- String length (#) ----

    #[test]
    fn string_length() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "".into(),
            op: "#".into(),
            default: "FOO".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "5"); // "hello".len()
    }

    #[test]
    fn string_length_missing() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "".into(),
            op: "#".into(),
            default: "NOVAR".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "0");
    }

    // ---- Prefix removal (#, ##) ----

    #[test]
    fn trim_shortest_prefix() {
        let mut state = test_state();
        // ${PATH_VAR#/*/} — remove shortest prefix matching /*/
        let part = WordPart::ParamExpansion {
            var: "PATH_VAR".into(),
            op: "#".into(),
            default: "/*/".into(),
        };
        let result = expand_word_part(&mut state, &part);
        // /usr/local/bin:/usr/bin:/bin with shortest prefix /*/  → match /usr/
        assert_eq!(result, "local/bin:/usr/bin:/bin");
    }

    #[test]
    fn trim_longest_prefix() {
        let mut state = test_state();
        // ${PATH_VAR##/*/} — remove longest prefix matching /*/
        let part = WordPart::ParamExpansion {
            var: "PATH_VAR".into(),
            op: "##".into(),
            default: "/*/".into(),
        };
        let result = expand_word_part(&mut state, &part);
        // Longest prefix matching /*/ from /usr/local/bin:/usr/bin:/bin
        // is /usr/local/bin:/usr/bin:/
        assert_eq!(result, "bin");
    }

    // ---- Suffix removal (%, %%) ----

    #[test]
    fn trim_shortest_suffix() {
        let mut state = test_state();
        // ${PATH_VAR%:*} — remove shortest suffix matching :*
        let part = WordPart::ParamExpansion {
            var: "PATH_VAR".into(),
            op: "%".into(),
            default: ":*".into(),
        };
        let result = expand_word_part(&mut state, &part);
        assert_eq!(result, "/usr/local/bin:/usr/bin");
    }

    #[test]
    fn trim_longest_suffix() {
        let mut state = test_state();
        // ${PATH_VAR%%:*} — remove longest suffix matching :*
        let part = WordPart::ParamExpansion {
            var: "PATH_VAR".into(),
            op: "%%".into(),
            default: ":*".into(),
        };
        let result = expand_word_part(&mut state, &part);
        assert_eq!(result, "/usr/local/bin");
    }

    // ---- Pattern replacement (/, //) ----

    #[test]
    fn replace_first() {
        let mut state = test_state();
        // ${FOO/l/L} — replace first 'l' with 'L'
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: "/".into(),
            default: "l/L".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "heLlo");
    }

    #[test]
    fn replace_all() {
        let mut state = test_state();
        // ${FOO//l/L} — replace all 'l' with 'L'
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: "//".into(),
            default: "l/L".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "heLLo");
    }

    #[test]
    fn replace_with_empty() {
        let mut state = test_state();
        // ${FOO//l/} — delete all 'l'
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: "//".into(),
            default: "l/".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "heo");
    }

    // ---- Case conversion (^^, ,,, ^, ,) ----

    #[test]
    fn case_all_upper() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: "^^".into(),
            default: "".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "HELLO");
    }

    #[test]
    fn case_all_lower() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "MIXED".into(),
            op: ",,".into(),
            default: "".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "hello world");
    }

    #[test]
    fn case_first_upper() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: "^".into(),
            default: "".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "Hello");
    }

    #[test]
    fn case_first_lower() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "GREETING".into(),
            op: ",".into(),
            default: "".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "hello, World!");
    }

    // ---- Substring (:offset:length) ----

    #[test]
    fn substring_offset() {
        let mut state = test_state();
        // ${FOO:2} → "llo"
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":".into(),
            default: "2".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "llo");
    }

    #[test]
    fn substring_offset_length() {
        let mut state = test_state();
        // ${FOO:1:3} → "ell"
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":".into(),
            default: "1:3".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "ell");
    }

    #[test]
    fn substring_negative_offset() {
        let mut state = test_state();
        // ${FOO:-2} would conflict with :- default, but ${FOO: -2} parses as
        // offset=-2 (last 2 chars).
        // In our AST this arrives as op=":" operand="-2"
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":".into(),
            default: "-2".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "lo");
    }

    #[test]
    fn substring_negative_length() {
        let mut state = test_state();
        // ${FOO:1:-1} → "ell" (offset=1, end=len-1=4, so "ello"[..4-1]? no)
        // Actually: offset=1, length=-1 means end=5+(-1)=4, so s[1..4]="ell"
        let part = WordPart::ParamExpansion {
            var: "FOO".into(),
            op: ":".into(),
            default: "1:-1".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "ell");
    }

    // ---- Array access ----

    #[test]
    fn array_element_access() {
        let mut state = test_state();
        state
            .arrays
            .insert("arr".into(), vec!["a".into(), "b".into(), "c".into()]);
        let part = WordPart::Variable("arr[1]".into());
        assert_eq!(expand_word_part(&mut state, &part), "b");
    }

    #[test]
    fn array_all_elements() {
        let mut state = test_state();
        state
            .arrays
            .insert("arr".into(), vec!["a".into(), "b".into(), "c".into()]);
        let part = WordPart::Variable("arr[@]".into());
        assert_eq!(expand_word_part(&mut state, &part), "a b c");
    }

    #[test]
    fn array_star_elements() {
        let mut state = test_state();
        state
            .arrays
            .insert("arr".into(), vec!["x".into(), "y".into()]);
        let part = WordPart::Variable("arr[*]".into());
        assert_eq!(expand_word_part(&mut state, &part), "x y");
    }

    #[test]
    fn array_negative_index() {
        let mut state = test_state();
        state
            .arrays
            .insert("arr".into(), vec!["a".into(), "b".into(), "c".into()]);
        let part = WordPart::Variable("arr[-1]".into());
        assert_eq!(expand_word_part(&mut state, &part), "c");
    }

    #[test]
    fn array_length() {
        let mut state = test_state();
        state
            .arrays
            .insert("arr".into(), vec!["a".into(), "b".into(), "c".into()]);
        let part = WordPart::ParamExpansion {
            var: "".into(),
            op: "#".into(),
            default: "arr[@]".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "3");
    }

    #[test]
    fn array_slice() {
        let mut state = test_state();
        state.arrays.insert(
            "arr".into(),
            vec!["a".into(), "b".into(), "c".into(), "d".into(), "e".into()],
        );
        // ${arr[@]:1:3} → "b c d"
        let part = WordPart::ParamExpansion {
            var: "arr[@]".into(),
            op: ":".into(),
            default: "1:3".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "b c d");
    }

    #[test]
    fn array_slice_via_variable_syntax() {
        let mut state = test_state();
        state.arrays.insert(
            "arr".into(),
            vec!["a".into(), "b".into(), "c".into(), "d".into(), "e".into()],
        );
        // arr[@]:2:2 encoded in Variable name (parser format for $arr[@]:offset:length)
        let part = WordPart::Variable("arr[@]:2:2".into());
        assert_eq!(expand_word_part(&mut state, &part), "c d");
    }

    #[test]
    fn assoc_array_access() {
        let mut state = test_state();
        let mut assoc = std::collections::HashMap::new();
        assoc.insert("key1".into(), "val1".into());
        assoc.insert("key2".into(), "val2".into());
        state.assoc_arrays.insert("map".into(), assoc);

        let part = WordPart::Variable("map[key1]".into());
        assert_eq!(expand_word_part(&mut state, &part), "val1");
    }

    #[test]
    fn assoc_array_missing_key() {
        let mut state = test_state();
        let mut assoc = std::collections::HashMap::new();
        assoc.insert("key1".into(), "val1".into());
        state.assoc_arrays.insert("map".into(), assoc);

        let part = WordPart::Variable("map[missing]".into());
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    // ---- Tilde expansion ----

    #[test]
    fn tilde_alone() {
        let mut state = test_state();
        let part = WordPart::Literal("~".into());
        assert_eq!(expand_word_part(&mut state, &part), "/home/user");
    }

    #[test]
    fn tilde_slash() {
        let mut state = test_state();
        let part = WordPart::Literal("~/documents".into());
        assert_eq!(expand_word_part(&mut state, &part), "/home/user/documents");
    }

    #[test]
    fn tilde_custom_home() {
        let mut state = test_state();
        state.env.insert("HOME".into(), "/custom/home".into());
        let part = WordPart::Literal("~/bin".into());
        assert_eq!(expand_word_part(&mut state, &part), "/custom/home/bin");
    }

    #[test]
    fn no_tilde_in_middle() {
        let mut state = test_state();
        let part = WordPart::Literal("foo~bar".into());
        assert_eq!(expand_word_part(&mut state, &part), "foo~bar");
    }

    // ---- Word splitting ----

    #[test]
    fn word_splitting_on_variable() {
        let mut state = test_state();
        state.env.insert("WORDS".into(), "one  two   three".into());
        let words = vec![Word {
            parts: vec![WordPart::Variable("WORDS".into())],
        }];
        let result = expand_words_with_splitting(&mut state, &words);
        assert_eq!(result, vec!["one", "two", "three"]);
    }

    #[test]
    fn no_splitting_on_quoted() {
        let mut state = test_state();
        state.env.insert("WORDS".into(), "one  two   three".into());
        // A word with both Variable and QuotedLiteral should not split
        let words = vec![Word {
            parts: vec![
                WordPart::QuotedLiteral(String::new()),
                WordPart::Variable("WORDS".into()),
            ],
        }];
        let result = expand_words_with_splitting(&mut state, &words);
        assert_eq!(result, vec!["one  two   three"]);
    }

    #[test]
    fn splitting_preserves_literal_words() {
        let mut state = test_state();
        let words = vec![
            Word {
                parts: vec![WordPart::Literal("hello".into())],
            },
            Word {
                parts: vec![WordPart::Literal("world".into())],
            },
        ];
        let result = expand_words_with_splitting(&mut state, &words);
        assert_eq!(result, vec!["hello", "world"]);
    }

    // ---- Word expansion ----

    #[test]
    fn expand_word_concatenates_parts() {
        let mut state = test_state();
        let word = Word {
            parts: vec![
                WordPart::Literal("prefix_".into()),
                WordPart::Variable("FOO".into()),
                WordPart::Literal("_suffix".into()),
            ],
        };
        assert_eq!(expand_word(&mut state, &word), "prefix_hello_suffix");
    }

    // ---- Nounset (set -u) ----

    #[test]
    fn nounset_unbound_returns_empty() {
        let mut state = test_state();
        state.flags.insert(ShellFlag::Nounset);
        let part = WordPart::Variable("UNBOUND".into());
        // Currently returns empty; future: should propagate error
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    #[test]
    fn nounset_bound_returns_value() {
        let mut state = test_state();
        state.flags.insert(ShellFlag::Nounset);
        let part = WordPart::Variable("FOO".into());
        assert_eq!(expand_word_part(&mut state, &part), "hello");
    }

    // ---- Quoted literal brace protection ----

    #[test]
    fn quoted_literal_brace_protection() {
        let mut state = test_state();
        let part = WordPart::QuotedLiteral("a{b}c".into());
        assert_eq!(expand_word_part(&mut state, &part), "a\u{E000}b\u{E001}c");
    }

    // ---- CommandSub / ArithmeticExpansion / ProcessSub stubs ----

    #[test]
    fn command_sub_returns_empty() {
        let mut state = test_state();
        let part = WordPart::CommandSub("echo hi".into());
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    #[test]
    fn arithmetic_expansion_returns_empty() {
        let mut state = test_state();
        let part = WordPart::ArithmeticExpansion("1+1".into());
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    #[test]
    fn process_sub_returns_empty() {
        let mut state = test_state();
        let part = WordPart::ProcessSub("echo hi".into());
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    // ---- Glob matching (internal) ----

    #[test]
    fn glob_star() {
        assert!(glob_matches("*", "anything"));
        assert!(glob_matches("*", ""));
        assert!(glob_matches("he*lo", "hello"));
        assert!(glob_matches("he*lo", "helo"));
        assert!(glob_matches("he*lo", "heXXXlo"));
        assert!(!glob_matches("he*lo", "hexyz"));
    }

    #[test]
    fn glob_question() {
        assert!(glob_matches("h?llo", "hello"));
        assert!(!glob_matches("h?llo", "hllo"));
        assert!(!glob_matches("h?llo", "heello"));
    }

    #[test]
    fn glob_char_class() {
        assert!(glob_matches("[abc]", "a"));
        assert!(glob_matches("[abc]", "b"));
        assert!(!glob_matches("[abc]", "d"));
        assert!(glob_matches("[a-z]", "m"));
        assert!(!glob_matches("[a-z]", "M"));
    }

    #[test]
    fn glob_negated_class() {
        assert!(!glob_matches("[!abc]", "a"));
        assert!(glob_matches("[!abc]", "d"));
    }

    // ---- Param expansion on unset var ----

    #[test]
    fn param_prefix_on_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NOVAR".into(),
            op: "#".into(),
            default: "*".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    #[test]
    fn param_suffix_on_unset() {
        let mut state = test_state();
        let part = WordPart::ParamExpansion {
            var: "NOVAR".into(),
            op: "%".into(),
            default: "*".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "");
    }

    // ---- Replace with glob pattern ----

    #[test]
    fn replace_with_glob_pattern() {
        let mut state = test_state();
        state.env.insert("FILE".into(), "photo.jpg".into());
        // ${FILE/*.jpg/.png} — replace .jpg extension
        let part = WordPart::ParamExpansion {
            var: "FILE".into(),
            op: "/".into(),
            default: "*.jpg/.png".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), ".png");
    }

    // ---- Assoc array all values ----

    #[test]
    fn assoc_array_all_values() {
        let mut state = test_state();
        let mut assoc = std::collections::HashMap::new();
        assoc.insert("a".into(), "1".into());
        state.assoc_arrays.insert("m".into(), assoc);

        let part = WordPart::Variable("m[@]".into());
        assert_eq!(expand_word_part(&mut state, &part), "1");
    }

    // ---- Assoc array length ----

    #[test]
    fn assoc_array_length() {
        let mut state = test_state();
        let mut assoc = std::collections::HashMap::new();
        assoc.insert("x".into(), "1".into());
        assoc.insert("y".into(), "2".into());
        state.assoc_arrays.insert("m".into(), assoc);

        let part = WordPart::ParamExpansion {
            var: "".into(),
            op: "#".into(),
            default: "m[@]".into(),
        };
        assert_eq!(expand_word_part(&mut state, &part), "2");
    }

    // ---- word_needs_splitting logic ----

    #[test]
    fn word_needs_splitting_with_variable() {
        let word = Word {
            parts: vec![WordPart::Variable("X".into())],
        };
        assert!(word_needs_splitting(&word));
    }

    #[test]
    fn word_needs_splitting_literal_only() {
        let word = Word {
            parts: vec![WordPart::Literal("hello world".into())],
        };
        assert!(!word_needs_splitting(&word));
    }

    #[test]
    fn word_needs_splitting_quoted_variable() {
        let word = Word {
            parts: vec![
                WordPart::QuotedLiteral(String::new()),
                WordPart::Variable("X".into()),
            ],
        };
        assert!(!word_needs_splitting(&word));
    }
}
