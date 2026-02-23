use crate::ast::{Assignment, CaseItem, Command, ListOp, Redirect, Word, WordPart};
use crate::lexer::lex;
use crate::token::Token;

/// Parse a shell command string into an AST.
pub fn parse(input: &str) -> Command {
    let tokens = lex(input);
    let mut parser = Parser::new(tokens);
    parser.parse_complete_command()
}

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn new(tokens: Vec<Token>) -> Self {
        Parser { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn advance(&mut self) -> Token {
        let token = self.tokens[self.pos].clone();
        self.pos += 1;
        token
    }

    fn expect(&mut self, expected: &Token) {
        let token = self.advance();
        assert_eq!(
            &token, expected,
            "expected {:?}, got {:?}",
            expected, token
        );
    }

    /// Skip optional semicolons and newlines (used between clauses).
    fn skip_separators(&mut self) {
        while let Some(token) = self.peek() {
            if *token == Token::Semi || *token == Token::Newline {
                self.advance();
            } else {
                break;
            }
        }
    }

    /// Check whether the current token is a list terminator that should stop
    /// list parsing. These are tokens that belong to an outer construct.
    fn at_list_terminator(&self) -> bool {
        match self.peek() {
            None => true,
            Some(token) => matches!(
                token,
                Token::Then
                    | Token::Else
                    | Token::Elif
                    | Token::Fi
                    | Token::Do
                    | Token::Done
                    | Token::RParen
                    | Token::RBrace
                    | Token::Esac
                    | Token::DoubleSemi
            ),
        }
    }

    /// Check whether the current token can start a command.
    fn at_command_start(&self) -> bool {
        match self.peek() {
            None => false,
            Some(token) => matches!(
                token,
                Token::Word(_)
                    | Token::DoubleQuoted(_)
                    | Token::Assignment(_, _)
                    | Token::Variable(_)
                    | Token::CommandSub(_)
                    | Token::Redirect(_)
                    | Token::If
                    | Token::For
                    | Token::While
                    | Token::LParen
                    | Token::Break
                    | Token::Continue
                    | Token::Bang
                    | Token::Case
            ),
        }
    }

    // ----------------------------------------------------------------
    // Grammar rules
    // ----------------------------------------------------------------

    /// complete_command = list
    fn parse_complete_command(&mut self) -> Command {
        self.skip_separators();
        self.parse_list()
    }

    /// list = pipeline ((AND | OR | SEMI | NEWLINE) pipeline)*
    ///
    /// Left-associative. Semicolons and newlines followed by a list terminator
    /// or end-of-input are trailing separators, not sequence operators.
    fn parse_list(&mut self) -> Command {
        let mut left = self.parse_pipeline();

        loop {
            let op = match self.peek() {
                Some(Token::And) => ListOp::And,
                Some(Token::Or) => ListOp::Or,
                Some(Token::Semi) | Some(Token::Newline) => {
                    // Peek ahead: if the next meaningful token is a terminator
                    // or EOF, this semicolon/newline is just a trailing separator.
                    self.advance(); // consume the semicolon/newline
                    self.skip_newlines();
                    if self.at_list_terminator() || !self.at_command_start() {
                        break;
                    }
                    ListOp::Seq
                }
                _ => break,
            };

            // For And and Or we need to consume the operator token.
            if op != ListOp::Seq {
                self.advance();
                self.skip_newlines();
            }

            let right = self.parse_pipeline();
            left = Command::List {
                left: Box::new(left),
                op,
                right: Box::new(right),
            };
        }

        left
    }

    /// Skip newlines only (not semicolons).
    fn skip_newlines(&mut self) {
        while let Some(Token::Newline) = self.peek() {
            self.advance();
        }
    }

    /// pipeline = [BANG] command (PIPE command)*
    fn parse_pipeline(&mut self) -> Command {
        let negated = matches!(self.peek(), Some(Token::Bang));
        if negated { self.advance(); }

        let first = self.parse_command();
        let mut commands = vec![first];

        while let Some(Token::Pipe) = self.peek() {
            self.advance(); // consume pipe
            self.skip_newlines();
            commands.push(self.parse_command());
        }

        let result = if commands.len() == 1 {
            commands.remove(0)
        } else {
            Command::Pipeline { commands }
        };

        if negated {
            Command::Negate { body: Box::new(result) }
        } else {
            result
        }
    }

    /// command = if_clause | for_clause | while_clause | case_clause | subshell | function_def | simple_command
    fn parse_command(&mut self) -> Command {
        match self.peek() {
            Some(Token::If) => self.parse_if(),
            Some(Token::For) => self.parse_for(),
            Some(Token::While) => self.parse_while(),
            Some(Token::Case) => self.parse_case(),
            Some(Token::LParen) => self.parse_subshell(),
            Some(Token::Break) => { self.advance(); Command::Break }
            Some(Token::Continue) => { self.advance(); Command::Continue }
            _ => {
                // Check for function: name() { ... }
                if let Some(Token::Word(name)) = self.peek() {
                    if self.pos + 1 < self.tokens.len() && self.tokens[self.pos + 1] == Token::LParen {
                        if self.pos + 2 < self.tokens.len() && self.tokens[self.pos + 2] == Token::RParen {
                            let name = name.clone();
                            self.pos += 3; // consume name ( )
                            self.skip_separators();
                            self.expect(&Token::LBrace);
                            self.skip_separators();
                            let body = self.parse_list();
                            self.skip_separators();
                            self.expect(&Token::RBrace);
                            return Command::Function { name, body: Box::new(body) };
                        }
                    }
                }
                self.parse_simple_command()
            }
        }
    }

    /// simple_command = (assignment)* word* (redirect)*
    ///
    /// Assignments come first (before any non-assignment word). Redirects can
    /// appear anywhere but are collected separately.
    fn parse_simple_command(&mut self) -> Command {
        let mut words = Vec::new();
        let mut redirects = Vec::new();
        let mut assignments = Vec::new();
        let mut seen_word = false;

        loop {
            match self.peek() {
                Some(Token::Assignment(_, _)) if !seen_word => {
                    if let Token::Assignment(name, value) = self.advance() {
                        assignments.push(Assignment { name, value });
                    }
                }
                Some(Token::Word(_)) => {
                    seen_word = true;
                    if let Token::Word(w) = self.advance() {
                        words.push(Word::literal(&w));
                    }
                }
                Some(Token::Variable(_)) => {
                    seen_word = true;
                    if let Token::Variable(v) = self.advance() {
                        words.push(Word::variable(&v));
                    }
                }
                Some(Token::DoubleQuoted(_)) => {
                    seen_word = true;
                    if let Token::DoubleQuoted(parts) = self.advance() {
                        words.push(Word { parts });
                    }
                }
                Some(Token::CommandSub(_)) => {
                    seen_word = true;
                    if let Token::CommandSub(c) = self.advance() {
                        words.push(Word {
                            parts: vec![WordPart::CommandSub(c)],
                        });
                    }
                }
                Some(Token::Redirect(_)) => {
                    if let Token::Redirect(r) = self.advance() {
                        redirects.push(Redirect { redirect_type: r });
                    }
                }
                _ => break,
            }
        }

        Command::Simple {
            words,
            redirects,
            assignments,
        }
    }

    /// if_clause = IF list SEMI? THEN list (ELIF list SEMI? THEN list)* (ELSE list)? FI
    fn parse_if(&mut self) -> Command {
        self.expect(&Token::If);
        let condition = self.parse_list();
        self.skip_separators();
        self.expect(&Token::Then);
        let then_body = self.parse_list();
        self.skip_separators();

        let mut else_body = None;

        if let Some(Token::Elif) = self.peek() {
            // Treat `elif` as a nested if inside the else branch.
            else_body = Some(Box::new(self.parse_elif()));
        } else if let Some(Token::Else) = self.peek() {
            self.advance(); // consume else
            else_body = Some(Box::new(self.parse_list()));
            self.skip_separators();
        }

        self.expect(&Token::Fi);

        Command::If {
            condition: Box::new(condition),
            then_body: Box::new(then_body),
            else_body,
        }
    }

    /// Parse an elif chain as a nested If command (without consuming an outer Fi).
    fn parse_elif(&mut self) -> Command {
        self.expect(&Token::Elif);
        let condition = self.parse_list();
        self.skip_separators();
        self.expect(&Token::Then);
        let then_body = self.parse_list();
        self.skip_separators();

        let mut else_body = None;

        if let Some(Token::Elif) = self.peek() {
            else_body = Some(Box::new(self.parse_elif()));
        } else if let Some(Token::Else) = self.peek() {
            self.advance();
            else_body = Some(Box::new(self.parse_list()));
            self.skip_separators();
        }

        Command::If {
            condition: Box::new(condition),
            then_body: Box::new(then_body),
            else_body,
        }
    }

    /// for_clause = FOR word IN word* SEMI? DO list DONE
    fn parse_for(&mut self) -> Command {
        self.expect(&Token::For);
        let var = match self.advance() {
            Token::Word(w) => w,
            other => panic!("expected variable name after 'for', got {:?}", other),
        };
        self.expect(&Token::In);

        let mut words = Vec::new();
        loop {
            match self.peek() {
                Some(Token::Word(_)) => {
                    if let Token::Word(w) = self.advance() {
                        words.push(Word::literal(&w));
                    }
                }
                Some(Token::Variable(_)) => {
                    if let Token::Variable(v) = self.advance() {
                        words.push(Word::variable(&v));
                    }
                }
                Some(Token::DoubleQuoted(_)) => {
                    if let Token::DoubleQuoted(parts) = self.advance() {
                        words.push(Word { parts });
                    }
                }
                Some(Token::CommandSub(_)) => {
                    if let Token::CommandSub(c) = self.advance() {
                        words.push(Word {
                            parts: vec![WordPart::CommandSub(c)],
                        });
                    }
                }
                _ => break,
            }
        }

        self.skip_separators();
        self.expect(&Token::Do);
        let body = self.parse_list();
        self.skip_separators();
        self.expect(&Token::Done);

        Command::For {
            var,
            words,
            body: Box::new(body),
        }
    }

    /// while_clause = WHILE list SEMI? DO list DONE
    fn parse_while(&mut self) -> Command {
        self.expect(&Token::While);
        let condition = self.parse_list();
        self.skip_separators();
        self.expect(&Token::Do);
        let body = self.parse_list();
        self.skip_separators();
        self.expect(&Token::Done);

        Command::While {
            condition: Box::new(condition),
            body: Box::new(body),
        }
    }

    /// subshell = LPAREN list RPAREN
    fn parse_subshell(&mut self) -> Command {
        self.expect(&Token::LParen);
        let body = self.parse_list();
        self.skip_separators();
        self.expect(&Token::RParen);

        Command::Subshell {
            body: Box::new(body),
        }
    }

    /// case_clause = CASE word IN (case_item)* ESAC
    /// case_item = pattern (PIPE pattern)* RPAREN list DOUBLE_SEMI
    fn parse_case(&mut self) -> Command {
        self.expect(&Token::Case);
        let word = self.parse_word_token();
        self.expect(&Token::In);
        self.skip_separators();

        let mut items = Vec::new();
        while !matches!(self.peek(), Some(Token::Esac) | None) {
            // Parse patterns: pattern1 | pattern2 )
            let mut patterns = Vec::new();
            // Skip optional leading (
            if matches!(self.peek(), Some(Token::LParen)) {
                self.advance();
            }
            patterns.push(self.parse_word_token());
            while matches!(self.peek(), Some(Token::Pipe)) {
                self.advance();
                patterns.push(self.parse_word_token());
            }
            self.expect(&Token::RParen);
            self.skip_separators();

            // Parse body (may be empty)
            let body = if !matches!(self.peek(), Some(Token::DoubleSemi) | Some(Token::Esac) | None) {
                self.parse_list()
            } else {
                Command::Simple { words: vec![], redirects: vec![], assignments: vec![] }
            };

            items.push(CaseItem { patterns, body: Box::new(body) });

            // Expect ;; (or esac)
            if matches!(self.peek(), Some(Token::DoubleSemi)) {
                self.advance();
                self.skip_separators();
            }
        }

        self.expect(&Token::Esac);
        Command::Case { word, items }
    }

    /// Parse a single word token (Word, Variable, DoubleQuoted, CommandSub).
    fn parse_word_token(&mut self) -> Word {
        match self.peek() {
            Some(Token::Word(_)) => {
                if let Token::Word(w) = self.advance() { Word::literal(&w) } else { unreachable!() }
            }
            Some(Token::Variable(_)) => {
                if let Token::Variable(v) = self.advance() { Word::variable(&v) } else { unreachable!() }
            }
            Some(Token::DoubleQuoted(_)) => {
                if let Token::DoubleQuoted(parts) = self.advance() { Word { parts } } else { unreachable!() }
            }
            Some(Token::CommandSub(_)) => {
                if let Token::CommandSub(c) = self.advance() {
                    Word { parts: vec![WordPart::CommandSub(c)] }
                } else { unreachable!() }
            }
            other => panic!("expected word, got {:?}", other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::*;

    #[test]
    fn simple_command() {
        let cmd = parse("echo hello world");
        match cmd {
            Command::Simple {
                words,
                redirects,
                assignments,
            } => {
                assert_eq!(words.len(), 3);
                assert_eq!(words[0], Word::literal("echo"));
                assert_eq!(words[1], Word::literal("hello"));
                assert_eq!(words[2], Word::literal("world"));
                assert!(redirects.is_empty());
                assert!(assignments.is_empty());
            }
            _ => panic!("expected Simple command"),
        }
    }

    #[test]
    fn pipeline() {
        let cmd = parse("cat file | grep pattern | wc -l");
        match cmd {
            Command::Pipeline { commands } => {
                assert_eq!(commands.len(), 3);
            }
            _ => panic!("expected Pipeline"),
        }
    }

    #[test]
    fn list_and() {
        let cmd = parse("cmd1 && cmd2");
        match cmd {
            Command::List { op, .. } => {
                assert_eq!(op, ListOp::And);
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn list_or() {
        let cmd = parse("cmd1 || cmd2");
        match cmd {
            Command::List { op, .. } => {
                assert_eq!(op, ListOp::Or);
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn list_sequence() {
        let cmd = parse("cmd1 ; cmd2");
        match cmd {
            Command::List { op, .. } => {
                assert_eq!(op, ListOp::Seq);
            }
            _ => panic!("expected List"),
        }
    }

    #[test]
    fn redirect_stdout() {
        let cmd = parse("echo hello > file.txt");
        match cmd {
            Command::Simple { redirects, .. } => {
                assert_eq!(redirects.len(), 1);
            }
            _ => panic!("expected Simple with redirect"),
        }
    }

    #[test]
    fn if_then_fi() {
        let cmd = parse("if true; then echo yes; fi");
        match cmd {
            Command::If {
                condition,
                then_body,
                else_body,
            } => {
                assert!(else_body.is_none());
                // Verify the condition is a simple command with "true"
                match *condition {
                    Command::Simple { ref words, .. } => {
                        assert_eq!(words[0], Word::literal("true"));
                    }
                    _ => panic!("expected Simple condition"),
                }
                // Verify the then body
                match *then_body {
                    Command::Simple { ref words, .. } => {
                        assert_eq!(words[0], Word::literal("echo"));
                    }
                    _ => panic!("expected Simple then_body"),
                }
            }
            _ => panic!("expected If"),
        }
    }

    #[test]
    fn if_then_else_fi() {
        let cmd = parse("if true; then echo yes; else echo no; fi");
        match cmd {
            Command::If { else_body, .. } => {
                assert!(else_body.is_some());
            }
            _ => panic!("expected If"),
        }
    }

    #[test]
    fn for_loop() {
        let cmd = parse("for x in a b c; do echo $x; done");
        match cmd {
            Command::For { var, words, .. } => {
                assert_eq!(var, "x");
                assert_eq!(words.len(), 3);
            }
            _ => panic!("expected For"),
        }
    }

    #[test]
    fn while_loop() {
        let cmd = parse("while true; do echo loop; done");
        match cmd {
            Command::While { .. } => {}
            _ => panic!("expected While"),
        }
    }

    #[test]
    fn subshell() {
        let cmd = parse("( cmd1 ; cmd2 )");
        match cmd {
            Command::Subshell { .. } => {}
            _ => panic!("expected Subshell"),
        }
    }

    #[test]
    fn assignment() {
        let cmd = parse("FOO=bar echo $FOO");
        match cmd {
            Command::Simple {
                assignments,
                words,
                ..
            } => {
                assert_eq!(assignments.len(), 1);
                assert_eq!(assignments[0].name, "FOO");
                assert_eq!(assignments[0].value, "bar");
                assert_eq!(words.len(), 2);
            }
            _ => panic!("expected Simple with assignment"),
        }
    }

    #[test]
    fn variable_word() {
        let cmd = parse("echo $HOME");
        match cmd {
            Command::Simple { words, .. } => {
                assert_eq!(words.len(), 2);
                assert_eq!(words[1], Word::variable("HOME"));
            }
            _ => panic!("expected Simple"),
        }
    }

    #[test]
    fn command_substitution_word() {
        let cmd = parse("echo $(date)");
        match cmd {
            Command::Simple { words, .. } => {
                assert_eq!(words.len(), 2);
                assert_eq!(words[1].parts[0], WordPart::CommandSub("date".into()));
            }
            _ => panic!("expected Simple"),
        }
    }

    #[test]
    fn complex_and_or_chain() {
        // cmd1 && cmd2 || cmd3 should parse as (cmd1 && cmd2) || cmd3
        let cmd = parse("cmd1 && cmd2 || cmd3");
        match cmd {
            Command::List {
                op: ListOp::Or,
                left,
                ..
            } => match *left {
                Command::List {
                    op: ListOp::And, ..
                } => {}
                _ => panic!("expected inner And"),
            },
            _ => panic!("expected outer Or"),
        }
    }

    #[test]
    fn pipeline_in_list() {
        // cat file | grep x && echo found
        let cmd = parse("cat file | grep x && echo found");
        match cmd {
            Command::List {
                op: ListOp::And,
                left,
                ..
            } => match *left {
                Command::Pipeline { commands } => {
                    assert_eq!(commands.len(), 2);
                }
                _ => panic!("expected Pipeline on left"),
            },
            _ => panic!("expected List"),
        }
    }
}
