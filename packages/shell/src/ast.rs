use crate::token::RedirectType;

/// A word that may contain variable references or command substitutions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WordPart {
    Literal(String),
    Variable(String),
    CommandSub(String),
}

/// A shell word composed of one or more parts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Word {
    pub parts: Vec<WordPart>,
}

impl Word {
    pub fn literal(s: &str) -> Self {
        Word {
            parts: vec![WordPart::Literal(s.to_string())],
        }
    }

    pub fn variable(s: &str) -> Self {
        Word {
            parts: vec![WordPart::Variable(s.to_string())],
        }
    }
}

/// An I/O redirection attached to a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redirect {
    pub redirect_type: RedirectType,
}

/// A variable assignment preceding a command (e.g. `FOO=bar cmd`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub name: String,
    pub value: String,
}

/// The operator joining two commands in a list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListOp {
    And, // &&
    Or,  // ||
    Seq, // ;
}

/// A shell command AST node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// A simple command: words + redirects + optional assignments.
    Simple {
        words: Vec<Word>,
        redirects: Vec<Redirect>,
        assignments: Vec<Assignment>,
    },
    /// A pipeline: cmd1 | cmd2 | cmd3.
    Pipeline { commands: Vec<Command> },
    /// A list: cmd1 && cmd2, cmd1 || cmd2, cmd1 ; cmd2.
    List {
        left: Box<Command>,
        op: ListOp,
        right: Box<Command>,
    },
    /// If conditional.
    If {
        condition: Box<Command>,
        then_body: Box<Command>,
        else_body: Option<Box<Command>>,
    },
    /// For loop.
    For {
        var: String,
        words: Vec<Word>,
        body: Box<Command>,
    },
    /// While loop.
    While {
        condition: Box<Command>,
        body: Box<Command>,
    },
    /// Subshell: ( commands ).
    Subshell { body: Box<Command> },
}
