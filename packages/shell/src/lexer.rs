use crate::token::{RedirectType, Token};

/// Tokenize a shell command string into a vector of tokens.
pub fn lex(input: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut pos = 0;

    while pos < len {
        // Skip whitespace (but not newlines)
        if chars[pos] == ' ' || chars[pos] == '\t' {
            pos += 1;
            continue;
        }

        // Newline
        if chars[pos] == '\n' {
            tokens.push(Token::Newline);
            pos += 1;
            continue;
        }

        // Semicolon
        if chars[pos] == ';' {
            tokens.push(Token::Semi);
            pos += 1;
            continue;
        }

        // Parentheses
        if chars[pos] == '(' {
            tokens.push(Token::LParen);
            pos += 1;
            continue;
        }
        if chars[pos] == ')' {
            tokens.push(Token::RParen);
            pos += 1;
            continue;
        }

        // && or &> or lone &
        if chars[pos] == '&' {
            if pos + 1 < len && chars[pos + 1] == '&' {
                tokens.push(Token::And);
                pos += 2;
                continue;
            }
            if pos + 1 < len && chars[pos + 1] == '>' {
                // &> file
                pos += 2;
                skip_whitespace(&chars, &mut pos);
                let target = read_redirect_target(&chars, &mut pos);
                tokens.push(Token::Redirect(RedirectType::BothOverwrite(target)));
                continue;
            }
            // Lone & — treat as a word for now
            pos += 1;
            continue;
        }

        // || or |
        if chars[pos] == '|' {
            if pos + 1 < len && chars[pos + 1] == '|' {
                tokens.push(Token::Or);
                pos += 2;
            } else {
                tokens.push(Token::Pipe);
                pos += 1;
            }
            continue;
        }

        // 2>&1, 2>file, 2>>file
        if chars[pos] == '2' && pos + 1 < len && (chars[pos + 1] == '>' || chars[pos + 1] == '<') {
            if chars[pos + 1] == '>' {
                if pos + 3 < len && chars[pos + 2] == '&' && chars[pos + 3] == '1' {
                    tokens.push(Token::Redirect(RedirectType::StderrToStdout));
                    pos += 4;
                    continue;
                }
                if pos + 2 < len && chars[pos + 2] == '>' {
                    // 2>> file
                    pos += 3;
                    skip_whitespace(&chars, &mut pos);
                    let target = read_redirect_target(&chars, &mut pos);
                    tokens.push(Token::Redirect(RedirectType::StderrAppend(target)));
                    continue;
                }
                // 2> file
                pos += 2;
                skip_whitespace(&chars, &mut pos);
                let target = read_redirect_target(&chars, &mut pos);
                tokens.push(Token::Redirect(RedirectType::StderrOverwrite(target)));
                continue;
            }
        }

        // > or >> or < redirects
        if chars[pos] == '>' {
            if pos + 1 < len && chars[pos + 1] == '>' {
                pos += 2;
                skip_whitespace(&chars, &mut pos);
                let target = read_redirect_target(&chars, &mut pos);
                tokens.push(Token::Redirect(RedirectType::StdoutAppend(target)));
            } else {
                pos += 1;
                skip_whitespace(&chars, &mut pos);
                let target = read_redirect_target(&chars, &mut pos);
                tokens.push(Token::Redirect(RedirectType::StdoutOverwrite(target)));
            }
            continue;
        }
        if chars[pos] == '<' {
            pos += 1;
            skip_whitespace(&chars, &mut pos);
            let target = read_redirect_target(&chars, &mut pos);
            tokens.push(Token::Redirect(RedirectType::StdinFrom(target)));
            continue;
        }

        // $ — variable or command substitution
        if chars[pos] == '$' {
            pos += 1;
            if pos < len && chars[pos] == '(' {
                // Command substitution: $(...)
                pos += 1; // skip '('
                let content = read_balanced_parens(&chars, &mut pos);
                tokens.push(Token::CommandSub(content));
                continue;
            }
            if pos < len && chars[pos] == '{' {
                // Braced variable: ${...}
                pos += 1; // skip '{'
                let var = read_until_char(&chars, &mut pos, '}');
                // Strip the modifier portion for simple names: ${VAR} -> "VAR"
                // For ${VAR:-default}, preserve the full content
                tokens.push(Token::Variable(var));
                continue;
            }
            // Special variables: $?, $$, $!, $#, $@, $*, $0-$9
            if pos < len && "?$!#@*".contains(chars[pos]) {
                let var = chars[pos].to_string();
                pos += 1;
                tokens.push(Token::Variable(var));
                continue;
            }
            if pos < len && chars[pos].is_ascii_digit() {
                let var = chars[pos].to_string();
                pos += 1;
                tokens.push(Token::Variable(var));
                continue;
            }
            // Simple variable: $NAME
            let var = read_var_name(&chars, &mut pos);
            tokens.push(Token::Variable(var));
            continue;
        }

        // Backtick command substitution
        if chars[pos] == '`' {
            pos += 1; // skip opening backtick
            let content = read_until_char(&chars, &mut pos, '`');
            tokens.push(Token::CommandSub(content));
            continue;
        }

        // Single-quoted string
        if chars[pos] == '\'' {
            pos += 1; // skip opening quote
            let content = read_until_char(&chars, &mut pos, '\'');
            tokens.push(Token::Word(content));
            continue;
        }

        // Double-quoted string
        if chars[pos] == '"' {
            pos += 1; // skip opening quote
            let content = read_double_quoted(&chars, &mut pos);
            tokens.push(Token::Word(content));
            continue;
        }

        // Word (possibly containing escape sequences or an assignment)
        let word = read_word(&chars, &mut pos);
        if !word.is_empty() {
            tokens.push(classify_word(word));
        }
    }

    tokens
}

/// Advance `pos` past any spaces and tabs.
fn skip_whitespace(chars: &[char], pos: &mut usize) {
    while *pos < chars.len() && (chars[*pos] == ' ' || chars[*pos] == '\t') {
        *pos += 1;
    }
}

/// Read an unquoted word for a redirect target (stops at whitespace and operators).
fn read_redirect_target(chars: &[char], pos: &mut usize) -> String {
    let mut result = String::new();
    while *pos < chars.len() {
        let ch = chars[*pos];
        if ch == ' ' || ch == '\t' || ch == '\n' || ch == ';' || ch == '|' || ch == '&'
            || ch == '>' || ch == '<' || ch == '(' || ch == ')'
        {
            break;
        }
        result.push(ch);
        *pos += 1;
    }
    result
}

/// Read until a matching close parenthesis, handling nesting.
fn read_balanced_parens(chars: &[char], pos: &mut usize) -> String {
    let mut result = String::new();
    let mut depth = 1;
    while *pos < chars.len() && depth > 0 {
        let ch = chars[*pos];
        if ch == '(' {
            depth += 1;
        } else if ch == ')' {
            depth -= 1;
            if depth == 0 {
                *pos += 1; // skip closing ')'
                break;
            }
        }
        result.push(ch);
        *pos += 1;
    }
    result
}

/// Read characters until `terminator` is found. Consumes the terminator.
fn read_until_char(chars: &[char], pos: &mut usize, terminator: char) -> String {
    let mut result = String::new();
    while *pos < chars.len() && chars[*pos] != terminator {
        result.push(chars[*pos]);
        *pos += 1;
    }
    if *pos < chars.len() {
        *pos += 1; // skip terminator
    }
    result
}

/// Read a simple variable name (alphanumeric + underscore).
fn read_var_name(chars: &[char], pos: &mut usize) -> String {
    let mut name = String::new();
    while *pos < chars.len() && (chars[*pos].is_alphanumeric() || chars[*pos] == '_') {
        name.push(chars[*pos]);
        *pos += 1;
    }
    name
}

/// Read the contents of a double-quoted string.
/// Handles backslash escapes for `$`, `"`, `\`, and `` ` ``.
fn read_double_quoted(chars: &[char], pos: &mut usize) -> String {
    let mut result = String::new();
    while *pos < chars.len() && chars[*pos] != '"' {
        if chars[*pos] == '\\' && *pos + 1 < chars.len() {
            let next = chars[*pos + 1];
            if next == '$' || next == '"' || next == '\\' || next == '`' {
                result.push(next);
                *pos += 2;
                continue;
            }
        }
        result.push(chars[*pos]);
        *pos += 1;
    }
    if *pos < chars.len() {
        *pos += 1; // skip closing '"'
    }
    result
}

/// Read an unquoted word, handling backslash escapes.
///
/// When the word contains `=` (making it an assignment like `X=value`), the
/// value portion may include `$(cmd)` or `$VAR` which should be kept inline
/// so that `classify_word` produces a single `Assignment` token.
fn read_word(chars: &[char], pos: &mut usize) -> String {
    let mut word = String::new();
    let mut seen_eq = false;
    while *pos < chars.len() {
        let ch = chars[*pos];

        // Stop at word boundaries (but handle $ specially after = for assignments)
        if ch == ' ' || ch == '\t' || ch == '\n' || ch == ';' || ch == '|' || ch == '&'
            || ch == '>' || ch == '<' || ch == '(' || ch == ')'
            || ch == '\'' || ch == '"'
        {
            break;
        }

        // Track = for assignment detection
        if ch == '=' && !seen_eq {
            seen_eq = true;
            word.push(ch);
            *pos += 1;
            continue;
        }

        // $ and ` are word boundaries unless we're in the value of an assignment
        if (ch == '$' || ch == '`') && !seen_eq {
            break;
        }

        // If in assignment value and we see $( or $VAR, include inline
        if ch == '$' && seen_eq {
            if *pos + 1 < chars.len() && chars[*pos + 1] == '(' {
                // Include $(cmd) in the word
                word.push('$');
                word.push('(');
                *pos += 2;
                let content = read_balanced_parens(chars, pos);
                word.push_str(&content);
                word.push(')');
                continue;
            }
            if *pos + 1 < chars.len() && chars[*pos + 1] == '{' {
                // Include ${VAR} in the word
                word.push('$');
                word.push('{');
                *pos += 2;
                let content = read_until_char(chars, pos, '}');
                word.push_str(&content);
                word.push('}');
                continue;
            }
            // Simple $VAR
            word.push('$');
            *pos += 1;
            let var_name = read_var_name(chars, pos);
            word.push_str(&var_name);
            continue;
        }

        // Backtick in assignment value
        if ch == '`' && seen_eq {
            word.push('`');
            *pos += 1;
            let content = read_until_char(chars, pos, '`');
            word.push_str(&content);
            word.push('`');
            continue;
        }

        // Backslash escape
        if ch == '\\' && *pos + 1 < chars.len() {
            *pos += 1;
            word.push(chars[*pos]);
            *pos += 1;
            continue;
        }

        word.push(ch);
        *pos += 1;
    }
    word
}

/// Classify a plain word as a keyword, assignment, or plain word.
fn classify_word(word: String) -> Token {
    match word.as_str() {
        "if" => Token::If,
        "then" => Token::Then,
        "elif" => Token::Elif,
        "else" => Token::Else,
        "fi" => Token::Fi,
        "for" => Token::For,
        "in" => Token::In,
        "do" => Token::Do,
        "done" => Token::Done,
        "while" => Token::While,
        _ => {
            if let Some(eq_pos) = word.find('=') {
                let name = &word[..eq_pos];
                if !name.is_empty() && is_valid_var_name(name) {
                    let value = word[eq_pos + 1..].to_string();
                    return Token::Assignment(name.to_string(), value);
                }
            }
            Token::Word(word)
        }
    }
}

/// Check whether `name` is a valid shell variable name (starts with letter or
/// underscore, then alphanumeric or underscore).
fn is_valid_var_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::token::*;

    #[test]
    fn simple_command() {
        let tokens = lex("echo hello world");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello".into()),
                Token::Word("world".into()),
            ]
        );
    }

    #[test]
    fn pipe() {
        let tokens = lex("cat file | grep pattern");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cat".into()),
                Token::Word("file".into()),
                Token::Pipe,
                Token::Word("grep".into()),
                Token::Word("pattern".into()),
            ]
        );
    }

    #[test]
    fn operators() {
        let tokens = lex("cmd1 && cmd2 || cmd3 ; cmd4");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cmd1".into()),
                Token::And,
                Token::Word("cmd2".into()),
                Token::Or,
                Token::Word("cmd3".into()),
                Token::Semi,
                Token::Word("cmd4".into()),
            ]
        );
    }

    #[test]
    fn single_quotes() {
        let tokens = lex("echo 'hello world'");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello world".into()),
            ]
        );
    }

    #[test]
    fn double_quotes_plain() {
        let tokens = lex(r#"echo "hello world""#);
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello world".into()),
            ]
        );
    }

    #[test]
    fn variable_reference() {
        let tokens = lex("echo $HOME");
        assert_eq!(
            tokens,
            vec![Token::Word("echo".into()), Token::Variable("HOME".into()),]
        );
    }

    #[test]
    fn variable_braces() {
        let tokens = lex("echo ${HOME}");
        assert_eq!(
            tokens,
            vec![Token::Word("echo".into()), Token::Variable("HOME".into()),]
        );
    }

    #[test]
    fn command_substitution() {
        let tokens = lex("echo $(date)");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::CommandSub("date".into()),
            ]
        );
    }

    #[test]
    fn redirect_stdout() {
        let tokens = lex("echo hello > file.txt");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello".into()),
                Token::Redirect(RedirectType::StdoutOverwrite("file.txt".into())),
            ]
        );
    }

    #[test]
    fn redirect_append() {
        let tokens = lex("echo hello >> file.txt");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello".into()),
                Token::Redirect(RedirectType::StdoutAppend("file.txt".into())),
            ]
        );
    }

    #[test]
    fn redirect_stderr_to_stdout() {
        let tokens = lex("cmd 2>&1");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cmd".into()),
                Token::Redirect(RedirectType::StderrToStdout),
            ]
        );
    }

    #[test]
    fn assignment() {
        let tokens = lex("FOO=bar");
        assert_eq!(
            tokens,
            vec![Token::Assignment("FOO".into(), "bar".into()),]
        );
    }

    #[test]
    fn parens() {
        let tokens = lex("( cmd1 ; cmd2 )");
        assert_eq!(
            tokens,
            vec![
                Token::LParen,
                Token::Word("cmd1".into()),
                Token::Semi,
                Token::Word("cmd2".into()),
                Token::RParen,
            ]
        );
    }

    #[test]
    fn keywords() {
        let tokens = lex("if true; then echo yes; fi");
        assert_eq!(
            tokens,
            vec![
                Token::If,
                Token::Word("true".into()),
                Token::Semi,
                Token::Then,
                Token::Word("echo".into()),
                Token::Word("yes".into()),
                Token::Semi,
                Token::Fi,
            ]
        );
    }

    #[test]
    fn for_loop() {
        let tokens = lex("for x in a b c; do echo $x; done");
        assert_eq!(
            tokens,
            vec![
                Token::For,
                Token::Word("x".into()),
                Token::In,
                Token::Word("a".into()),
                Token::Word("b".into()),
                Token::Word("c".into()),
                Token::Semi,
                Token::Do,
                Token::Word("echo".into()),
                Token::Variable("x".into()),
                Token::Semi,
                Token::Done,
            ]
        );
    }

    #[test]
    fn backtick_substitution() {
        let tokens = lex("echo `date`");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::CommandSub("date".into()),
            ]
        );
    }

    #[test]
    fn escaped_space() {
        let tokens = lex(r"echo hello\ world");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello world".into()),
            ]
        );
    }

    #[test]
    fn stdin_redirect() {
        let tokens = lex("cmd < input.txt");
        assert_eq!(
            tokens,
            vec![
                Token::Word("cmd".into()),
                Token::Redirect(RedirectType::StdinFrom("input.txt".into())),
            ]
        );
    }
}
