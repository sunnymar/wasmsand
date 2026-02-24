//! awk - pattern scanning and text processing
//!
//! Supports: field splitting ($0-$NF), pattern/action blocks, BEGIN/END,
//! print/printf, arithmetic, string functions, associative arrays,
//! if/else, while, for, -F flag.

use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read};
use std::process;

// ---- Lexer ----

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
enum Token {
    // Literals
    Number(f64),
    Str(String),
    Regex(String),
    // Identifiers
    Ident(String),
    Field(usize), // $0, $1, ...
    FieldExpr,    // $ followed by expression
    // Keywords
    Begin,
    End,
    If,
    Else,
    While,
    For,
    In,
    Print,
    Printf,
    Getline,
    Next,
    Exit,
    Delete,
    Return,
    // Operators
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Power, // ^
    Assign,
    PlusAssign,
    MinusAssign,
    StarAssign,
    SlashAssign,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
    Not,
    Match,    // ~
    NotMatch, // !~
    Append,   // >>
    Pipe,     // |
    // Delimiters
    LParen,
    RParen,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Semi,
    Comma,
    Newline,
    Dollar,
    // Special
    Eof,
}

struct Lexer {
    chars: Vec<char>,
    pos: usize,
}

impl Lexer {
    fn new(input: &str) -> Self {
        Self {
            chars: input.chars().collect(),
            pos: 0,
        }
    }

    fn peek(&self) -> char {
        if self.pos < self.chars.len() {
            self.chars[self.pos]
        } else {
            '\0'
        }
    }

    fn advance(&mut self) -> char {
        let ch = self.peek();
        self.pos += 1;
        ch
    }

    fn skip_whitespace(&mut self) {
        while self.pos < self.chars.len() {
            let ch = self.chars[self.pos];
            if ch == ' ' || ch == '\t' || ch == '\r' {
                self.pos += 1;
            } else if ch == '#' {
                // Comment — skip to end of line
                while self.pos < self.chars.len() && self.chars[self.pos] != '\n' {
                    self.pos += 1;
                }
            } else if ch == '\\'
                && self.pos + 1 < self.chars.len()
                && self.chars[self.pos + 1] == '\n'
            {
                // Line continuation
                self.pos += 2;
            } else {
                break;
            }
        }
    }

    fn read_string(&mut self, quote: char) -> String {
        let mut s = String::new();
        loop {
            if self.pos >= self.chars.len() {
                break;
            }
            let ch = self.advance();
            if ch == quote {
                break;
            }
            if ch == '\\' && self.pos < self.chars.len() {
                let esc = self.advance();
                match esc {
                    'n' => s.push('\n'),
                    't' => s.push('\t'),
                    '\\' => s.push('\\'),
                    '"' => s.push('"'),
                    '\'' => s.push('\''),
                    '/' => s.push('/'),
                    _ => {
                        s.push('\\');
                        s.push(esc);
                    }
                }
            } else {
                s.push(ch);
            }
        }
        s
    }

    fn read_number(&mut self) -> f64 {
        let start = self.pos - 1;
        while self.pos < self.chars.len()
            && (self.chars[self.pos].is_ascii_digit() || self.chars[self.pos] == '.')
        {
            self.pos += 1;
        }
        self.chars[start..self.pos]
            .iter()
            .collect::<String>()
            .parse()
            .unwrap_or(0.0)
    }

    fn read_ident(&mut self) -> String {
        let start = self.pos - 1;
        while self.pos < self.chars.len()
            && (self.chars[self.pos].is_alphanumeric() || self.chars[self.pos] == '_')
        {
            self.pos += 1;
        }
        self.chars[start..self.pos].iter().collect()
    }

    fn tokenize(&mut self) -> Vec<Token> {
        let mut tokens = Vec::new();
        loop {
            self.skip_whitespace();
            if self.pos >= self.chars.len() {
                tokens.push(Token::Eof);
                break;
            }
            let ch = self.advance();
            match ch {
                '\n' => tokens.push(Token::Newline),
                '"' => tokens.push(Token::Str(self.read_string('"'))),
                '\'' => tokens.push(Token::Str(self.read_string('\''))),
                '/' => {
                    // Regex if previous token allows it
                    let can_be_regex = tokens.is_empty()
                        || matches!(
                            tokens.last(),
                            Some(
                                Token::Newline
                                    | Token::Semi
                                    | Token::LBrace
                                    | Token::LParen
                                    | Token::Comma
                                    | Token::Not
                                    | Token::And
                                    | Token::Or
                                    | Token::Match
                                    | Token::NotMatch
                                    | Token::Begin
                                    | Token::End
                            )
                        );
                    if can_be_regex {
                        tokens.push(Token::Regex(self.read_string('/')));
                    } else if self.peek() == '=' {
                        self.advance();
                        tokens.push(Token::SlashAssign);
                    } else {
                        tokens.push(Token::Slash);
                    }
                }
                '+' => {
                    if self.peek() == '=' {
                        self.advance();
                        tokens.push(Token::PlusAssign);
                    } else {
                        tokens.push(Token::Plus);
                    }
                }
                '-' => {
                    if self.peek() == '=' {
                        self.advance();
                        tokens.push(Token::MinusAssign);
                    } else {
                        tokens.push(Token::Minus);
                    }
                }
                '*' => {
                    if self.peek() == '=' {
                        self.advance();
                        tokens.push(Token::StarAssign);
                    } else {
                        tokens.push(Token::Star);
                    }
                }
                '%' => tokens.push(Token::Percent),
                '^' => tokens.push(Token::Power),
                '(' => tokens.push(Token::LParen),
                ')' => tokens.push(Token::RParen),
                '{' => tokens.push(Token::LBrace),
                '}' => tokens.push(Token::RBrace),
                '[' => tokens.push(Token::LBracket),
                ']' => tokens.push(Token::RBracket),
                ';' => tokens.push(Token::Semi),
                ',' => tokens.push(Token::Comma),
                '|' => tokens.push(Token::Pipe),
                '~' => tokens.push(Token::Match),
                '=' => {
                    if self.peek() == '=' {
                        self.advance();
                        tokens.push(Token::Eq);
                    } else {
                        tokens.push(Token::Assign);
                    }
                }
                '!' => {
                    if self.peek() == '=' {
                        self.advance();
                        tokens.push(Token::Ne);
                    } else if self.peek() == '~' {
                        self.advance();
                        tokens.push(Token::NotMatch);
                    } else {
                        tokens.push(Token::Not);
                    }
                }
                '<' => {
                    if self.peek() == '=' {
                        self.advance();
                        tokens.push(Token::Le);
                    } else {
                        tokens.push(Token::Lt);
                    }
                }
                '>' => {
                    if self.peek() == '=' {
                        self.advance();
                        tokens.push(Token::Ge);
                    } else if self.peek() == '>' {
                        self.advance();
                        tokens.push(Token::Append);
                    } else {
                        tokens.push(Token::Gt);
                    }
                }
                '&' => {
                    if self.peek() == '&' {
                        self.advance();
                        tokens.push(Token::And);
                    }
                }
                '$' => {
                    // Check if followed by a digit
                    if self.peek().is_ascii_digit() {
                        let start = self.pos;
                        while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_digit() {
                            self.pos += 1;
                        }
                        let n: usize = self.chars[start..self.pos]
                            .iter()
                            .collect::<String>()
                            .parse()
                            .unwrap_or(0);
                        tokens.push(Token::Field(n));
                    } else {
                        tokens.push(Token::Dollar);
                    }
                }
                _ if ch.is_ascii_digit() || (ch == '.' && self.peek().is_ascii_digit()) => {
                    tokens.push(Token::Number(self.read_number()));
                }
                _ if ch.is_alphabetic() || ch == '_' => {
                    let ident = self.read_ident();
                    match ident.as_str() {
                        "BEGIN" => tokens.push(Token::Begin),
                        "END" => tokens.push(Token::End),
                        "if" => tokens.push(Token::If),
                        "else" => tokens.push(Token::Else),
                        "while" => tokens.push(Token::While),
                        "for" => tokens.push(Token::For),
                        "in" => tokens.push(Token::In),
                        "print" => tokens.push(Token::Print),
                        "printf" => tokens.push(Token::Printf),
                        "getline" => tokens.push(Token::Getline),
                        "next" => tokens.push(Token::Next),
                        "exit" => tokens.push(Token::Exit),
                        "delete" => tokens.push(Token::Delete),
                        "return" => tokens.push(Token::Return),
                        _ => tokens.push(Token::Ident(ident)),
                    }
                }
                _ => {} // skip unknown
            }
        }
        tokens
    }
}

// ---- AST ----

#[derive(Debug, Clone)]
#[allow(dead_code)]
enum Expr {
    Num(f64),
    Str(String),
    Field(Box<Expr>),
    Var(String),
    ArrayRef(String, Vec<Expr>),
    Assign(Box<Expr>, Box<Expr>),
    BinOp(Box<Expr>, BinOp, Box<Expr>),
    UnaryMinus(Box<Expr>),
    Not(Box<Expr>),
    Concat(Vec<Expr>),
    Match(Box<Expr>, String),
    Call(String, Vec<Expr>),
    Getline,
    InArray(String, Box<Expr>),
}

#[derive(Debug, Clone)]
enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    And,
    Or,
}

#[derive(Debug, Clone)]
enum Stmt {
    Expr(Expr),
    Print(Vec<Expr>, Option<String>), // exprs, output_redirect
    Printf(String, Vec<Expr>),
    If(Expr, Box<Stmt>, Option<Box<Stmt>>),
    While(Expr, Box<Stmt>),
    For(Box<Stmt>, Expr, Box<Stmt>, Box<Stmt>),
    ForIn(String, String, Box<Stmt>),
    Block(Vec<Stmt>),
    Next,
    Exit(Option<Expr>),
    Delete(String, Vec<Expr>),
}

#[derive(Debug, Clone)]
enum Pattern {
    Begin,
    End,
    Expr(Expr),
    Always,
}

#[derive(Debug, Clone)]
struct Rule {
    pattern: Pattern,
    action: Vec<Stmt>,
}

// ---- Parser ----

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> &Token {
        if self.pos < self.tokens.len() {
            &self.tokens[self.pos]
        } else {
            &Token::Eof
        }
    }

    fn advance(&mut self) -> Token {
        let tok = self.peek().clone();
        self.pos += 1;
        tok
    }

    fn expect(&mut self, expected: &Token) {
        let got = self.advance();
        if &got != expected {
            // Silently skip — best effort parsing
        }
    }

    fn skip_newlines(&mut self) {
        while matches!(self.peek(), Token::Newline | Token::Semi) {
            self.advance();
        }
    }

    fn parse_program(&mut self) -> Vec<Rule> {
        let mut rules = Vec::new();
        self.skip_newlines();
        while !matches!(self.peek(), Token::Eof) {
            if let Some(rule) = self.parse_rule() {
                rules.push(rule);
            }
            self.skip_newlines();
        }
        rules
    }

    fn parse_rule(&mut self) -> Option<Rule> {
        self.skip_newlines();
        let pattern = match self.peek() {
            Token::Begin => {
                self.advance();
                Pattern::Begin
            }
            Token::End => {
                self.advance();
                Pattern::End
            }
            Token::LBrace => Pattern::Always,
            _ => {
                let expr = self.parse_expr();
                Pattern::Expr(expr)
            }
        };

        self.skip_newlines();

        let action = if matches!(self.peek(), Token::LBrace) {
            self.parse_block()
        } else {
            // Default action: print $0
            vec![Stmt::Print(
                vec![Expr::Field(Box::new(Expr::Num(0.0)))],
                None,
            )]
        };

        Some(Rule { pattern, action })
    }

    fn parse_block(&mut self) -> Vec<Stmt> {
        self.expect(&Token::LBrace);
        let mut stmts = Vec::new();
        self.skip_newlines();
        while !matches!(self.peek(), Token::RBrace | Token::Eof) {
            stmts.push(self.parse_stmt());
            self.skip_newlines();
        }
        if matches!(self.peek(), Token::RBrace) {
            self.advance();
        }
        stmts
    }

    fn parse_stmt(&mut self) -> Stmt {
        self.skip_newlines();
        match self.peek().clone() {
            Token::Print => {
                self.advance();
                let mut exprs = Vec::new();
                let mut redirect = None;
                if !matches!(
                    self.peek(),
                    Token::Newline | Token::Semi | Token::RBrace | Token::Eof | Token::Pipe
                ) {
                    exprs.push(self.parse_expr());
                    while matches!(self.peek(), Token::Comma) {
                        self.advance();
                        exprs.push(self.parse_expr());
                    }
                }
                if matches!(self.peek(), Token::Gt | Token::Append) {
                    let _redir = self.advance();
                    if let Token::Str(s) = self.advance() {
                        redirect = Some(s);
                    }
                }
                self.skip_term();
                Stmt::Print(exprs, redirect)
            }
            Token::Printf => {
                self.advance();
                let fmt = if let Token::Str(s) = self.advance() {
                    s
                } else {
                    String::new()
                };
                let mut args = Vec::new();
                while matches!(self.peek(), Token::Comma) {
                    self.advance();
                    args.push(self.parse_expr());
                }
                self.skip_term();
                Stmt::Printf(fmt, args)
            }
            Token::If => {
                self.advance();
                self.expect(&Token::LParen);
                let cond = self.parse_expr();
                self.expect(&Token::RParen);
                self.skip_newlines();
                let then_body = self.parse_stmt();
                self.skip_newlines();
                let else_body = if matches!(self.peek(), Token::Else) {
                    self.advance();
                    self.skip_newlines();
                    Some(Box::new(self.parse_stmt()))
                } else {
                    None
                };
                Stmt::If(cond, Box::new(then_body), else_body)
            }
            Token::While => {
                self.advance();
                self.expect(&Token::LParen);
                let cond = self.parse_expr();
                self.expect(&Token::RParen);
                self.skip_newlines();
                let body = self.parse_stmt();
                Stmt::While(cond, Box::new(body))
            }
            Token::For => {
                self.advance();
                self.expect(&Token::LParen);
                // Check for for-in: for (var in array)
                if let Token::Ident(name) = self.peek().clone() {
                    let save = self.pos;
                    self.advance();
                    if matches!(self.peek(), Token::In) {
                        self.advance();
                        if let Token::Ident(arr) = self.advance() {
                            self.expect(&Token::RParen);
                            self.skip_newlines();
                            let body = self.parse_stmt();
                            return Stmt::ForIn(name, arr, Box::new(body));
                        }
                    }
                    self.pos = save;
                }
                let init = self.parse_stmt();
                let cond = self.parse_expr();
                self.skip_term();
                let update = self.parse_stmt();
                self.expect(&Token::RParen);
                self.skip_newlines();
                let body = self.parse_stmt();
                Stmt::For(Box::new(init), cond, Box::new(update), Box::new(body))
            }
            Token::LBrace => Stmt::Block(self.parse_block()),
            Token::Next => {
                self.advance();
                self.skip_term();
                Stmt::Next
            }
            Token::Exit => {
                self.advance();
                let code = if !matches!(
                    self.peek(),
                    Token::Newline | Token::Semi | Token::RBrace | Token::Eof
                ) {
                    Some(self.parse_expr())
                } else {
                    None
                };
                self.skip_term();
                Stmt::Exit(code)
            }
            Token::Delete => {
                self.advance();
                if let Token::Ident(name) = self.advance() {
                    let mut keys = Vec::new();
                    if matches!(self.peek(), Token::LBracket) {
                        self.advance();
                        keys.push(self.parse_expr());
                        while matches!(self.peek(), Token::Comma) {
                            self.advance();
                            keys.push(self.parse_expr());
                        }
                        self.expect(&Token::RBracket);
                    }
                    self.skip_term();
                    Stmt::Delete(name, keys)
                } else {
                    self.skip_term();
                    Stmt::Expr(Expr::Num(0.0))
                }
            }
            _ => {
                let expr = self.parse_expr();
                self.skip_term();
                Stmt::Expr(expr)
            }
        }
    }

    fn skip_term(&mut self) {
        while matches!(self.peek(), Token::Newline | Token::Semi) {
            self.advance();
        }
    }

    // Expression parsing with precedence climbing
    fn parse_expr(&mut self) -> Expr {
        self.parse_assign()
    }

    fn parse_assign(&mut self) -> Expr {
        let lhs = self.parse_or();
        match self.peek() {
            Token::Assign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::Assign(Box::new(lhs), Box::new(rhs))
            }
            Token::PlusAssign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::Assign(
                    Box::new(lhs.clone()),
                    Box::new(Expr::BinOp(Box::new(lhs), BinOp::Add, Box::new(rhs))),
                )
            }
            Token::MinusAssign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::Assign(
                    Box::new(lhs.clone()),
                    Box::new(Expr::BinOp(Box::new(lhs), BinOp::Sub, Box::new(rhs))),
                )
            }
            Token::StarAssign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::Assign(
                    Box::new(lhs.clone()),
                    Box::new(Expr::BinOp(Box::new(lhs), BinOp::Mul, Box::new(rhs))),
                )
            }
            Token::SlashAssign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::Assign(
                    Box::new(lhs.clone()),
                    Box::new(Expr::BinOp(Box::new(lhs), BinOp::Div, Box::new(rhs))),
                )
            }
            _ => lhs,
        }
    }

    fn parse_or(&mut self) -> Expr {
        let mut lhs = self.parse_and();
        while matches!(self.peek(), Token::Or) {
            self.advance();
            let rhs = self.parse_and();
            lhs = Expr::BinOp(Box::new(lhs), BinOp::Or, Box::new(rhs));
        }
        lhs
    }

    fn parse_and(&mut self) -> Expr {
        let mut lhs = self.parse_match_expr();
        while matches!(self.peek(), Token::And) {
            self.advance();
            let rhs = self.parse_match_expr();
            lhs = Expr::BinOp(Box::new(lhs), BinOp::And, Box::new(rhs));
        }
        lhs
    }

    fn parse_match_expr(&mut self) -> Expr {
        let lhs = self.parse_comparison();
        match self.peek() {
            Token::Match => {
                self.advance();
                if let Token::Regex(pat) = self.advance() {
                    Expr::Match(Box::new(lhs), pat)
                } else {
                    lhs
                }
            }
            Token::NotMatch => {
                self.advance();
                if let Token::Regex(pat) = self.advance() {
                    Expr::Not(Box::new(Expr::Match(Box::new(lhs), pat)))
                } else {
                    lhs
                }
            }
            _ => lhs,
        }
    }

    fn parse_comparison(&mut self) -> Expr {
        let lhs = self.parse_concat();
        let op = match self.peek() {
            Token::Eq => BinOp::Eq,
            Token::Ne => BinOp::Ne,
            Token::Lt => BinOp::Lt,
            Token::Le => BinOp::Le,
            Token::Gt => BinOp::Gt,
            Token::Ge => BinOp::Ge,
            _ => return lhs,
        };
        self.advance();
        let rhs = self.parse_concat();
        Expr::BinOp(Box::new(lhs), op, Box::new(rhs))
    }

    fn parse_concat(&mut self) -> Expr {
        let first = self.parse_addition();
        // String concatenation: two adjacent non-operator expressions
        // This is tricky in awk — for now only concat explicit string/var sequences
        // We detect concat when next token starts a primary but isn't an operator
        let mut parts = vec![first];
        while matches!(
            self.peek(),
            Token::Number(_)
                | Token::Str(_)
                | Token::Ident(_)
                | Token::Field(_)
                | Token::Dollar
                | Token::LParen
        ) {
            parts.push(self.parse_addition());
        }
        if parts.len() == 1 {
            parts.pop().unwrap()
        } else {
            Expr::Concat(parts)
        }
    }

    fn parse_addition(&mut self) -> Expr {
        let mut lhs = self.parse_multiplication();
        loop {
            match self.peek() {
                Token::Plus => {
                    self.advance();
                    let rhs = self.parse_multiplication();
                    lhs = Expr::BinOp(Box::new(lhs), BinOp::Add, Box::new(rhs));
                }
                Token::Minus => {
                    self.advance();
                    let rhs = self.parse_multiplication();
                    lhs = Expr::BinOp(Box::new(lhs), BinOp::Sub, Box::new(rhs));
                }
                _ => break,
            }
        }
        lhs
    }

    fn parse_multiplication(&mut self) -> Expr {
        let mut lhs = self.parse_power();
        loop {
            match self.peek() {
                Token::Star => {
                    self.advance();
                    let rhs = self.parse_power();
                    lhs = Expr::BinOp(Box::new(lhs), BinOp::Mul, Box::new(rhs));
                }
                Token::Slash => {
                    self.advance();
                    let rhs = self.parse_power();
                    lhs = Expr::BinOp(Box::new(lhs), BinOp::Div, Box::new(rhs));
                }
                Token::Percent => {
                    self.advance();
                    let rhs = self.parse_power();
                    lhs = Expr::BinOp(Box::new(lhs), BinOp::Mod, Box::new(rhs));
                }
                _ => break,
            }
        }
        lhs
    }

    fn parse_power(&mut self) -> Expr {
        let lhs = self.parse_unary();
        if matches!(self.peek(), Token::Power) {
            self.advance();
            let rhs = self.parse_unary();
            Expr::BinOp(Box::new(lhs), BinOp::Pow, Box::new(rhs))
        } else {
            lhs
        }
    }

    fn parse_unary(&mut self) -> Expr {
        match self.peek() {
            Token::Minus => {
                self.advance();
                Expr::UnaryMinus(Box::new(self.parse_primary()))
            }
            Token::Not => {
                self.advance();
                Expr::Not(Box::new(self.parse_primary()))
            }
            _ => self.parse_primary(),
        }
    }

    fn parse_primary(&mut self) -> Expr {
        match self.peek().clone() {
            Token::Number(n) => {
                self.advance();
                Expr::Num(n)
            }
            Token::Str(s) => {
                self.advance();
                Expr::Str(s)
            }
            Token::Regex(pat) => {
                self.advance();
                // Bare regex matches $0
                Expr::Match(Box::new(Expr::Field(Box::new(Expr::Num(0.0)))), pat)
            }
            Token::Field(n) => {
                self.advance();
                Expr::Field(Box::new(Expr::Num(n as f64)))
            }
            Token::Dollar => {
                self.advance();
                let expr = self.parse_primary();
                Expr::Field(Box::new(expr))
            }
            Token::Ident(name) => {
                self.advance();
                // Check for function call or array ref
                if matches!(self.peek(), Token::LParen) {
                    self.advance();
                    let mut args = Vec::new();
                    if !matches!(self.peek(), Token::RParen) {
                        args.push(self.parse_expr());
                        while matches!(self.peek(), Token::Comma) {
                            self.advance();
                            args.push(self.parse_expr());
                        }
                    }
                    self.expect(&Token::RParen);
                    Expr::Call(name, args)
                } else if matches!(self.peek(), Token::LBracket) {
                    self.advance();
                    let mut keys = Vec::new();
                    keys.push(self.parse_expr());
                    while matches!(self.peek(), Token::Comma) {
                        self.advance();
                        keys.push(self.parse_expr());
                    }
                    self.expect(&Token::RBracket);
                    Expr::ArrayRef(name, keys)
                } else {
                    Expr::Var(name)
                }
            }
            Token::LParen => {
                self.advance();
                let expr = self.parse_expr();
                self.expect(&Token::RParen);
                expr
            }
            Token::Getline => {
                self.advance();
                Expr::Getline
            }
            _ => {
                self.advance();
                Expr::Num(0.0)
            }
        }
    }
}

// ---- Interpreter ----

#[derive(Debug, Clone)]
enum Value {
    Num(f64),
    Str(String),
}

impl Value {
    fn to_num(&self) -> f64 {
        match self {
            Value::Num(n) => *n,
            Value::Str(s) => s.trim().parse().unwrap_or(0.0),
        }
    }

    fn to_str(&self) -> String {
        match self {
            Value::Num(n) => {
                if *n == (*n as i64 as f64) {
                    format!("{}", *n as i64)
                } else {
                    format!("{:.6}", n)
                }
            }
            Value::Str(s) => s.clone(),
        }
    }

    fn is_true(&self) -> bool {
        match self {
            Value::Num(n) => *n != 0.0,
            Value::Str(s) => !s.is_empty(),
        }
    }
}

struct AwkInterp {
    vars: HashMap<String, Value>,
    arrays: HashMap<String, HashMap<String, Value>>,
    fields: Vec<String>,
    fs: String,
    ofs: String,
    ors: String,
    nr: usize,
    fnr: usize,
    nf: usize,
    output: String,
}

enum ControlFlow {
    Normal,
    Next,
    Exit(i32),
}

impl AwkInterp {
    fn new(fs: &str) -> Self {
        Self {
            vars: HashMap::new(),
            arrays: HashMap::new(),
            fields: Vec::new(),
            fs: fs.to_string(),
            ofs: " ".to_string(),
            ors: "\n".to_string(),
            nr: 0,
            fnr: 0,
            nf: 0,
            output: String::new(),
        }
    }

    fn set_record(&mut self, line: &str) {
        self.fields = if self.fs.len() == 1 && self.fs != " " {
            line.split(self.fs.chars().next().unwrap())
                .map(|s| s.to_string())
                .collect()
        } else {
            // Default: split on whitespace
            line.split_whitespace().map(|s| s.to_string()).collect()
        };
        self.nf = self.fields.len();
        self.vars
            .insert("NF".to_string(), Value::Num(self.nf as f64));
    }

    fn get_field(&self, n: usize) -> String {
        if n == 0 {
            self.fields.join(&self.ofs)
        } else if n <= self.fields.len() {
            self.fields[n - 1].clone()
        } else {
            String::new()
        }
    }

    fn set_field(&mut self, n: usize, val: String) {
        if n == 0 {
            self.set_record(&val);
            return;
        }
        while self.fields.len() < n {
            self.fields.push(String::new());
        }
        self.fields[n - 1] = val;
        self.nf = self.fields.len();
    }

    fn get_var(&self, name: &str) -> Value {
        match name {
            "NR" => Value::Num(self.nr as f64),
            "FNR" => Value::Num(self.fnr as f64),
            "NF" => Value::Num(self.nf as f64),
            "FS" => Value::Str(self.fs.clone()),
            "OFS" => Value::Str(self.ofs.clone()),
            "ORS" => Value::Str(self.ors.clone()),
            "FILENAME" => self
                .vars
                .get("FILENAME")
                .cloned()
                .unwrap_or(Value::Str(String::new())),
            _ => self.vars.get(name).cloned().unwrap_or(Value::Num(0.0)),
        }
    }

    fn set_var(&mut self, name: &str, val: Value) {
        match name {
            "FS" => self.fs = val.to_str(),
            "OFS" => self.ofs = val.to_str(),
            "ORS" => self.ors = val.to_str(),
            "NR" => self.nr = val.to_num() as usize,
            _ => {
                self.vars.insert(name.to_string(), val);
            }
        }
    }

    fn eval_expr(&mut self, expr: &Expr) -> Value {
        match expr {
            Expr::Num(n) => Value::Num(*n),
            Expr::Str(s) => Value::Str(s.clone()),
            Expr::Field(e) => {
                let n = self.eval_expr(e).to_num() as usize;
                Value::Str(self.get_field(n))
            }
            Expr::Var(name) => self.get_var(name),
            Expr::ArrayRef(name, keys) => {
                let key = keys
                    .iter()
                    .map(|k| self.eval_expr(k).to_str())
                    .collect::<Vec<_>>()
                    .join("\x1c");
                self.arrays
                    .get(name)
                    .and_then(|m| m.get(&key))
                    .cloned()
                    .unwrap_or(Value::Num(0.0))
            }
            Expr::Assign(lhs, rhs) => {
                let val = self.eval_expr(rhs);
                self.assign(lhs, val.clone());
                val
            }
            Expr::BinOp(lhs, op, rhs) => {
                let l = self.eval_expr(lhs);
                let r = self.eval_expr(rhs);
                match op {
                    BinOp::Add => Value::Num(l.to_num() + r.to_num()),
                    BinOp::Sub => Value::Num(l.to_num() - r.to_num()),
                    BinOp::Mul => Value::Num(l.to_num() * r.to_num()),
                    BinOp::Div => {
                        let d = r.to_num();
                        Value::Num(if d == 0.0 { 0.0 } else { l.to_num() / d })
                    }
                    BinOp::Mod => {
                        let d = r.to_num();
                        Value::Num(if d == 0.0 { 0.0 } else { l.to_num() % d })
                    }
                    BinOp::Pow => Value::Num(l.to_num().powf(r.to_num())),
                    BinOp::Eq => {
                        let eq = if matches!((&l, &r), (Value::Num(_), Value::Num(_))) {
                            l.to_num() == r.to_num()
                        } else {
                            l.to_str() == r.to_str()
                        };
                        Value::Num(if eq { 1.0 } else { 0.0 })
                    }
                    BinOp::Ne => {
                        let ne = if matches!((&l, &r), (Value::Num(_), Value::Num(_))) {
                            l.to_num() != r.to_num()
                        } else {
                            l.to_str() != r.to_str()
                        };
                        Value::Num(if ne { 1.0 } else { 0.0 })
                    }
                    BinOp::Lt => Value::Num(if l.to_num() < r.to_num() { 1.0 } else { 0.0 }),
                    BinOp::Le => Value::Num(if l.to_num() <= r.to_num() { 1.0 } else { 0.0 }),
                    BinOp::Gt => Value::Num(if l.to_num() > r.to_num() { 1.0 } else { 0.0 }),
                    BinOp::Ge => Value::Num(if l.to_num() >= r.to_num() { 1.0 } else { 0.0 }),
                    BinOp::And => Value::Num(if l.is_true() && r.is_true() { 1.0 } else { 0.0 }),
                    BinOp::Or => Value::Num(if l.is_true() || r.is_true() { 1.0 } else { 0.0 }),
                }
            }
            Expr::UnaryMinus(e) => Value::Num(-self.eval_expr(e).to_num()),
            Expr::Not(e) => Value::Num(if self.eval_expr(e).is_true() {
                0.0
            } else {
                1.0
            }),
            Expr::Concat(parts) => {
                let s: String = parts.iter().map(|p| self.eval_expr(p).to_str()).collect();
                Value::Str(s)
            }
            Expr::Match(expr, pat) => {
                let s = self.eval_expr(expr).to_str();
                Value::Num(if s.contains(pat.as_str()) { 1.0 } else { 0.0 })
            }
            Expr::Call(name, args) => self.call_function(name, args),
            Expr::Getline => Value::Num(0.0), // Not implemented for simple use
            Expr::InArray(arr, key) => {
                let k = self.eval_expr(key).to_str();
                let exists = self.arrays.get(arr).is_some_and(|m| m.contains_key(&k));
                Value::Num(if exists { 1.0 } else { 0.0 })
            }
        }
    }

    fn assign(&mut self, lhs: &Expr, val: Value) {
        match lhs {
            Expr::Var(name) => self.set_var(name, val),
            Expr::Field(e) => {
                let n = self.eval_expr(e).to_num() as usize;
                self.set_field(n, val.to_str());
            }
            Expr::ArrayRef(name, keys) => {
                let key = keys
                    .iter()
                    .map(|k| self.eval_expr(k).to_str())
                    .collect::<Vec<_>>()
                    .join("\x1c");
                self.arrays
                    .entry(name.clone())
                    .or_default()
                    .insert(key, val);
            }
            _ => {}
        }
    }

    fn call_function(&mut self, name: &str, args: &[Expr]) -> Value {
        match name {
            "length" => {
                if args.is_empty() {
                    Value::Num(self.get_field(0).len() as f64)
                } else {
                    Value::Num(self.eval_expr(&args[0]).to_str().len() as f64)
                }
            }
            "substr" => {
                let s = self.eval_expr(&args[0]).to_str();
                let start = (self.eval_expr(&args[1]).to_num() as usize).saturating_sub(1);
                if args.len() > 2 {
                    let len = self.eval_expr(&args[2]).to_num() as usize;
                    Value::Str(s.chars().skip(start).take(len).collect())
                } else {
                    Value::Str(s.chars().skip(start).collect())
                }
            }
            "index" => {
                let s = self.eval_expr(&args[0]).to_str();
                let t = self.eval_expr(&args[1]).to_str();
                Value::Num(s.find(&t).map_or(0, |i| i + 1) as f64)
            }
            "split" => {
                let s = self.eval_expr(&args[0]).to_str();
                let arr_name = if let Expr::Var(name) = &args[1] {
                    name.clone()
                } else {
                    return Value::Num(0.0);
                };
                let sep = if args.len() > 2 {
                    self.eval_expr(&args[2]).to_str()
                } else {
                    self.fs.clone()
                };
                let parts: Vec<&str> = if sep == " " {
                    s.split_whitespace().collect()
                } else if sep.len() == 1 {
                    s.split(sep.chars().next().unwrap()).collect()
                } else {
                    vec![&s]
                };
                let map = self.arrays.entry(arr_name).or_default();
                map.clear();
                for (i, part) in parts.iter().enumerate() {
                    map.insert((i + 1).to_string(), Value::Str(part.to_string()));
                }
                Value::Num(parts.len() as f64)
            }
            "sub" | "gsub" => {
                let pat = self.eval_expr(&args[0]).to_str();
                let repl = self.eval_expr(&args[1]).to_str();
                let is_global = name == "gsub";

                // Target is $0 or the third argument
                let target = if args.len() > 2 {
                    self.eval_expr(&args[2]).to_str()
                } else {
                    self.get_field(0)
                };

                let (result, count) = str_replace(&target, &pat, &repl, is_global);
                if args.len() > 2 {
                    self.assign(&args[2], Value::Str(result));
                } else {
                    self.set_field(0, result);
                }
                Value::Num(count as f64)
            }
            "tolower" => Value::Str(self.eval_expr(&args[0]).to_str().to_lowercase()),
            "toupper" => Value::Str(self.eval_expr(&args[0]).to_str().to_uppercase()),
            "sprintf" => {
                let fmt = self.eval_expr(&args[0]).to_str();
                let vals: Vec<Value> = args[1..].iter().map(|a| self.eval_expr(a)).collect();
                Value::Str(awk_sprintf(&fmt, &vals))
            }
            "int" => Value::Num(self.eval_expr(&args[0]).to_num() as i64 as f64),
            "sqrt" => Value::Num(self.eval_expr(&args[0]).to_num().sqrt()),
            "log" => Value::Num(self.eval_expr(&args[0]).to_num().ln()),
            "exp" => Value::Num(self.eval_expr(&args[0]).to_num().exp()),
            "sin" => Value::Num(self.eval_expr(&args[0]).to_num().sin()),
            "cos" => Value::Num(self.eval_expr(&args[0]).to_num().cos()),
            _ => Value::Num(0.0),
        }
    }

    fn exec_stmt(&mut self, stmt: &Stmt) -> ControlFlow {
        match stmt {
            Stmt::Expr(expr) => {
                self.eval_expr(expr);
                ControlFlow::Normal
            }
            Stmt::Print(exprs, _redirect) => {
                if exprs.is_empty() {
                    self.output.push_str(&self.get_field(0));
                } else {
                    let parts: Vec<String> =
                        exprs.iter().map(|e| self.eval_expr(e).to_str()).collect();
                    self.output.push_str(&parts.join(&self.ofs));
                }
                self.output.push_str(&self.ors);
                ControlFlow::Normal
            }
            Stmt::Printf(fmt, args) => {
                let vals: Vec<Value> = args.iter().map(|a| self.eval_expr(a)).collect();
                self.output.push_str(&awk_sprintf(fmt, &vals));
                ControlFlow::Normal
            }
            Stmt::If(cond, then_body, else_body) => {
                if self.eval_expr(cond).is_true() {
                    self.exec_stmt(then_body)
                } else if let Some(eb) = else_body {
                    self.exec_stmt(eb)
                } else {
                    ControlFlow::Normal
                }
            }
            Stmt::While(cond, body) => {
                let mut iterations = 0;
                while self.eval_expr(cond).is_true() && iterations < 100000 {
                    match self.exec_stmt(body) {
                        ControlFlow::Next => return ControlFlow::Next,
                        ControlFlow::Exit(code) => return ControlFlow::Exit(code),
                        _ => {}
                    }
                    iterations += 1;
                }
                ControlFlow::Normal
            }
            Stmt::For(init, cond, update, body) => {
                self.exec_stmt(init);
                let mut iterations = 0;
                while self.eval_expr(cond).is_true() && iterations < 100000 {
                    match self.exec_stmt(body) {
                        ControlFlow::Next => return ControlFlow::Next,
                        ControlFlow::Exit(code) => return ControlFlow::Exit(code),
                        _ => {}
                    }
                    self.exec_stmt(update);
                    iterations += 1;
                }
                ControlFlow::Normal
            }
            Stmt::ForIn(var, arr, body) => {
                let keys: Vec<String> = self
                    .arrays
                    .get(arr)
                    .map_or(Vec::new(), |m| m.keys().cloned().collect());
                for key in keys {
                    self.set_var(var, Value::Str(key));
                    match self.exec_stmt(body) {
                        ControlFlow::Next => return ControlFlow::Next,
                        ControlFlow::Exit(code) => return ControlFlow::Exit(code),
                        _ => {}
                    }
                }
                ControlFlow::Normal
            }
            Stmt::Block(stmts) => {
                for stmt in stmts {
                    match self.exec_stmt(stmt) {
                        ControlFlow::Normal => {}
                        cf => return cf,
                    }
                }
                ControlFlow::Normal
            }
            Stmt::Next => ControlFlow::Next,
            Stmt::Exit(code) => {
                let c = code
                    .as_ref()
                    .map_or(0, |e| self.eval_expr(e).to_num() as i32);
                ControlFlow::Exit(c)
            }
            Stmt::Delete(name, keys) => {
                if keys.is_empty() {
                    self.arrays.remove(name);
                } else {
                    let key = keys
                        .iter()
                        .map(|k| self.eval_expr(k).to_str())
                        .collect::<Vec<_>>()
                        .join("\x1c");
                    if let Some(m) = self.arrays.get_mut(name) {
                        m.remove(&key);
                    }
                }
                ControlFlow::Normal
            }
        }
    }

    fn exec_rules(&mut self, rules: &[Rule], line: &str) -> ControlFlow {
        for rule in rules {
            let matches = match &rule.pattern {
                Pattern::Begin | Pattern::End => false,
                Pattern::Always => true,
                Pattern::Expr(expr) => self.eval_expr(expr).is_true(),
            };
            if matches {
                for stmt in &rule.action {
                    match self.exec_stmt(stmt) {
                        ControlFlow::Next => return ControlFlow::Next,
                        ControlFlow::Exit(code) => return ControlFlow::Exit(code),
                        _ => {}
                    }
                }
            }
        }
        let _ = line;
        ControlFlow::Normal
    }
}

fn str_replace(s: &str, pat: &str, repl: &str, global: bool) -> (String, usize) {
    if pat.is_empty() {
        return (s.to_string(), 0);
    }
    let mut result = String::new();
    let mut count = 0;
    let mut pos = 0;
    while pos < s.len() {
        if let Some(idx) = s[pos..].find(pat) {
            result.push_str(&s[pos..pos + idx]);
            result.push_str(repl);
            pos += idx + pat.len();
            count += 1;
            if !global {
                result.push_str(&s[pos..]);
                return (result, count);
            }
        } else {
            result.push_str(&s[pos..]);
            break;
        }
    }
    (result, count)
}

fn awk_sprintf(fmt: &str, args: &[Value]) -> String {
    let mut result = String::new();
    let chars: Vec<char> = fmt.chars().collect();
    let mut i = 0;
    let mut arg_idx = 0;

    while i < chars.len() {
        if chars[i] == '%' && i + 1 < chars.len() {
            i += 1;
            if chars[i] == '%' {
                result.push('%');
                i += 1;
                continue;
            }
            // Parse flags and width
            let mut width_str = String::new();
            let mut left_align = false;
            if chars[i] == '-' {
                left_align = true;
                i += 1;
            }
            while i < chars.len() && (chars[i].is_ascii_digit() || chars[i] == '.') {
                width_str.push(chars[i]);
                i += 1;
            }
            if i >= chars.len() {
                break;
            }
            let spec = chars[i];
            i += 1;
            let val = if arg_idx < args.len() {
                &args[arg_idx]
            } else {
                &Value::Str(String::new())
            };
            arg_idx += 1;

            let formatted = match spec {
                'd' | 'i' => format!("{}", val.to_num() as i64),
                'f' => {
                    if width_str.contains('.') {
                        let prec: usize = width_str
                            .split('.')
                            .nth(1)
                            .unwrap_or("6")
                            .parse()
                            .unwrap_or(6);
                        format!("{:.prec$}", val.to_num())
                    } else {
                        format!("{:.6}", val.to_num())
                    }
                }
                's' => val.to_str(),
                'c' => {
                    let n = val.to_num() as u32;
                    char::from_u32(n).map_or(String::new(), |c| c.to_string())
                }
                'x' => format!("{:x}", val.to_num() as i64),
                'o' => format!("{:o}", val.to_num() as i64),
                _ => String::new(),
            };

            // Apply width
            let width: usize = width_str
                .split('.')
                .next()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);
            if width > 0 && formatted.len() < width {
                if left_align {
                    result.push_str(&formatted);
                    for _ in 0..width - formatted.len() {
                        result.push(' ');
                    }
                } else {
                    for _ in 0..width - formatted.len() {
                        result.push(' ');
                    }
                    result.push_str(&formatted);
                }
            } else {
                result.push_str(&formatted);
            }
        } else if chars[i] == '\\' && i + 1 < chars.len() {
            i += 1;
            match chars[i] {
                'n' => result.push('\n'),
                't' => result.push('\t'),
                '\\' => result.push('\\'),
                _ => {
                    result.push('\\');
                    result.push(chars[i]);
                }
            }
            i += 1;
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    result
}

fn read_input(input: &mut dyn Read) -> Vec<String> {
    let reader = BufReader::new(input);
    reader.lines().map_while(Result::ok).collect()
}

fn main() {
    let args: Vec<String> = env::args().collect();

    let mut fs = " ".to_string();
    let mut program: Option<String> = None;
    let mut files: Vec<String> = Vec::new();
    let mut var_assigns: Vec<(String, String)> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-F" => {
                i += 1;
                if i < args.len() {
                    fs = args[i].clone();
                }
            }
            "-v" => {
                i += 1;
                if i < args.len() {
                    if let Some(eq) = args[i].find('=') {
                        let name = args[i][..eq].to_string();
                        let val = args[i][eq + 1..].to_string();
                        var_assigns.push((name, val));
                    }
                }
            }
            arg => {
                if program.is_none() {
                    program = Some(arg.to_string());
                } else {
                    files.push(arg.to_string());
                }
            }
        }
        i += 1;
    }

    let program = match program {
        Some(p) => p,
        None => {
            eprintln!("awk: no program given");
            process::exit(1);
        }
    };

    // Parse
    let mut lexer = Lexer::new(&program);
    let tokens = lexer.tokenize();
    let mut parser = Parser::new(tokens);
    let rules = parser.parse_program();

    // Execute
    let mut interp = AwkInterp::new(&fs);

    // Set -v variables
    for (name, val) in &var_assigns {
        interp.set_var(name, Value::Str(val.clone()));
    }

    // Run BEGIN rules
    for rule in &rules {
        if matches!(rule.pattern, Pattern::Begin) {
            for stmt in &rule.action {
                if let ControlFlow::Exit(code) = interp.exec_stmt(stmt) {
                    print!("{}", interp.output);
                    process::exit(code);
                }
            }
        }
    }

    let mut exit_code = 0;

    if files.is_empty() {
        let stdin = io::stdin();
        let mut lock = stdin.lock();
        let lines = read_input(&mut lock);
        for line in &lines {
            interp.nr += 1;
            interp.fnr += 1;
            interp.set_record(line);
            interp
                .vars
                .insert("NR".to_string(), Value::Num(interp.nr as f64));
            interp
                .vars
                .insert("FNR".to_string(), Value::Num(interp.fnr as f64));
            if let ControlFlow::Exit(code) = interp.exec_rules(&rules, line) {
                exit_code = code;
                break;
            }
        }
    } else {
        'outer: for file in &files {
            interp.fnr = 0;
            interp
                .vars
                .insert("FILENAME".to_string(), Value::Str(file.clone()));
            let lines = match File::open(file) {
                Ok(mut f) => read_input(&mut f),
                Err(e) => {
                    eprintln!("awk: {}: {}", file, e);
                    continue;
                }
            };
            for line in &lines {
                interp.nr += 1;
                interp.fnr += 1;
                interp.set_record(line);
                interp
                    .vars
                    .insert("NR".to_string(), Value::Num(interp.nr as f64));
                interp
                    .vars
                    .insert("FNR".to_string(), Value::Num(interp.fnr as f64));
                if let ControlFlow::Exit(code) = interp.exec_rules(&rules, line) {
                    exit_code = code;
                    break 'outer;
                }
            }
        }
    }

    // Run END rules
    for rule in &rules {
        if matches!(rule.pattern, Pattern::End) {
            for stmt in &rule.action {
                if let ControlFlow::Exit(code) = interp.exec_stmt(stmt) {
                    exit_code = code;
                    break;
                }
            }
        }
    }

    print!("{}", interp.output);
    process::exit(exit_code);
}
