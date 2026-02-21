/// A token produced by the shell lexer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    /// A plain word (command name, argument, glob pattern, etc.)
    Word(String),
    /// An assignment: name=value
    Assignment(String, String),
    /// Pipe: |
    Pipe,
    /// And: &&
    And,
    /// Or: ||
    Or,
    /// Semicolon: ;
    Semi,
    /// Newline
    Newline,
    /// Left paren: (
    LParen,
    /// Right paren: )
    RParen,
    /// Redirect
    Redirect(RedirectType),
    /// Variable reference: $VAR, ${VAR}, ${VAR:-default}, $?, $$, etc.
    Variable(String),
    /// Command substitution: $(cmd) or `cmd`
    CommandSub(String),
    // -- Keywords --
    If,
    Then,
    Elif,
    Else,
    Fi,
    For,
    In,
    Do,
    Done,
    While,
}

/// The kind of I/O redirection.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub enum RedirectType {
    /// > file
    StdoutOverwrite(String),
    /// >> file
    StdoutAppend(String),
    /// < file
    StdinFrom(String),
    /// 2> file
    StderrOverwrite(String),
    /// 2>> file
    StderrAppend(String),
    /// 2>&1
    StderrToStdout,
    /// &> file  (both stdout and stderr)
    BothOverwrite(String),
}
