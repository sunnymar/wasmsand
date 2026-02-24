use std::collections::HashMap;
use std::io::{self, BufWriter, Read, Write};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Number(String), // raw numeric literal (parsed later respecting ibase)
    StringLit(String),
    Ident(String),
    // Arithmetic
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    // Assignment
    Assign,
    PlusAssign,
    MinusAssign,
    StarAssign,
    SlashAssign,
    PercentAssign,
    CaretAssign,
    // Increment / decrement
    PlusPlus,
    MinusMinus,
    // Comparison
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
    // Boolean
    Not,
    And,
    Or,
    // Delimiters
    LParen,
    RParen,
    LBrace,
    RBrace,
    LBracket,
    RBracket,
    Semicolon,
    Comma,
    Newline,
    // Keywords
    If,
    Else,
    While,
    For,
    Break,
    Continue,
    Define,
    Return,
    Auto,
    Quit,
    Halt,
    Print,
    // End of input
    Eof,
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

struct Tokenizer {
    chars: Vec<char>,
    pos: usize,
}

impl Tokenizer {
    fn new(input: &str) -> Self {
        Tokenizer {
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

    fn peek_next(&self) -> char {
        if self.pos + 1 < self.chars.len() {
            self.chars[self.pos + 1]
        } else {
            '\0'
        }
    }

    fn skip_whitespace_not_newline(&mut self) {
        while self.pos < self.chars.len() {
            let ch = self.chars[self.pos];
            if ch == ' ' || ch == '\t' || ch == '\r' {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn skip_block_comment(&mut self) {
        // Already consumed '/' and '*'
        while self.pos < self.chars.len() {
            if self.chars[self.pos] == '*'
                && self.pos + 1 < self.chars.len()
                && self.chars[self.pos + 1] == '/'
            {
                self.pos += 2;
                return;
            }
            self.pos += 1;
        }
    }

    fn skip_line_comment(&mut self) {
        while self.pos < self.chars.len() && self.chars[self.pos] != '\n' {
            self.pos += 1;
        }
    }

    fn read_number(&mut self) -> String {
        let mut s = String::new();
        while self.pos < self.chars.len() {
            let ch = self.chars[self.pos];
            if ch.is_ascii_digit() || ch == '.' || ch.is_ascii_uppercase() {
                s.push(ch);
                self.pos += 1;
            } else {
                break;
            }
        }
        s
    }

    fn read_ident(&mut self) -> String {
        let mut s = String::new();
        while self.pos < self.chars.len() {
            let ch = self.chars[self.pos];
            if ch.is_ascii_lowercase() || ch == '_' || ch.is_ascii_digit() {
                s.push(ch);
                self.pos += 1;
            } else {
                break;
            }
        }
        s
    }

    fn read_string_literal(&mut self) -> String {
        // Opening '"' already consumed
        let mut s = String::new();
        while self.pos < self.chars.len() {
            let ch = self.chars[self.pos];
            self.pos += 1;
            if ch == '"' {
                break;
            }
            if ch == '\\' && self.pos < self.chars.len() {
                let esc = self.chars[self.pos];
                self.pos += 1;
                match esc {
                    'n' => s.push('\n'),
                    't' => s.push('\t'),
                    '\\' => s.push('\\'),
                    '"' => s.push('"'),
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

    fn next_token(&mut self) -> Token {
        loop {
            self.skip_whitespace_not_newline();
            if self.pos >= self.chars.len() {
                return Token::Eof;
            }
            let ch = self.peek();

            // Block comment
            if ch == '/' && self.peek_next() == '*' {
                self.pos += 2;
                self.skip_block_comment();
                continue;
            }

            // Line comment
            if ch == '#' {
                self.skip_line_comment();
                continue;
            }

            break;
        }

        if self.pos >= self.chars.len() {
            return Token::Eof;
        }

        let ch = self.peek();

        // Newline
        if ch == '\n' {
            self.advance();
            return Token::Newline;
        }

        // Backslash followed by newline => line continuation, skip both
        if ch == '\\' && self.peek_next() == '\n' {
            self.pos += 2;
            return self.next_token();
        }

        // Number
        if ch.is_ascii_digit() || (ch == '.' && self.peek_next().is_ascii_digit()) {
            let num = self.read_number();
            return Token::Number(num);
        }

        // String literal
        if ch == '"' {
            self.advance();
            let s = self.read_string_literal();
            return Token::StringLit(s);
        }

        // Identifiers and keywords
        if ch.is_ascii_lowercase() || ch == '_' {
            let ident = self.read_ident();
            return match ident.as_str() {
                "if" => Token::If,
                "else" => Token::Else,
                "while" => Token::While,
                "for" => Token::For,
                "break" => Token::Break,
                "continue" => Token::Continue,
                "define" => Token::Define,
                "return" => Token::Return,
                "auto" => Token::Auto,
                "quit" => Token::Quit,
                "halt" => Token::Halt,
                "print" => Token::Print,
                _ => Token::Ident(ident),
            };
        }

        // Operators and punctuation
        self.advance();
        match ch {
            '+' => {
                if self.peek() == '+' {
                    self.advance();
                    Token::PlusPlus
                } else if self.peek() == '=' {
                    self.advance();
                    Token::PlusAssign
                } else {
                    Token::Plus
                }
            }
            '-' => {
                if self.peek() == '-' {
                    self.advance();
                    Token::MinusMinus
                } else if self.peek() == '=' {
                    self.advance();
                    Token::MinusAssign
                } else {
                    Token::Minus
                }
            }
            '*' => {
                if self.peek() == '=' {
                    self.advance();
                    Token::StarAssign
                } else {
                    Token::Star
                }
            }
            '/' => {
                if self.peek() == '=' {
                    self.advance();
                    Token::SlashAssign
                } else {
                    Token::Slash
                }
            }
            '%' => {
                if self.peek() == '=' {
                    self.advance();
                    Token::PercentAssign
                } else {
                    Token::Percent
                }
            }
            '^' => {
                if self.peek() == '=' {
                    self.advance();
                    Token::CaretAssign
                } else {
                    Token::Caret
                }
            }
            '=' => {
                if self.peek() == '=' {
                    self.advance();
                    Token::Eq
                } else {
                    Token::Assign
                }
            }
            '!' => {
                if self.peek() == '=' {
                    self.advance();
                    Token::Ne
                } else {
                    Token::Not
                }
            }
            '<' => {
                if self.peek() == '=' {
                    self.advance();
                    Token::Le
                } else {
                    Token::Lt
                }
            }
            '>' => {
                if self.peek() == '=' {
                    self.advance();
                    Token::Ge
                } else {
                    Token::Gt
                }
            }
            '&' => {
                if self.peek() == '&' {
                    self.advance();
                    Token::And
                } else {
                    // Single & not used in bc, treat as error / ignore
                    Token::And
                }
            }
            '|' => {
                if self.peek() == '|' {
                    self.advance();
                    Token::Or
                } else {
                    Token::Or
                }
            }
            '(' => Token::LParen,
            ')' => Token::RParen,
            '{' => Token::LBrace,
            '}' => Token::RBrace,
            '[' => Token::LBracket,
            ']' => Token::RBracket,
            ';' => Token::Semicolon,
            ',' => Token::Comma,
            _ => {
                // Skip unknown characters
                self.next_token()
            }
        }
    }

    fn tokenize_all(&mut self) -> Vec<Token> {
        let mut tokens = Vec::new();
        loop {
            let tok = self.next_token();
            let is_eof = tok == Token::Eof;
            tokens.push(tok);
            if is_eof {
                break;
            }
        }
        tokens
    }
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Expr {
    Number(String), // raw string, parsed respecting ibase at eval time
    StringLit(String),
    Var(String),
    ArrayAccess(String, Box<Expr>),
    Assign(Box<Expr>, Box<Expr>),
    CompoundAssign(String, Box<Expr>, Box<Expr>), // op, lhs, rhs
    PreInc(Box<Expr>),
    PreDec(Box<Expr>),
    PostInc(Box<Expr>),
    PostDec(Box<Expr>),
    BinaryOp(String, Box<Expr>, Box<Expr>),
    UnaryMinus(Box<Expr>),
    Not(Box<Expr>),
    FnCall(String, Vec<Expr>),
    // Special variables
    Scale,
    Ibase,
    Obase,
    Last,
}

#[derive(Debug, Clone)]
enum Stmt {
    Expr(Expr),
    If(Expr, Vec<Stmt>, Option<Vec<Stmt>>),
    While(Expr, Vec<Stmt>),
    For(Option<Expr>, Option<Expr>, Option<Expr>, Vec<Stmt>),
    Define(String, Vec<String>, Vec<String>, Vec<Stmt>), // name, params, auto_vars, body
    Return(Option<Expr>),
    Break,
    Continue,
    Quit,
    Halt,
    Print(Vec<Expr>),
    Empty,
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Parser { tokens, pos: 0 }
    }

    fn peek(&self) -> &Token {
        if self.pos < self.tokens.len() {
            &self.tokens[self.pos]
        } else {
            &Token::Eof
        }
    }

    fn advance(&mut self) -> Token {
        if self.pos < self.tokens.len() {
            let tok = self.tokens[self.pos].clone();
            self.pos += 1;
            tok
        } else {
            Token::Eof
        }
    }

    fn expect(&mut self, expected: &Token) -> bool {
        if self.peek() == expected {
            self.advance();
            true
        } else {
            false
        }
    }

    fn skip_newlines(&mut self) {
        while matches!(self.peek(), Token::Newline) {
            self.advance();
        }
    }

    fn skip_terminators(&mut self) {
        while matches!(self.peek(), Token::Newline | Token::Semicolon) {
            self.advance();
        }
    }

    fn parse_program(&mut self) -> Vec<Stmt> {
        let mut stmts = Vec::new();
        self.skip_terminators();
        while !matches!(self.peek(), Token::Eof) {
            let stmt = self.parse_stmt();
            stmts.push(stmt);
            self.skip_terminators();
        }
        stmts
    }

    fn parse_stmt(&mut self) -> Stmt {
        match self.peek().clone() {
            Token::If => self.parse_if(),
            Token::While => self.parse_while(),
            Token::For => self.parse_for(),
            Token::Define => self.parse_define(),
            Token::Return => self.parse_return(),
            Token::Break => {
                self.advance();
                Stmt::Break
            }
            Token::Continue => {
                self.advance();
                Stmt::Continue
            }
            Token::Quit => {
                self.advance();
                Stmt::Quit
            }
            Token::Halt => {
                self.advance();
                Stmt::Halt
            }
            Token::Print => self.parse_print(),
            Token::LBrace => {
                // Block as a statement — parse statements inside braces
                self.advance();
                let stmts = self.parse_block_inner();
                if !self.expect(&Token::RBrace) {
                    eprintln!("bc: expected '}}' after block");
                }
                // Return first stmt or empty
                if stmts.len() == 1 {
                    stmts.into_iter().next().unwrap()
                } else if stmts.is_empty() {
                    Stmt::Empty
                } else {
                    // Wrap in a pseudo-if(1) to hold multiple statements
                    Stmt::If(Expr::Number("1".to_string()), stmts, None)
                }
            }
            Token::Newline | Token::Semicolon => {
                self.advance();
                Stmt::Empty
            }
            Token::Eof => Stmt::Empty,
            _ => {
                let expr = self.parse_expr();
                Stmt::Expr(expr)
            }
        }
    }

    fn parse_if(&mut self) -> Stmt {
        self.advance(); // consume 'if'
        if !self.expect(&Token::LParen) {
            eprintln!("bc: expected '(' after 'if'");
        }
        let cond = self.parse_expr();
        if !self.expect(&Token::RParen) {
            eprintln!("bc: expected ')' after if condition");
        }
        self.skip_newlines();
        let then_body = self.parse_block_or_stmt();
        self.skip_newlines();
        let else_body = if matches!(self.peek(), Token::Else) {
            self.advance();
            self.skip_newlines();
            Some(self.parse_block_or_stmt())
        } else {
            None
        };
        Stmt::If(cond, then_body, else_body)
    }

    fn parse_while(&mut self) -> Stmt {
        self.advance(); // consume 'while'
        if !self.expect(&Token::LParen) {
            eprintln!("bc: expected '(' after 'while'");
        }
        let cond = self.parse_expr();
        if !self.expect(&Token::RParen) {
            eprintln!("bc: expected ')' after while condition");
        }
        self.skip_newlines();
        let body = self.parse_block_or_stmt();
        Stmt::While(cond, body)
    }

    fn parse_for(&mut self) -> Stmt {
        self.advance(); // consume 'for'
        if !self.expect(&Token::LParen) {
            eprintln!("bc: expected '(' after 'for'");
        }
        let init = if matches!(self.peek(), Token::Semicolon) {
            None
        } else {
            Some(self.parse_expr())
        };
        if !self.expect(&Token::Semicolon) {
            eprintln!("bc: expected ';' in for");
        }
        let cond = if matches!(self.peek(), Token::Semicolon) {
            None
        } else {
            Some(self.parse_expr())
        };
        if !self.expect(&Token::Semicolon) {
            eprintln!("bc: expected ';' in for");
        }
        let update = if matches!(self.peek(), Token::RParen) {
            None
        } else {
            Some(self.parse_expr())
        };
        if !self.expect(&Token::RParen) {
            eprintln!("bc: expected ')' after for clauses");
        }
        self.skip_newlines();
        let body = self.parse_block_or_stmt();
        Stmt::For(init, cond, update, body)
    }

    fn parse_define(&mut self) -> Stmt {
        self.advance(); // consume 'define'
        self.skip_newlines();
        let name = if let Token::Ident(n) = self.peek().clone() {
            self.advance();
            n
        } else {
            eprintln!("bc: expected function name after 'define'");
            "unknown".to_string()
        };
        if !self.expect(&Token::LParen) {
            eprintln!("bc: expected '(' after function name");
        }
        let mut params = Vec::new();
        while !matches!(self.peek(), Token::RParen | Token::Eof) {
            if let Token::Ident(p) = self.peek().clone() {
                self.advance();
                params.push(p);
            } else {
                break;
            }
            if !matches!(self.peek(), Token::Comma) {
                break;
            }
            self.advance(); // consume comma
        }
        if !self.expect(&Token::RParen) {
            eprintln!("bc: expected ')' after parameters");
        }
        self.skip_newlines();
        if !self.expect(&Token::LBrace) {
            eprintln!("bc: expected '{{' after function declaration");
        }
        self.skip_terminators();
        // Parse auto variables
        let mut auto_vars = Vec::new();
        if matches!(self.peek(), Token::Auto) {
            self.advance();
            loop {
                self.skip_whitespace_tokens();
                if let Token::Ident(v) = self.peek().clone() {
                    self.advance();
                    auto_vars.push(v);
                } else {
                    break;
                }
                if matches!(self.peek(), Token::Comma) {
                    self.advance();
                } else if matches!(self.peek(), Token::Semicolon | Token::Newline) {
                    self.advance();
                    break;
                } else {
                    break;
                }
            }
            self.skip_terminators();
        }
        let mut body = Vec::new();
        while !matches!(self.peek(), Token::RBrace | Token::Eof) {
            let stmt = self.parse_stmt();
            body.push(stmt);
            self.skip_terminators();
        }
        if !self.expect(&Token::RBrace) {
            eprintln!("bc: expected '}}' at end of function");
        }
        Stmt::Define(name, params, auto_vars, body)
    }

    fn parse_return(&mut self) -> Stmt {
        self.advance(); // consume 'return'
        if matches!(
            self.peek(),
            Token::Newline | Token::Semicolon | Token::RBrace | Token::Eof
        ) {
            Stmt::Return(None)
        } else if matches!(self.peek(), Token::LParen) {
            // return (expr) or return(expr)
            self.advance(); // consume '('
            if matches!(self.peek(), Token::RParen) {
                self.advance();
                Stmt::Return(Some(Expr::Number("0".to_string())))
            } else {
                let e = self.parse_expr();
                self.expect(&Token::RParen);
                Stmt::Return(Some(e))
            }
        } else {
            let e = self.parse_expr();
            Stmt::Return(Some(e))
        }
    }

    fn parse_print(&mut self) -> Stmt {
        self.advance(); // consume 'print'
        let mut exprs = Vec::new();
        loop {
            if matches!(self.peek(), Token::Newline | Token::Semicolon | Token::Eof) {
                break;
            }
            exprs.push(self.parse_expr());
            if !matches!(self.peek(), Token::Comma) {
                break;
            }
            self.advance(); // consume comma
        }
        Stmt::Print(exprs)
    }

    fn parse_block_or_stmt(&mut self) -> Vec<Stmt> {
        if matches!(self.peek(), Token::LBrace) {
            self.advance();
            let stmts = self.parse_block_inner();
            if !self.expect(&Token::RBrace) {
                eprintln!("bc: expected '}}' after block");
            }
            stmts
        } else {
            vec![self.parse_stmt()]
        }
    }

    fn parse_block_inner(&mut self) -> Vec<Stmt> {
        let mut stmts = Vec::new();
        self.skip_terminators();
        while !matches!(self.peek(), Token::RBrace | Token::Eof) {
            let stmt = self.parse_stmt();
            stmts.push(stmt);
            self.skip_terminators();
        }
        stmts
    }

    fn skip_whitespace_tokens(&mut self) {
        // no-op since our tokenizer handles whitespace
    }

    // Expression parsing with precedence climbing
    fn parse_expr(&mut self) -> Expr {
        self.parse_assign()
    }

    fn parse_assign(&mut self) -> Expr {
        let lhs = self.parse_or();

        match self.peek().clone() {
            Token::Assign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::Assign(Box::new(lhs), Box::new(rhs))
            }
            Token::PlusAssign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::CompoundAssign("+".to_string(), Box::new(lhs), Box::new(rhs))
            }
            Token::MinusAssign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::CompoundAssign("-".to_string(), Box::new(lhs), Box::new(rhs))
            }
            Token::StarAssign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::CompoundAssign("*".to_string(), Box::new(lhs), Box::new(rhs))
            }
            Token::SlashAssign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::CompoundAssign("/".to_string(), Box::new(lhs), Box::new(rhs))
            }
            Token::PercentAssign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::CompoundAssign("%".to_string(), Box::new(lhs), Box::new(rhs))
            }
            Token::CaretAssign => {
                self.advance();
                let rhs = self.parse_assign();
                Expr::CompoundAssign("^".to_string(), Box::new(lhs), Box::new(rhs))
            }
            _ => lhs,
        }
    }

    fn parse_or(&mut self) -> Expr {
        let mut lhs = self.parse_and();
        while matches!(self.peek(), Token::Or) {
            self.advance();
            let rhs = self.parse_and();
            lhs = Expr::BinaryOp("||".to_string(), Box::new(lhs), Box::new(rhs));
        }
        lhs
    }

    fn parse_and(&mut self) -> Expr {
        let mut lhs = self.parse_comparison();
        while matches!(self.peek(), Token::And) {
            self.advance();
            let rhs = self.parse_comparison();
            lhs = Expr::BinaryOp("&&".to_string(), Box::new(lhs), Box::new(rhs));
        }
        lhs
    }

    fn parse_comparison(&mut self) -> Expr {
        let mut lhs = self.parse_add();
        loop {
            let op = match self.peek() {
                Token::Eq => "==",
                Token::Ne => "!=",
                Token::Lt => "<",
                Token::Le => "<=",
                Token::Gt => ">",
                Token::Ge => ">=",
                _ => break,
            };
            let op = op.to_string();
            self.advance();
            let rhs = self.parse_add();
            lhs = Expr::BinaryOp(op, Box::new(lhs), Box::new(rhs));
        }
        lhs
    }

    fn parse_add(&mut self) -> Expr {
        let mut lhs = self.parse_mul();
        loop {
            match self.peek() {
                Token::Plus => {
                    self.advance();
                    let rhs = self.parse_mul();
                    lhs = Expr::BinaryOp("+".to_string(), Box::new(lhs), Box::new(rhs));
                }
                Token::Minus => {
                    self.advance();
                    let rhs = self.parse_mul();
                    lhs = Expr::BinaryOp("-".to_string(), Box::new(lhs), Box::new(rhs));
                }
                _ => break,
            }
        }
        lhs
    }

    fn parse_mul(&mut self) -> Expr {
        let mut lhs = self.parse_power();
        loop {
            match self.peek() {
                Token::Star => {
                    self.advance();
                    let rhs = self.parse_power();
                    lhs = Expr::BinaryOp("*".to_string(), Box::new(lhs), Box::new(rhs));
                }
                Token::Slash => {
                    self.advance();
                    let rhs = self.parse_power();
                    lhs = Expr::BinaryOp("/".to_string(), Box::new(lhs), Box::new(rhs));
                }
                Token::Percent => {
                    self.advance();
                    let rhs = self.parse_power();
                    lhs = Expr::BinaryOp("%".to_string(), Box::new(lhs), Box::new(rhs));
                }
                _ => break,
            }
        }
        lhs
    }

    fn parse_power(&mut self) -> Expr {
        let base = self.parse_unary();
        if matches!(self.peek(), Token::Caret) {
            self.advance();
            let exp = self.parse_power(); // right-associative
            Expr::BinaryOp("^".to_string(), Box::new(base), Box::new(exp))
        } else {
            base
        }
    }

    fn parse_unary(&mut self) -> Expr {
        match self.peek().clone() {
            Token::Minus => {
                self.advance();
                let operand = self.parse_unary();
                Expr::UnaryMinus(Box::new(operand))
            }
            Token::Not => {
                self.advance();
                let operand = self.parse_unary();
                Expr::Not(Box::new(operand))
            }
            Token::PlusPlus => {
                self.advance();
                let operand = self.parse_postfix();
                Expr::PreInc(Box::new(operand))
            }
            Token::MinusMinus => {
                self.advance();
                let operand = self.parse_postfix();
                Expr::PreDec(Box::new(operand))
            }
            _ => self.parse_postfix(),
        }
    }

    fn parse_postfix(&mut self) -> Expr {
        let mut expr = self.parse_primary();
        loop {
            match self.peek() {
                Token::PlusPlus => {
                    self.advance();
                    expr = Expr::PostInc(Box::new(expr));
                }
                Token::MinusMinus => {
                    self.advance();
                    expr = Expr::PostDec(Box::new(expr));
                }
                _ => break,
            }
        }
        expr
    }

    fn parse_primary(&mut self) -> Expr {
        match self.peek().clone() {
            Token::Number(n) => {
                self.advance();
                Expr::Number(n)
            }
            Token::StringLit(s) => {
                self.advance();
                Expr::StringLit(s)
            }
            Token::LParen => {
                self.advance();
                let expr = self.parse_expr();
                if !self.expect(&Token::RParen) {
                    eprintln!("bc: expected ')'");
                }
                expr
            }
            Token::Ident(name) => {
                self.advance();
                // Check for special variables
                match name.as_str() {
                    "scale" => {
                        if matches!(self.peek(), Token::LParen) {
                            // scale(expr) built-in function
                            self.advance();
                            let arg = self.parse_expr();
                            if !self.expect(&Token::RParen) {
                                eprintln!("bc: expected ')'");
                            }
                            Expr::FnCall("scale".to_string(), vec![arg])
                        } else if matches!(self.peek(), Token::LBracket) {
                            // scale as array name (unlikely but handle)
                            self.advance();
                            let idx = self.parse_expr();
                            if !self.expect(&Token::RBracket) {
                                eprintln!("bc: expected ']'");
                            }
                            Expr::ArrayAccess("scale".to_string(), Box::new(idx))
                        } else {
                            Expr::Scale
                        }
                    }
                    "ibase" => Expr::Ibase,
                    "obase" => Expr::Obase,
                    "last" => Expr::Last,
                    _ => {
                        if matches!(self.peek(), Token::LParen) {
                            // Function call
                            self.advance();
                            let mut args = Vec::new();
                            while !matches!(self.peek(), Token::RParen | Token::Eof) {
                                args.push(self.parse_expr());
                                if !matches!(self.peek(), Token::Comma) {
                                    break;
                                }
                                self.advance(); // consume comma
                            }
                            if !self.expect(&Token::RParen) {
                                eprintln!("bc: expected ')'");
                            }
                            Expr::FnCall(name, args)
                        } else if matches!(self.peek(), Token::LBracket) {
                            // Array access
                            self.advance();
                            let idx = self.parse_expr();
                            if !self.expect(&Token::RBracket) {
                                eprintln!("bc: expected ']'");
                            }
                            Expr::ArrayAccess(name, Box::new(idx))
                        } else {
                            Expr::Var(name)
                        }
                    }
                }
            }
            _ => {
                // For error recovery, consume the token and return 0
                let tok = self.advance();
                if !matches!(tok, Token::Eof | Token::Newline | Token::Semicolon) {
                    eprintln!("bc: unexpected token: {:?}", tok);
                }
                Expr::Number("0".to_string())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Function {
    params: Vec<String>,
    auto_vars: Vec<String>,
    body: Vec<Stmt>,
}

enum ControlFlow {
    None,
    Return(f64),
    Break,
    Continue,
}

struct Env {
    vars: HashMap<String, f64>,
    arrays: HashMap<String, HashMap<i64, f64>>,
    functions: HashMap<String, Function>,
    scale: u32,
    ibase: u32,
    obase: u32,
    last: f64,
    math_lib: bool,
}

impl Env {
    fn new(math_lib: bool) -> Self {
        Env {
            vars: HashMap::new(),
            arrays: HashMap::new(),
            functions: HashMap::new(),
            scale: if math_lib { 20 } else { 0 },
            ibase: 10,
            obase: 10,
            last: 0.0,
            math_lib,
        }
    }

    fn get_var(&self, name: &str) -> f64 {
        *self.vars.get(name).unwrap_or(&0.0)
    }

    fn set_var(&mut self, name: &str, val: f64) {
        self.vars.insert(name.to_string(), val);
    }

    fn get_array(&self, name: &str, idx: i64) -> f64 {
        self.arrays
            .get(name)
            .and_then(|a| a.get(&idx))
            .copied()
            .unwrap_or(0.0)
    }

    fn set_array(&mut self, name: &str, idx: i64, val: f64) {
        self.arrays
            .entry(name.to_string())
            .or_default()
            .insert(idx, val);
    }

    fn parse_number(&self, s: &str) -> f64 {
        if self.ibase == 10 {
            s.parse::<f64>().unwrap_or(0.0)
        } else {
            parse_number_radix(s, self.ibase)
        }
    }

    fn format_number(&self, n: f64) -> String {
        if self.obase != 10 {
            return format_number_obase(n, self.obase, self.scale);
        }
        if self.scale == 0 {
            if n == n.trunc() && n.abs() < 1e15 {
                return format!("{}", n as i64);
            }
            return format!("{}", n);
        }
        // With scale, check if the value is effectively an integer
        let truncated = n.trunc();
        let frac = (n - truncated).abs();
        let epsilon = 0.5 * 10f64.powi(-(self.scale as i32));
        if frac < epsilon {
            // Integer value — print without decimal
            if truncated.abs() < 1e15 {
                return format!("{}", truncated as i64);
            }
            return format!("{}", truncated);
        }
        format!("{:.*}", self.scale as usize, n)
    }
}

fn parse_number_radix(s: &str, radix: u32) -> f64 {
    let negative = s.starts_with('-');
    let s = if negative { &s[1..] } else { s };
    let parts: Vec<&str> = s.split('.').collect();

    let mut int_val: f64 = 0.0;
    for ch in parts[0].chars() {
        let d = char_to_digit(ch, radix);
        int_val = int_val * radix as f64 + d as f64;
    }

    let frac_val = if parts.len() > 1 {
        let mut frac = 0.0;
        let mut place = 1.0 / radix as f64;
        for ch in parts[1].chars() {
            let d = char_to_digit(ch, radix);
            frac += d as f64 * place;
            place /= radix as f64;
        }
        frac
    } else {
        0.0
    };

    let result = int_val + frac_val;
    if negative {
        -result
    } else {
        result
    }
}

fn char_to_digit(ch: char, _radix: u32) -> u32 {
    if ch.is_ascii_digit() {
        ch as u32 - '0' as u32
    } else if ch.is_ascii_uppercase() {
        ch as u32 - 'A' as u32 + 10
    } else {
        0
    }
}

fn format_number_obase(n: f64, radix: u32, scale: u32) -> String {
    if !(2..=36).contains(&radix) {
        return format!("{}", n);
    }
    let negative = n < 0.0;
    let abs_n = n.abs();
    let int_part = abs_n.trunc() as u64;

    let mut result = String::new();
    if int_part == 0 {
        result.push('0');
    } else {
        let mut digits = Vec::new();
        let mut val = int_part;
        while val > 0 {
            let d = (val % radix as u64) as u32;
            let ch = if d < 10 {
                (b'0' + d as u8) as char
            } else {
                (b'A' + (d - 10) as u8) as char
            };
            digits.push(ch);
            val /= radix as u64;
        }
        digits.reverse();
        result.extend(digits);
    }

    let frac = abs_n - abs_n.trunc();
    if scale > 0 && frac > 0.0 {
        result.push('.');
        let mut f = frac;
        for _ in 0..scale {
            f *= radix as f64;
            let d = f.trunc() as u32;
            let ch = if d < 10 {
                (b'0' + d as u8) as char
            } else {
                (b'A' + (d - 10) as u8) as char
            };
            result.push(ch);
            f -= f.trunc();
        }
    }

    if negative {
        format!("-{}", result)
    } else {
        result
    }
}

fn eval_expr(expr: &Expr, env: &mut Env) -> f64 {
    match expr {
        Expr::Number(s) => env.parse_number(s),
        Expr::StringLit(_) => 0.0,
        Expr::Var(name) => env.get_var(name),
        Expr::ArrayAccess(name, idx) => {
            let i = eval_expr(idx, env) as i64;
            env.get_array(name, i)
        }
        Expr::Scale => env.scale as f64,
        Expr::Ibase => env.ibase as f64,
        Expr::Obase => env.obase as f64,
        Expr::Last => env.last,
        Expr::Assign(lhs, rhs) => {
            let val = eval_expr(rhs, env);
            assign_to(lhs, val, env);
            val
        }
        Expr::CompoundAssign(op, lhs, rhs) => {
            let current = eval_expr(lhs, env);
            let rval = eval_expr(rhs, env);
            let result = apply_binop(op, current, rval, env);
            assign_to(lhs, result, env);
            result
        }
        Expr::PreInc(operand) => {
            let val = eval_expr(operand, env) + 1.0;
            assign_to(operand, val, env);
            val
        }
        Expr::PreDec(operand) => {
            let val = eval_expr(operand, env) - 1.0;
            assign_to(operand, val, env);
            val
        }
        Expr::PostInc(operand) => {
            let val = eval_expr(operand, env);
            assign_to(operand, val + 1.0, env);
            val
        }
        Expr::PostDec(operand) => {
            let val = eval_expr(operand, env);
            assign_to(operand, val - 1.0, env);
            val
        }
        Expr::BinaryOp(op, lhs, rhs) => {
            // Short-circuit for && and ||
            if op == "&&" {
                let l = eval_expr(lhs, env);
                if l == 0.0 {
                    return 0.0;
                }
                let r = eval_expr(rhs, env);
                return if r != 0.0 { 1.0 } else { 0.0 };
            }
            if op == "||" {
                let l = eval_expr(lhs, env);
                if l != 0.0 {
                    return 1.0;
                }
                let r = eval_expr(rhs, env);
                return if r != 0.0 { 1.0 } else { 0.0 };
            }
            let l = eval_expr(lhs, env);
            let r = eval_expr(rhs, env);
            apply_binop(op, l, r, env)
        }
        Expr::UnaryMinus(operand) => -eval_expr(operand, env),
        Expr::Not(operand) => {
            let val = eval_expr(operand, env);
            if val == 0.0 {
                1.0
            } else {
                0.0
            }
        }
        Expr::FnCall(name, args) => eval_fn_call(name, args, env),
    }
}

fn apply_binop(op: &str, l: f64, r: f64, env: &Env) -> f64 {
    match op {
        "+" => l + r,
        "-" => l - r,
        "*" => l * r,
        "/" => {
            if r == 0.0 {
                eprintln!("bc: divide by zero");
                0.0
            } else {
                let result = l / r;
                if env.scale == 0 {
                    result.trunc()
                } else {
                    let factor = 10f64.powi(env.scale as i32);
                    (result * factor).trunc() / factor
                }
            }
        }
        "%" => {
            if r == 0.0 {
                eprintln!("bc: remainder by zero");
                0.0
            } else {
                let quotient = (l / r).trunc();
                l - quotient * r
            }
        }
        "^" => l.powf(r),
        "==" => {
            if l == r {
                1.0
            } else {
                0.0
            }
        }
        "!=" => {
            if l != r {
                1.0
            } else {
                0.0
            }
        }
        "<" => {
            if l < r {
                1.0
            } else {
                0.0
            }
        }
        "<=" => {
            if l <= r {
                1.0
            } else {
                0.0
            }
        }
        ">" => {
            if l > r {
                1.0
            } else {
                0.0
            }
        }
        ">=" => {
            if l >= r {
                1.0
            } else {
                0.0
            }
        }
        _ => {
            eprintln!("bc: unknown operator '{}'", op);
            0.0
        }
    }
}

fn assign_to(lhs: &Expr, val: f64, env: &mut Env) {
    match lhs {
        Expr::Var(name) => env.set_var(name, val),
        Expr::ArrayAccess(name, idx) => {
            let i = eval_expr(idx, env) as i64;
            env.set_array(name, i, val);
        }
        Expr::Scale => {
            env.scale = val.max(0.0) as u32;
        }
        Expr::Ibase => {
            let v = val as u32;
            if (2..=36).contains(&v) {
                env.ibase = v;
            } else {
                eprintln!("bc: ibase must be between 2 and 36");
            }
        }
        Expr::Obase => {
            let v = val as u32;
            if (2..=36).contains(&v) {
                env.obase = v;
            } else {
                eprintln!("bc: obase must be between 2 and 36");
            }
        }
        _ => {
            eprintln!("bc: invalid assignment target");
        }
    }
}

fn eval_fn_call(name: &str, args: &[Expr], env: &mut Env) -> f64 {
    // Built-in functions
    match name {
        "length" => {
            if args.len() != 1 {
                eprintln!("bc: length() requires 1 argument");
                return 0.0;
            }
            let val = eval_expr(&args[0], env);
            return bc_length(val);
        }
        "sqrt" => {
            if args.len() != 1 {
                eprintln!("bc: sqrt() requires 1 argument");
                return 0.0;
            }
            let val = eval_expr(&args[0], env);
            if val < 0.0 {
                eprintln!("bc: square root of negative number");
                return 0.0;
            }
            return val.sqrt();
        }
        "scale" => {
            if args.len() != 1 {
                eprintln!("bc: scale() requires 1 argument");
                return 0.0;
            }
            let val = eval_expr(&args[0], env);
            return bc_scale(val);
        }
        _ => {}
    }

    // Math library functions
    if env.math_lib {
        match name {
            "s" => {
                if args.len() != 1 {
                    eprintln!("bc: s() requires 1 argument");
                    return 0.0;
                }
                return eval_expr(&args[0], env).sin();
            }
            "c" => {
                if args.len() != 1 {
                    eprintln!("bc: c() requires 1 argument");
                    return 0.0;
                }
                return eval_expr(&args[0], env).cos();
            }
            "a" => {
                if args.len() != 1 {
                    eprintln!("bc: a() requires 1 argument");
                    return 0.0;
                }
                return eval_expr(&args[0], env).atan();
            }
            "l" => {
                if args.len() != 1 {
                    eprintln!("bc: l() requires 1 argument");
                    return 0.0;
                }
                let val = eval_expr(&args[0], env);
                if val <= 0.0 {
                    eprintln!("bc: log of non-positive number");
                    return 0.0;
                }
                return val.ln();
            }
            "e" => {
                if args.len() != 1 {
                    eprintln!("bc: e() requires 1 argument");
                    return 0.0;
                }
                return eval_expr(&args[0], env).exp();
            }
            "j" => {
                // Bessel function — return 0.0 with note
                if args.len() != 2 {
                    eprintln!("bc: j() requires 2 arguments");
                    return 0.0;
                }
                // Bessel function not fully implemented, return 0
                let _n = eval_expr(&args[0], env);
                let _x = eval_expr(&args[1], env);
                return 0.0;
            }
            _ => {}
        }
    }

    // User-defined functions
    let func = match env.functions.get(name) {
        Some(f) => f.clone(),
        None => {
            eprintln!("bc: undefined function: {}", name);
            return 0.0;
        }
    };

    // Evaluate arguments
    let mut arg_vals = Vec::new();
    for arg in args {
        arg_vals.push(eval_expr(arg, env));
    }

    // Save current variables and set params
    let mut saved = HashMap::new();
    for (i, param) in func.params.iter().enumerate() {
        if let Some(old) = env.vars.get(param) {
            saved.insert(param.clone(), *old);
        }
        let val = arg_vals.get(i).copied().unwrap_or(0.0);
        env.set_var(param, val);
    }
    // Save and init auto vars
    for auto_var in &func.auto_vars {
        if let Some(old) = env.vars.get(auto_var) {
            saved.insert(auto_var.clone(), *old);
        }
        env.set_var(auto_var, 0.0);
    }

    // Execute body
    let mut result = 0.0;
    for stmt in &func.body {
        let cf = eval_stmt(stmt, env, &mut io::BufWriter::new(io::sink()));
        match cf {
            ControlFlow::Return(v) => {
                result = v;
                break;
            }
            ControlFlow::Break | ControlFlow::Continue => break,
            ControlFlow::None => {}
        }
    }

    // Restore variables
    for (i, param) in func.params.iter().enumerate() {
        if let Some(old) = saved.get(param) {
            env.set_var(param, *old);
        } else if i < func.params.len() {
            env.vars.remove(param);
        }
    }
    for auto_var in &func.auto_vars {
        if let Some(old) = saved.get(auto_var) {
            env.set_var(auto_var, *old);
        } else {
            env.vars.remove(auto_var);
        }
    }

    result
}

fn bc_length(val: f64) -> f64 {
    if val == 0.0 {
        return 1.0;
    }
    let s = format!("{}", val.abs());
    let digits: usize = s.chars().filter(|c| c.is_ascii_digit()).count();
    digits as f64
}

fn bc_scale(val: f64) -> f64 {
    let s = format!("{}", val);
    if let Some(dot_pos) = s.find('.') {
        // Count digits after decimal point, excluding trailing zeros
        let after = &s[dot_pos + 1..];
        after.len() as f64
    } else {
        0.0
    }
}

fn eval_stmt<W: Write>(stmt: &Stmt, env: &mut Env, out: &mut BufWriter<W>) -> ControlFlow {
    match stmt {
        Stmt::Empty => ControlFlow::None,
        Stmt::Expr(expr) => {
            let val = eval_expr(expr, env);
            // Print the result if expression is not an assignment and not a compound
            // assignment and not an increment/decrement
            if should_print(expr) {
                env.last = val;
                let formatted = env.format_number(val);
                let _ = writeln!(out, "{}", formatted);
                let _ = out.flush();
            }
            ControlFlow::None
        }
        Stmt::If(cond, then_body, else_body) => {
            let cv = eval_expr(cond, env);
            if cv != 0.0 {
                for s in then_body {
                    let cf = eval_stmt(s, env, out);
                    match cf {
                        ControlFlow::None => {}
                        other => return other,
                    }
                }
            } else if let Some(eb) = else_body {
                for s in eb {
                    let cf = eval_stmt(s, env, out);
                    match cf {
                        ControlFlow::None => {}
                        other => return other,
                    }
                }
            }
            ControlFlow::None
        }
        Stmt::While(cond, body) => {
            loop {
                let cv = eval_expr(cond, env);
                if cv == 0.0 {
                    break;
                }
                let mut should_break = false;
                for s in body {
                    let cf = eval_stmt(s, env, out);
                    match cf {
                        ControlFlow::Break => {
                            should_break = true;
                            break;
                        }
                        ControlFlow::Continue => break,
                        ControlFlow::Return(v) => return ControlFlow::Return(v),
                        ControlFlow::None => {}
                    }
                }
                if should_break {
                    break;
                }
            }
            ControlFlow::None
        }
        Stmt::For(init, cond, update, body) => {
            if let Some(init_expr) = init {
                eval_expr(init_expr, env);
            }
            loop {
                if let Some(cond_expr) = cond {
                    let cv = eval_expr(cond_expr, env);
                    if cv == 0.0 {
                        break;
                    }
                }
                let mut should_break = false;
                for s in body {
                    let cf = eval_stmt(s, env, out);
                    match cf {
                        ControlFlow::Break => {
                            should_break = true;
                            break;
                        }
                        ControlFlow::Continue => break,
                        ControlFlow::Return(v) => return ControlFlow::Return(v),
                        ControlFlow::None => {}
                    }
                }
                if should_break {
                    break;
                }
                if let Some(update_expr) = update {
                    eval_expr(update_expr, env);
                }
            }
            ControlFlow::None
        }
        Stmt::Define(name, params, auto_vars, body) => {
            let func = Function {
                params: params.clone(),
                auto_vars: auto_vars.clone(),
                body: body.clone(),
            };
            env.functions.insert(name.clone(), func);
            ControlFlow::None
        }
        Stmt::Return(expr) => {
            let val = match expr {
                Some(e) => eval_expr(e, env),
                None => 0.0,
            };
            ControlFlow::Return(val)
        }
        Stmt::Break => ControlFlow::Break,
        Stmt::Continue => ControlFlow::Continue,
        Stmt::Quit => {
            std::process::exit(0);
        }
        Stmt::Halt => {
            std::process::exit(0);
        }
        Stmt::Print(exprs) => {
            for expr in exprs {
                match expr {
                    Expr::StringLit(s) => {
                        let _ = write!(out, "{}", s);
                    }
                    _ => {
                        let val = eval_expr(expr, env);
                        let formatted = env.format_number(val);
                        let _ = write!(out, "{}", formatted);
                    }
                }
            }
            let _ = out.flush();
            ControlFlow::None
        }
    }
}

fn should_print(expr: &Expr) -> bool {
    !matches!(
        expr,
        Expr::Assign(_, _)
            | Expr::CompoundAssign(_, _, _)
            | Expr::PreInc(_)
            | Expr::PreDec(_)
            | Expr::PostInc(_)
            | Expr::PostDec(_)
            | Expr::StringLit(_)
    )
}

fn run(input: &str, math_lib: bool) {
    let mut tokenizer = Tokenizer::new(input);
    let tokens = tokenizer.tokenize_all();
    let mut parser = Parser::new(tokens);
    let program = parser.parse_program();

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let mut env = Env::new(math_lib);

    for stmt in &program {
        let cf = eval_stmt(stmt, &mut env, &mut out);
        match cf {
            ControlFlow::Return(_) => {
                eprintln!("bc: return outside of function");
            }
            ControlFlow::Break => {
                eprintln!("bc: break outside of loop");
            }
            ControlFlow::Continue => {
                eprintln!("bc: continue outside of loop");
            }
            ControlFlow::None => {}
        }
    }
    let _ = out.flush();
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut math_lib = false;
    let mut files: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-l" => math_lib = true,
            "--mathlib" => math_lib = true,
            "-h" | "--help" => {
                println!("usage: bc [-l] [file ...]");
                return;
            }
            "--version" => {
                println!("bc 1.0");
                return;
            }
            _ => {
                if args[i].starts_with('-') {
                    // Handle combined flags like -lq
                    for ch in args[i][1..].chars() {
                        match ch {
                            'l' => math_lib = true,
                            'q' => {} // quiet mode (suppress banner), default behavior
                            _ => {
                                eprintln!("bc: unknown option: -{}", ch);
                                std::process::exit(1);
                            }
                        }
                    }
                } else {
                    files.push(args[i].clone());
                }
            }
        }
        i += 1;
    }

    let mut input = String::new();

    // Read files first
    for file in &files {
        match std::fs::read_to_string(file) {
            Ok(contents) => {
                input.push_str(&contents);
                input.push('\n');
            }
            Err(e) => {
                eprintln!("bc: {}: {}", file, e);
                std::process::exit(1);
            }
        }
    }

    // Then read stdin
    let mut stdin_buf = String::new();
    let _ = io::stdin().read_to_string(&mut stdin_buf);
    input.push_str(&stdin_buf);

    run(&input, math_lib);
}
