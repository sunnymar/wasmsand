use crate::ast::WordPart;
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

        // Comments — skip from # to end of line
        if chars[pos] == '#' {
            while pos < len && chars[pos] != '\n' {
                pos += 1;
            }
            continue; // don't consume newline, let normal processing handle it
        }

        // Semicolon or ;;
        if chars[pos] == ';' {
            if pos + 1 < len && chars[pos + 1] == ';' {
                tokens.push(Token::DoubleSemi);
                pos += 2;
                continue;
            }
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

        // Braces
        if chars[pos] == '{' {
            tokens.push(Token::LBrace);
            pos += 1;
            continue;
        }
        if chars[pos] == '}' {
            tokens.push(Token::RBrace);
            pos += 1;
            continue;
        }

        // Bang (pipeline negation) — standalone ! at command start position
        // Only emit Bang if it's the first token or follows a pipe/semi/newline/&&/||/(
        if chars[pos] == '!' && (pos + 1 >= len || chars[pos + 1] == ' ' || chars[pos + 1] == '\t')
        {
            let mut is_command_start = tokens.is_empty();
            if !is_command_start {
                if let Some(last) = tokens.last() {
                    is_command_start = matches!(
                        last,
                        Token::Pipe
                            | Token::And
                            | Token::Or
                            | Token::Semi
                            | Token::Newline
                            | Token::LParen
                            | Token::Do
                            | Token::Then
                            | Token::Else
                            | Token::LBrace
                            | Token::DoubleSemi
                    );
                }
            }
            if is_command_start {
                tokens.push(Token::Bang);
                pos += 1;
                continue;
            }
            // Otherwise fall through to be read as a word
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
        if chars[pos] == '2' && pos + 1 < len && chars[pos + 1] == '>' {
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
            if pos + 1 < len && chars[pos + 1] == '<' {
                // Here-document: <<EOF or <<-EOF
                pos += 2;
                let strip_tabs = pos < len && chars[pos] == '-';
                if strip_tabs {
                    pos += 1;
                }
                skip_whitespace(&chars, &mut pos);

                // Read delimiter (may be quoted with ' or ")
                let (delimiter, _quoted) = read_heredoc_delimiter(&chars, &mut pos);

                // Skip to next newline, then read content lines until delimiter
                while pos < len && chars[pos] != '\n' {
                    pos += 1;
                }
                if pos < len {
                    pos += 1;
                } // skip newline

                let mut content = String::new();
                loop {
                    if pos >= len {
                        break;
                    }
                    let line_start = pos;
                    while pos < len && chars[pos] != '\n' {
                        pos += 1;
                    }
                    let line: String = chars[line_start..pos].iter().collect();
                    let trimmed = if strip_tabs {
                        line.trim_start_matches('\t')
                    } else {
                        &line
                    };
                    if trimmed.trim() == delimiter {
                        if pos < len {
                            pos += 1;
                        } // skip delimiter newline
                        break;
                    }
                    content.push_str(&line);
                    content.push('\n');
                    if pos < len {
                        pos += 1;
                    } else {
                        break;
                    }
                }

                let rtype = if strip_tabs {
                    RedirectType::HeredocStrip(content)
                } else {
                    RedirectType::Heredoc(content)
                };
                tokens.push(Token::Redirect(rtype));
                continue;
            }
            pos += 1;
            skip_whitespace(&chars, &mut pos);
            let target = read_redirect_target(&chars, &mut pos);
            tokens.push(Token::Redirect(RedirectType::StdinFrom(target)));
            continue;
        }

        // $ — variable, command substitution, or arithmetic
        if chars[pos] == '$' {
            pos += 1;
            if pos < len && chars[pos] == '(' {
                if pos + 1 < len && chars[pos + 1] == '(' {
                    // Arithmetic: $((...))
                    pos += 2;
                    let mut depth = 1;
                    let mut expr = String::new();
                    while pos < len && depth > 0 {
                        if chars[pos] == '(' {
                            depth += 1;
                        }
                        if chars[pos] == ')' {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        expr.push(chars[pos]);
                        pos += 1;
                    }
                    if pos < len {
                        pos += 1;
                    } // skip inner )
                    if pos < len && chars[pos] == ')' {
                        pos += 1;
                    } // skip outer )
                    tokens.push(Token::DoubleQuoted(vec![WordPart::ArithmeticExpansion(
                        expr,
                    )]));
                    continue;
                }
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
                let part = parse_braced_var(&var);
                match part {
                    WordPart::Variable(_) => tokens.push(Token::Variable(match part {
                        WordPart::Variable(v) => v,
                        _ => unreachable!(),
                    })),
                    _ => tokens.push(Token::DoubleQuoted(vec![part])),
                }
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

        // Double-quoted string — parse $VAR and $(cmd) interpolations
        if chars[pos] == '"' {
            pos += 1; // skip opening quote
            let parts = lex_double_quoted(&chars, &mut pos);
            // Optimize: if there's a single literal part, emit a plain Word token
            if parts.len() == 1 {
                if let WordPart::Literal(ref s) = parts[0] {
                    tokens.push(Token::Word(s.clone()));
                    continue;
                }
            }
            tokens.push(Token::DoubleQuoted(parts));
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
        if ch == ' '
            || ch == '\t'
            || ch == '\n'
            || ch == ';'
            || ch == '|'
            || ch == '&'
            || ch == '>'
            || ch == '<'
            || ch == '('
            || ch == ')'
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

/// Lex the inside of a double-quoted string into a sequence of WordParts.
/// Handles `$VAR`, `${VAR}`, `$(cmd)`, backtick substitution, and backslash
/// escapes for `$`, `"`, `\`, and `` ` ``.
fn lex_double_quoted(chars: &[char], pos: &mut usize) -> Vec<WordPart> {
    let mut parts: Vec<WordPart> = Vec::new();
    let mut literal = String::new();

    while *pos < chars.len() && chars[*pos] != '"' {
        // Backslash escape
        if chars[*pos] == '\\' && *pos + 1 < chars.len() {
            let next = chars[*pos + 1];
            if next == '$' || next == '"' || next == '\\' || next == '`' {
                literal.push(next);
                *pos += 2;
                continue;
            }
        }

        // $ — variable or command substitution
        if chars[*pos] == '$' {
            // Flush accumulated literal text
            if !literal.is_empty() {
                parts.push(WordPart::Literal(std::mem::take(&mut literal)));
            }
            *pos += 1;
            if *pos < chars.len() && chars[*pos] == '(' {
                if *pos + 1 < chars.len() && chars[*pos + 1] == '(' {
                    // Arithmetic: $((...))
                    *pos += 2;
                    let mut depth = 1;
                    let mut expr = String::new();
                    while *pos < chars.len() && depth > 0 {
                        if chars[*pos] == '(' {
                            depth += 1;
                        }
                        if chars[*pos] == ')' {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        expr.push(chars[*pos]);
                        *pos += 1;
                    }
                    if *pos < chars.len() {
                        *pos += 1;
                    } // skip inner )
                    if *pos < chars.len() && chars[*pos] == ')' {
                        *pos += 1;
                    } // skip outer )
                    parts.push(WordPart::ArithmeticExpansion(expr));
                    continue;
                }
                // Command substitution: $(...)
                *pos += 1;
                let content = read_balanced_parens(chars, pos);
                parts.push(WordPart::CommandSub(content));
                continue;
            }
            if *pos < chars.len() && chars[*pos] == '{' {
                // Braced variable: ${...}
                *pos += 1;
                let var = read_until_char(chars, pos, '}');
                parts.push(parse_braced_var(&var));
                continue;
            }
            // Special variables: $?, $$, $!, $#, $@, $*
            if *pos < chars.len() && "?$!#@*".contains(chars[*pos]) {
                let var = chars[*pos].to_string();
                *pos += 1;
                parts.push(WordPart::Variable(var));
                continue;
            }
            // Positional parameters: $0-$9
            if *pos < chars.len() && chars[*pos].is_ascii_digit() {
                let var = chars[*pos].to_string();
                *pos += 1;
                parts.push(WordPart::Variable(var));
                continue;
            }
            // Simple variable: $NAME
            let var = read_var_name(chars, pos);
            parts.push(WordPart::Variable(var));
            continue;
        }

        // Backtick command substitution
        if chars[*pos] == '`' {
            if !literal.is_empty() {
                parts.push(WordPart::Literal(std::mem::take(&mut literal)));
            }
            *pos += 1;
            let content = read_until_char(chars, pos, '`');
            parts.push(WordPart::CommandSub(content));
            continue;
        }

        literal.push(chars[*pos]);
        *pos += 1;
    }

    if *pos < chars.len() {
        *pos += 1; // skip closing '"'
    }

    // Flush remaining literal text
    if !literal.is_empty() {
        parts.push(WordPart::Literal(literal));
    }

    // If completely empty (e.g. ""), return a single empty literal
    if parts.is_empty() {
        parts.push(WordPart::Literal(String::new()));
    }

    parts
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
        if ch == ' '
            || ch == '\t'
            || ch == '\n'
            || ch == ';'
            || ch == '|'
            || ch == '&'
            || ch == '>'
            || ch == '<'
            || ch == '('
            || ch == ')'
            || ch == '\''
            || ch == '"'
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
        "break" => Token::Break,
        "continue" => Token::Continue,
        "case" => Token::Case,
        "esac" => Token::Esac,
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

/// Parse the content of `${...}` into a WordPart.
/// Detects parameter expansion operators like `:-`, `:=`, `:+`, `:?`.
fn parse_braced_var(content: &str) -> WordPart {
    for op in &[":-", ":=", ":+", ":?", "##", "#", "%%", "%", "//", "/"] {
        if let Some(idx) = content.find(op) {
            return WordPart::ParamExpansion {
                var: content[..idx].to_string(),
                op: op.to_string(),
                default: content[idx + op.len()..].to_string(),
            };
        }
    }
    WordPart::Variable(content.to_string())
}

/// Read a here-document delimiter. May be quoted with ' or ".
/// Returns (delimiter, was_quoted).
fn read_heredoc_delimiter(chars: &[char], pos: &mut usize) -> (String, bool) {
    if *pos < chars.len() && (chars[*pos] == '\'' || chars[*pos] == '"') {
        let quote = chars[*pos];
        *pos += 1;
        let delim = read_until_char(chars, pos, quote);
        (delim, true)
    } else {
        let mut delim = String::new();
        while *pos < chars.len() && !chars[*pos].is_whitespace() && chars[*pos] != '\n' {
            delim.push(chars[*pos]);
            *pos += 1;
        }
        (delim, false)
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
            vec![Token::Word("echo".into()), Token::CommandSub("date".into()),]
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
        assert_eq!(tokens, vec![Token::Assignment("FOO".into(), "bar".into()),]);
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
            vec![Token::Word("echo".into()), Token::CommandSub("date".into()),]
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
    fn comment_after_command() {
        let tokens = lex("echo hello # comment");
        assert_eq!(
            tokens,
            vec![Token::Word("echo".into()), Token::Word("hello".into()),]
        );
    }

    #[test]
    fn full_line_comment() {
        let tokens = lex("# full line comment\necho hi");
        assert_eq!(
            tokens,
            vec![
                Token::Newline,
                Token::Word("echo".into()),
                Token::Word("hi".into()),
            ]
        );
    }

    #[test]
    fn comment_inside_single_quotes() {
        let tokens = lex("echo 'hello # not comment'");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello # not comment".into()),
            ]
        );
    }

    #[test]
    fn comment_inside_double_quotes() {
        let tokens = lex("echo \"hello # not comment\"");
        assert_eq!(
            tokens,
            vec![
                Token::Word("echo".into()),
                Token::Word("hello # not comment".into()),
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
