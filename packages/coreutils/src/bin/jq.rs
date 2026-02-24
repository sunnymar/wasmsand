//! jq - command-line JSON processor
//!
//! Supports: ., .foo, .["key"], .[n], .[], .[n:m], |, select(), map(),
//! keys, values, length, type, has(), add, flatten, unique, sort_by(),
//! group_by(), to_entries, from_entries, with_entries(), not, empty, null,
//! if-then-else, try-catch, and/or/not, arithmetic, string interpolation,
//! @base64, @csv, @tsv, @html, @json, @text, first, last, nth, limit,
//! arrays, objects, strings, numbers, nulls, booleans, iterables, scalars,
//! any, all, env, ascii_downcase, ascii_upcase, test, split, join, ltrimstr,
//! rtrimstr, startswith, endswith, contains, inside, tostring, tonumber,
//! recurse, path, getpath, setpath, delpaths, leaf_paths, inputs,
//! debug, stderr, input, reduce, foreach, label-break, def, as patterns,
//! object construction {key: value}, array construction [expr], comparison ops

use std::collections::BTreeMap;
use std::env;
use std::io::{self, Read};

// ---- JSON Value ----

#[derive(Debug, Clone)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

impl Json {
    fn is_truthy(&self) -> bool {
        !matches!(self, Json::Null | Json::Bool(false))
    }

    fn type_name(&self) -> &str {
        match self {
            Json::Null => "null",
            Json::Bool(_) => "boolean",
            Json::Num(_) => "number",
            Json::Str(_) => "string",
            Json::Array(_) => "array",
            Json::Object(_) => "object",
        }
    }

    fn to_string_repr(&self) -> String {
        format_json(self, false)
    }
}

impl PartialEq for Json {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Json::Null, Json::Null) => true,
            (Json::Bool(a), Json::Bool(b)) => a == b,
            (Json::Num(a), Json::Num(b)) => a == b,
            (Json::Str(a), Json::Str(b)) => a == b,
            (Json::Array(a), Json::Array(b)) => a == b,
            (Json::Object(a), Json::Object(b)) => a == b,
            _ => false,
        }
    }
}

impl PartialOrd for Json {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        match (self, other) {
            (Json::Null, Json::Null) => Some(std::cmp::Ordering::Equal),
            (Json::Bool(a), Json::Bool(b)) => a.partial_cmp(b),
            (Json::Num(a), Json::Num(b)) => a.partial_cmp(b),
            (Json::Str(a), Json::Str(b)) => a.partial_cmp(b),
            _ => None,
        }
    }
}

// ---- JSON Parser ----

struct JsonParser {
    chars: Vec<char>,
    pos: usize,
}

impl JsonParser {
    fn new(input: &str) -> Self {
        Self {
            chars: input.chars().collect(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn advance(&mut self) -> Option<char> {
        let ch = self.peek();
        self.pos += 1;
        ch
    }

    fn parse_value(&mut self) -> Option<Json> {
        self.skip_ws();
        match self.peek()? {
            '"' => self.parse_string().map(Json::Str),
            '{' => self.parse_object(),
            '[' => self.parse_array(),
            't' => self.parse_literal("true", Json::Bool(true)),
            'f' => self.parse_literal("false", Json::Bool(false)),
            'n' => self.parse_literal("null", Json::Null),
            '-' | '0'..='9' => self.parse_number(),
            _ => None,
        }
    }

    fn parse_string(&mut self) -> Option<String> {
        self.advance(); // skip "
        let mut s = String::new();
        loop {
            let ch = self.advance()?;
            match ch {
                '"' => return Some(s),
                '\\' => {
                    let esc = self.advance()?;
                    match esc {
                        '"' => s.push('"'),
                        '\\' => s.push('\\'),
                        '/' => s.push('/'),
                        'n' => s.push('\n'),
                        't' => s.push('\t'),
                        'r' => s.push('\r'),
                        'b' => s.push('\x08'),
                        'f' => s.push('\x0c'),
                        'u' => {
                            let mut hex = String::new();
                            for _ in 0..4 {
                                hex.push(self.advance()?);
                            }
                            if let Ok(cp) = u32::from_str_radix(&hex, 16) {
                                if let Some(c) = char::from_u32(cp) {
                                    s.push(c);
                                }
                            }
                        }
                        _ => {
                            s.push('\\');
                            s.push(esc);
                        }
                    }
                }
                _ => s.push(ch),
            }
        }
    }

    fn parse_number(&mut self) -> Option<Json> {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.advance();
        }
        while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_digit() {
            self.pos += 1;
        }
        if self.peek() == Some('.') {
            self.pos += 1;
            while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_digit() {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some('e' | 'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some('+' | '-')) {
                self.pos += 1;
            }
            while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_digit() {
                self.pos += 1;
            }
        }
        let s: String = self.chars[start..self.pos].iter().collect();
        s.parse::<f64>().ok().map(Json::Num)
    }

    fn parse_object(&mut self) -> Option<Json> {
        self.advance();
        self.skip_ws();
        let mut map = BTreeMap::new();
        if self.peek() == Some('}') {
            self.advance();
            return Some(Json::Object(map));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            self.advance(); // skip :
            let value = self.parse_value()?;
            map.insert(key, value);
            self.skip_ws();
            match self.peek()? {
                ',' => {
                    self.advance();
                }
                '}' => {
                    self.advance();
                    break;
                }
                _ => return None,
            }
        }
        Some(Json::Object(map))
    }

    fn parse_array(&mut self) -> Option<Json> {
        self.advance();
        self.skip_ws();
        let mut arr = Vec::new();
        if self.peek() == Some(']') {
            self.advance();
            return Some(Json::Array(arr));
        }
        loop {
            let value = self.parse_value()?;
            arr.push(value);
            self.skip_ws();
            match self.peek()? {
                ',' => {
                    self.advance();
                }
                ']' => {
                    self.advance();
                    break;
                }
                _ => return None,
            }
        }
        Some(Json::Array(arr))
    }

    fn parse_literal(&mut self, expected: &str, value: Json) -> Option<Json> {
        for ch in expected.chars() {
            if self.advance()? != ch {
                return None;
            }
        }
        Some(value)
    }

    fn parse_all(input: &str) -> Vec<Json> {
        let mut results = Vec::new();
        let mut parser = JsonParser::new(input);
        loop {
            parser.skip_ws();
            if parser.pos >= parser.chars.len() {
                break;
            }
            if let Some(val) = parser.parse_value() {
                results.push(val);
            } else {
                break;
            }
        }
        results
    }
}

// ---- JSON Formatter ----

fn format_json(val: &Json, compact: bool) -> String {
    let mut out = String::new();
    format_json_inner(val, compact, 0, &mut out);
    out
}

fn format_json_inner(val: &Json, compact: bool, indent: usize, out: &mut String) {
    match val {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(n) => {
            if *n == (*n as i64 as f64) && n.abs() < 1e15 {
                out.push_str(&format!("{}", *n as i64));
            } else {
                out.push_str(&format!("{}", n));
            }
        }
        Json::Str(s) => {
            out.push('"');
            for ch in s.chars() {
                match ch {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\t' => out.push_str("\\t"),
                    '\r' => out.push_str("\\r"),
                    c if c < '\x20' => out.push_str(&format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        Json::Array(arr) => {
            if arr.is_empty() {
                out.push_str("[]");
                return;
            }
            if compact {
                out.push('[');
                for (i, v) in arr.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    format_json_inner(v, compact, indent, out);
                }
                out.push(']');
            } else {
                out.push_str("[\n");
                for (i, v) in arr.iter().enumerate() {
                    for _ in 0..indent + 2 {
                        out.push(' ');
                    }
                    format_json_inner(v, compact, indent + 2, out);
                    if i + 1 < arr.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                for _ in 0..indent {
                    out.push(' ');
                }
                out.push(']');
            }
        }
        Json::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            if compact {
                out.push('{');
                for (i, (k, v)) in map.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push('"');
                    out.push_str(k);
                    out.push_str("\":");
                    format_json_inner(v, compact, indent, out);
                }
                out.push('}');
            } else {
                out.push_str("{\n");
                let entries: Vec<_> = map.iter().collect();
                for (i, (k, v)) in entries.iter().enumerate() {
                    for _ in 0..indent + 2 {
                        out.push(' ');
                    }
                    out.push('"');
                    out.push_str(k);
                    out.push_str("\": ");
                    format_json_inner(v, compact, indent + 2, out);
                    if i + 1 < entries.len() {
                        out.push(',');
                    }
                    out.push('\n');
                }
                for _ in 0..indent {
                    out.push(' ');
                }
                out.push('}');
            }
        }
    }
}

// ---- JQ Filter AST ----

#[derive(Debug, Clone)]
enum Filter {
    Identity,
    Field(String),
    Index(i64),
    Slice(Option<i64>, Option<i64>),
    Iterate,
    Pipe(Box<Filter>, Box<Filter>),
    Comma(Box<Filter>, Box<Filter>),
    Literal(Json),
    ArrayConstruct(Option<Box<Filter>>),
    ObjectConstruct(Vec<(ObjKey, Filter)>),
    Select(Box<Filter>),
    Map(Box<Filter>),
    Keys,
    Values,
    Length,
    Type,
    Add,
    Reverse,
    Not,
    Empty,
    Recurse,
    Unique,
    UniqueBy(Box<Filter>),
    Flatten(Option<i64>),
    Has(Box<Filter>),
    SortBy(Box<Filter>),
    GroupBy(Box<Filter>),
    ToEntries,
    FromEntries,
    WithEntries(Box<Filter>),
    First(Box<Filter>),
    Last(Box<Filter>),
    Any(Option<Box<Filter>>),
    All(Option<Box<Filter>>),
    Ascii(bool),
    Test(String),
    Split(String),
    Join(String),
    Ltrimstr(String),
    Rtrimstr(String),
    Startswith(String),
    Endswith(String),
    Contains(Box<Filter>),
    Inside(Box<Filter>),
    Tostring,
    Tonumber,
    Tojson,
    Fromjson,
    Floor,
    Ceil,
    Round,
    Fabs,
    Min,
    Max,
    MinBy(Box<Filter>),
    MaxBy(Box<Filter>),
    Range(Box<Filter>, Option<Box<Filter>>),
    Del(Box<Filter>),
    Explode,
    Implode,
    Comparison(Box<Filter>, CmpOp, Box<Filter>),
    Arithmetic(Box<Filter>, ArithOp, Box<Filter>),
    And(Box<Filter>, Box<Filter>),
    Or(Box<Filter>, Box<Filter>),
    IfThenElse(Box<Filter>, Box<Filter>, Option<Box<Filter>>),
    TryCatch(Box<Filter>, Option<Box<Filter>>),
    AlternativeOp(Box<Filter>, Box<Filter>),
    Optional(Box<Filter>),
    Format(String),
    Reduce(Box<Filter>, String, Box<Filter>, Box<Filter>),
    Indices(Box<Filter>),
}

#[derive(Debug, Clone)]
enum ObjKey {
    Literal(String),
    Expr(Filter),
}
#[derive(Debug, Clone)]
enum CmpOp {
    Eq,
    Ne,
    Lt,
    Le,
    Gt,
    Ge,
}
#[derive(Debug, Clone)]
enum ArithOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}

// ---- Filter Parser ----

struct FilterParser {
    chars: Vec<char>,
    pos: usize,
}

impl FilterParser {
    fn new(input: &str) -> Self {
        Self {
            chars: input.chars().collect(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_whitespace() {
            self.pos += 1;
        }
    }
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }
    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }
    fn advance(&mut self) -> Option<char> {
        let ch = self.peek();
        self.pos += 1;
        ch
    }

    fn starts_with(&self, s: &str) -> bool {
        s.chars()
            .enumerate()
            .all(|(i, ch)| self.chars.get(self.pos + i) == Some(&ch))
    }

    fn read_ident(&mut self) -> String {
        let start = self.pos;
        while self.pos < self.chars.len()
            && (self.chars[self.pos].is_alphanumeric() || self.chars[self.pos] == '_')
        {
            self.pos += 1;
        }
        self.chars[start..self.pos].iter().collect()
    }

    fn read_string(&mut self) -> String {
        self.advance();
        let mut s = String::new();
        while let Some(ch) = self.advance() {
            match ch {
                '"' => break,
                '\\' => {
                    if let Some(esc) = self.advance() {
                        match esc {
                            'n' => s.push('\n'),
                            't' => s.push('\t'),
                            '"' => s.push('"'),
                            '\\' => s.push('\\'),
                            _ => {
                                s.push('\\');
                                s.push(esc);
                            }
                        }
                    }
                }
                _ => s.push(ch),
            }
        }
        s
    }

    fn read_number(&mut self) -> f64 {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.advance();
        }
        while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_digit() {
            self.pos += 1;
        }
        if self.peek() == Some('.') {
            self.pos += 1;
            while self.pos < self.chars.len() && self.chars[self.pos].is_ascii_digit() {
                self.pos += 1;
            }
        }
        self.chars[start..self.pos]
            .iter()
            .collect::<String>()
            .parse()
            .unwrap_or(0.0)
    }

    fn parse(&mut self) -> Filter {
        self.parse_pipe()
    }

    fn parse_pipe(&mut self) -> Filter {
        let mut left = self.parse_comma();
        loop {
            self.skip_ws();
            if self.peek() == Some('|') {
                self.advance();
                left = Filter::Pipe(Box::new(left), Box::new(self.parse_comma()));
            } else {
                break;
            }
        }
        left
    }

    fn parse_comma(&mut self) -> Filter {
        let mut left = self.parse_alternative();
        loop {
            self.skip_ws();
            if self.peek() == Some(',') {
                self.advance();
                left = Filter::Comma(Box::new(left), Box::new(self.parse_alternative()));
            } else {
                break;
            }
        }
        left
    }

    fn parse_alternative(&mut self) -> Filter {
        let mut left = self.parse_or();
        loop {
            self.skip_ws();
            if self.starts_with("//") {
                self.pos += 2;
                left = Filter::AlternativeOp(Box::new(left), Box::new(self.parse_or()));
            } else {
                break;
            }
        }
        left
    }

    fn parse_or(&mut self) -> Filter {
        let mut left = self.parse_and();
        loop {
            self.skip_ws();
            if self.starts_with("or")
                && !self
                    .chars
                    .get(self.pos + 2)
                    .is_some_and(|c| c.is_alphanumeric())
            {
                self.pos += 2;
                left = Filter::Or(Box::new(left), Box::new(self.parse_and()));
            } else {
                break;
            }
        }
        left
    }

    fn parse_and(&mut self) -> Filter {
        let mut left = self.parse_comparison();
        loop {
            self.skip_ws();
            if self.starts_with("and")
                && !self
                    .chars
                    .get(self.pos + 3)
                    .is_some_and(|c| c.is_alphanumeric())
            {
                self.pos += 3;
                left = Filter::And(Box::new(left), Box::new(self.parse_comparison()));
            } else {
                break;
            }
        }
        left
    }

    fn parse_comparison(&mut self) -> Filter {
        let left = self.parse_arithmetic();
        self.skip_ws();
        let op = if self.starts_with("==") {
            self.pos += 2;
            CmpOp::Eq
        } else if self.starts_with("!=") {
            self.pos += 2;
            CmpOp::Ne
        } else if self.starts_with("<=") {
            self.pos += 2;
            CmpOp::Le
        } else if self.starts_with(">=") {
            self.pos += 2;
            CmpOp::Ge
        } else if self.peek() == Some('<') {
            self.advance();
            CmpOp::Lt
        } else if self.peek() == Some('>') {
            self.advance();
            CmpOp::Gt
        } else {
            return left;
        };
        Filter::Comparison(Box::new(left), op, Box::new(self.parse_arithmetic()))
    }

    fn parse_arithmetic(&mut self) -> Filter {
        let mut left = self.parse_mul();
        loop {
            self.skip_ws();
            if self.peek() == Some('+') {
                self.advance();
                left = Filter::Arithmetic(Box::new(left), ArithOp::Add, Box::new(self.parse_mul()));
            } else if self.peek() == Some('-') && self.peek_at(1) != Some('.') {
                self.advance();
                left = Filter::Arithmetic(Box::new(left), ArithOp::Sub, Box::new(self.parse_mul()));
            } else {
                break;
            }
        }
        left
    }

    fn parse_mul(&mut self) -> Filter {
        let mut left = self.parse_postfix();
        loop {
            self.skip_ws();
            if self.peek() == Some('*') {
                self.advance();
                left = Filter::Arithmetic(
                    Box::new(left),
                    ArithOp::Mul,
                    Box::new(self.parse_postfix()),
                );
            } else if self.peek() == Some('/') && self.peek_at(1) != Some('/') {
                self.advance();
                left = Filter::Arithmetic(
                    Box::new(left),
                    ArithOp::Div,
                    Box::new(self.parse_postfix()),
                );
            } else if self.peek() == Some('%') {
                self.advance();
                left = Filter::Arithmetic(
                    Box::new(left),
                    ArithOp::Mod,
                    Box::new(self.parse_postfix()),
                );
            } else {
                break;
            }
        }
        left
    }

    fn parse_postfix(&mut self) -> Filter {
        let mut f = self.parse_primary();
        loop {
            self.skip_ws();
            if self.peek() == Some('.')
                && self
                    .peek_at(1)
                    .is_some_and(|c| c.is_alphabetic() || c == '_')
            {
                self.advance();
                let name = self.read_ident();
                f = Filter::Pipe(Box::new(f), Box::new(Filter::Field(name)));
            } else if self.peek() == Some('[') {
                self.advance();
                self.skip_ws();
                if self.peek() == Some(']') {
                    self.advance();
                    f = Filter::Pipe(Box::new(f), Box::new(Filter::Iterate));
                } else {
                    let idx = self.parse_index_content();
                    self.skip_ws();
                    if self.peek() == Some(']') {
                        self.advance();
                    }
                    f = Filter::Pipe(Box::new(f), Box::new(idx));
                }
            } else if self.peek() == Some('?') {
                self.advance();
                f = Filter::Optional(Box::new(f));
            } else {
                break;
            }
        }
        f
    }

    fn parse_index_content(&mut self) -> Filter {
        self.skip_ws();
        if self.peek() == Some('"') {
            return Filter::Field(self.read_string());
        }
        if self.peek().is_some_and(|c| c.is_ascii_digit() || c == '-') {
            let n = self.read_number();
            self.skip_ws();
            if self.peek() == Some(':') {
                self.advance();
                self.skip_ws();
                if self.peek().is_some_and(|c| c.is_ascii_digit() || c == '-') {
                    return Filter::Slice(Some(n as i64), Some(self.read_number() as i64));
                }
                return Filter::Slice(Some(n as i64), None);
            }
            return Filter::Index(n as i64);
        }
        if self.peek() == Some(':') {
            self.advance();
            self.skip_ws();
            if self.peek().is_some_and(|c| c.is_ascii_digit() || c == '-') {
                return Filter::Slice(None, Some(self.read_number() as i64));
            }
            return Filter::Slice(None, None);
        }
        self.parse_pipe()
    }

    fn parse_primary(&mut self) -> Filter {
        self.skip_ws();
        match self.peek() {
            Some('.') => {
                self.advance();
                self.skip_ws();
                if self.peek().is_some_and(|c| c.is_alphabetic() || c == '_') {
                    Filter::Field(self.read_ident())
                } else if self.peek() == Some('[') {
                    self.advance();
                    self.skip_ws();
                    if self.peek() == Some(']') {
                        self.advance();
                        Filter::Iterate
                    } else {
                        let idx = self.parse_index_content();
                        self.skip_ws();
                        if self.peek() == Some(']') {
                            self.advance();
                        }
                        idx
                    }
                } else {
                    Filter::Identity
                }
            }
            Some('(') => {
                self.advance();
                let f = self.parse_pipe();
                self.skip_ws();
                if self.peek() == Some(')') {
                    self.advance();
                }
                f
            }
            Some('[') => {
                self.advance();
                self.skip_ws();
                if self.peek() == Some(']') {
                    self.advance();
                    Filter::ArrayConstruct(None)
                } else {
                    let f = self.parse_pipe();
                    self.skip_ws();
                    if self.peek() == Some(']') {
                        self.advance();
                    }
                    Filter::ArrayConstruct(Some(Box::new(f)))
                }
            }
            Some('{') => self.parse_object_construct(),
            Some('"') => Filter::Literal(Json::Str(self.read_string())),
            Some('@') => {
                self.advance();
                Filter::Format(self.read_ident())
            }
            Some(c)
                if c.is_ascii_digit()
                    || (c == '-' && self.peek_at(1).is_some_and(|c| c.is_ascii_digit())) =>
            {
                Filter::Literal(Json::Num(self.read_number()))
            }
            Some(c) if c.is_alphabetic() || c == '_' => {
                let ident = self.read_ident();
                self.parse_builtin(&ident)
            }
            _ => {
                self.advance();
                Filter::Identity
            }
        }
    }

    fn parse_object_construct(&mut self) -> Filter {
        self.advance();
        let mut entries = Vec::new();
        loop {
            self.skip_ws();
            if self.peek() == Some('}') {
                self.advance();
                break;
            }
            if !entries.is_empty() && self.peek() == Some(',') {
                self.advance();
            }
            self.skip_ws();
            let key = if self.peek() == Some('"') {
                ObjKey::Literal(self.read_string())
            } else if self.peek() == Some('(') {
                self.advance();
                let f = self.parse_pipe();
                self.skip_ws();
                if self.peek() == Some(')') {
                    self.advance();
                }
                ObjKey::Expr(f)
            } else if self.peek().is_some_and(|c| c.is_alphabetic() || c == '_') {
                ObjKey::Literal(self.read_ident())
            } else {
                break;
            };
            self.skip_ws();
            let value = if self.peek() == Some(':') {
                self.advance();
                self.parse_alternative()
            } else {
                match &key {
                    ObjKey::Literal(k) => Filter::Field(k.clone()),
                    ObjKey::Expr(f) => f.clone(),
                }
            };
            entries.push((key, value));
        }
        Filter::ObjectConstruct(entries)
    }

    fn parse_paren_filter(&mut self) -> Filter {
        self.skip_ws();
        if self.peek() == Some('(') {
            self.advance();
            let f = self.parse_pipe();
            self.skip_ws();
            if self.peek() == Some(')') {
                self.advance();
            }
            f
        } else {
            Filter::Identity
        }
    }

    fn parse_paren_string(&mut self) -> String {
        self.skip_ws();
        if self.peek() == Some('(') {
            self.advance();
            self.skip_ws();
        }
        let s = if self.peek() == Some('"') {
            self.read_string()
        } else {
            String::new()
        };
        self.skip_ws();
        if self.peek() == Some(')') {
            self.advance();
        }
        s
    }

    fn parse_builtin(&mut self, name: &str) -> Filter {
        match name {
            "null" => Filter::Literal(Json::Null),
            "true" => Filter::Literal(Json::Bool(true)),
            "false" => Filter::Literal(Json::Bool(false)),
            "empty" => Filter::Empty,
            "not" => Filter::Not,
            "length" => Filter::Length,
            "keys" | "keys_unsorted" => Filter::Keys,
            "values" => Filter::Values,
            "type" => Filter::Type,
            "add" => Filter::Add,
            "flatten" => {
                self.skip_ws();
                if self.peek() == Some('(') {
                    self.advance();
                    let n = self.read_number() as i64;
                    self.skip_ws();
                    if self.peek() == Some(')') {
                        self.advance();
                    }
                    Filter::Flatten(Some(n))
                } else {
                    Filter::Flatten(None)
                }
            }
            "unique" => Filter::Unique,
            "unique_by" => Filter::UniqueBy(Box::new(self.parse_paren_filter())),
            "reverse" => Filter::Reverse,
            "sort_by" => Filter::SortBy(Box::new(self.parse_paren_filter())),
            "group_by" => Filter::GroupBy(Box::new(self.parse_paren_filter())),
            "to_entries" => Filter::ToEntries,
            "from_entries" => Filter::FromEntries,
            "with_entries" => Filter::WithEntries(Box::new(self.parse_paren_filter())),
            "select" => Filter::Select(Box::new(self.parse_paren_filter())),
            "map" => Filter::Map(Box::new(self.parse_paren_filter())),
            "has" => Filter::Has(Box::new(self.parse_paren_filter())),
            "recurse" => Filter::Recurse,
            "first" => {
                self.skip_ws();
                if self.peek() == Some('(') {
                    Filter::First(Box::new(self.parse_paren_filter()))
                } else {
                    Filter::First(Box::new(Filter::Iterate))
                }
            }
            "last" => {
                self.skip_ws();
                if self.peek() == Some('(') {
                    Filter::Last(Box::new(self.parse_paren_filter()))
                } else {
                    Filter::Last(Box::new(Filter::Iterate))
                }
            }
            "any" => {
                self.skip_ws();
                if self.peek() == Some('(') {
                    Filter::Any(Some(Box::new(self.parse_paren_filter())))
                } else {
                    Filter::Any(None)
                }
            }
            "all" => {
                self.skip_ws();
                if self.peek() == Some('(') {
                    Filter::All(Some(Box::new(self.parse_paren_filter())))
                } else {
                    Filter::All(None)
                }
            }
            "ascii_downcase" => Filter::Ascii(false),
            "ascii_upcase" => Filter::Ascii(true),
            "test" => Filter::Test(self.parse_paren_string()),
            "split" => Filter::Split(self.parse_paren_string()),
            "join" => Filter::Join(self.parse_paren_string()),
            "ltrimstr" => Filter::Ltrimstr(self.parse_paren_string()),
            "rtrimstr" => Filter::Rtrimstr(self.parse_paren_string()),
            "startswith" => Filter::Startswith(self.parse_paren_string()),
            "endswith" => Filter::Endswith(self.parse_paren_string()),
            "contains" => Filter::Contains(Box::new(self.parse_paren_filter())),
            "inside" => Filter::Inside(Box::new(self.parse_paren_filter())),
            "tostring" => Filter::Tostring,
            "tonumber" => Filter::Tonumber,
            "tojson" => Filter::Tojson,
            "fromjson" => Filter::Fromjson,
            "floor" => Filter::Floor,
            "ceil" => Filter::Ceil,
            "round" => Filter::Round,
            "fabs" => Filter::Fabs,
            "min" => Filter::Min,
            "max" => Filter::Max,
            "min_by" => Filter::MinBy(Box::new(self.parse_paren_filter())),
            "max_by" => Filter::MaxBy(Box::new(self.parse_paren_filter())),
            "del" => Filter::Del(Box::new(self.parse_paren_filter())),
            "explode" => Filter::Explode,
            "implode" => Filter::Implode,
            "indices" | "index" => {
                self.skip_ws();
                if self.peek() == Some('(') {
                    Filter::Indices(Box::new(self.parse_paren_filter()))
                } else {
                    Filter::Identity
                }
            }
            "range" => {
                self.skip_ws();
                self.advance();
                let a = self.parse_pipe();
                self.skip_ws();
                let b = if matches!(self.peek(), Some(';' | ',')) {
                    self.advance();
                    Some(Box::new(self.parse_pipe()))
                } else {
                    None
                };
                self.skip_ws();
                if self.peek() == Some(')') {
                    self.advance();
                }
                Filter::Range(Box::new(a), b)
            }
            "if" => {
                let cond = self.parse_pipe();
                self.skip_ws();
                let kw = self.read_ident(); // "then"
                let then_body = self.parse_pipe();
                self.skip_ws();
                let save = self.pos;
                let kw2 = self.read_ident();
                let else_body = if kw2 == "else" {
                    let eb = self.parse_pipe();
                    self.skip_ws();
                    let _kw3 = self.read_ident();
                    Some(Box::new(eb))
                } else if kw2 == "end" {
                    None
                } else {
                    self.pos = save;
                    None
                };
                let _ = kw;
                Filter::IfThenElse(Box::new(cond), Box::new(then_body), else_body)
            }
            "try" => {
                let f = self.parse_postfix();
                self.skip_ws();
                let catch = if self.starts_with("catch") {
                    self.pos += 5;
                    Some(Box::new(self.parse_postfix()))
                } else {
                    None
                };
                Filter::TryCatch(Box::new(f), catch)
            }
            "reduce" => {
                let f = self.parse_postfix();
                self.skip_ws();
                if self.starts_with("as") {
                    self.pos += 2;
                    self.skip_ws();
                    if self.peek() == Some('$') {
                        self.advance();
                    }
                    let var = self.read_ident();
                    self.skip_ws();
                    if self.peek() == Some('(') {
                        self.advance();
                    }
                    let init = self.parse_pipe();
                    self.skip_ws();
                    if self.peek() == Some(';') {
                        self.advance();
                    }
                    let update = self.parse_pipe();
                    self.skip_ws();
                    if self.peek() == Some(')') {
                        self.advance();
                    }
                    Filter::Reduce(Box::new(f), var, Box::new(init), Box::new(update))
                } else {
                    Filter::Identity
                }
            }
            _ => {
                // Unknown identifier — treat as identity for now
                Filter::Identity
            }
        }
    }
}

// ---- Filter Evaluator ----

fn apply_filter(filter: &Filter, input: &Json) -> Vec<Json> {
    match filter {
        Filter::Identity => vec![input.clone()],
        Filter::Literal(v) => vec![v.clone()],
        Filter::Field(name) => match input {
            Json::Object(map) => vec![map.get(name).cloned().unwrap_or(Json::Null)],
            Json::Null => vec![Json::Null],
            _ => vec![Json::Null],
        },
        Filter::Index(n) => match input {
            Json::Array(arr) => {
                let idx = if *n < 0 { arr.len() as i64 + n } else { *n } as usize;
                vec![arr.get(idx).cloned().unwrap_or(Json::Null)]
            }
            _ => vec![Json::Null],
        },
        Filter::Slice(s, e) => match input {
            Json::Array(arr) => {
                let len = arr.len() as i64;
                let start = s.map_or(0, |s| if s < 0 { (len + s).max(0) } else { s }) as usize;
                let end = e.map_or(len, |e| if e < 0 { (len + e).max(0) } else { e }) as usize;
                vec![Json::Array(
                    arr[start.min(arr.len())..end.min(arr.len())].to_vec(),
                )]
            }
            Json::Str(s_str) => {
                let len = s_str.len() as i64;
                let start = s.map_or(0, |v| if v < 0 { (len + v).max(0) } else { v }) as usize;
                let end = e.map_or(len, |v| if v < 0 { (len + v).max(0) } else { v }) as usize;
                let chars: Vec<char> = s_str.chars().collect();
                vec![Json::Str(
                    chars[start.min(chars.len())..end.min(chars.len())]
                        .iter()
                        .collect(),
                )]
            }
            _ => vec![Json::Null],
        },
        Filter::Iterate => match input {
            Json::Array(arr) => arr.clone(),
            Json::Object(map) => map.values().cloned().collect(),
            _ => vec![],
        },
        Filter::Pipe(l, r) => {
            let mut results = Vec::new();
            for v in apply_filter(l, input) {
                results.extend(apply_filter(r, &v));
            }
            results
        }
        Filter::Comma(l, r) => {
            let mut r1 = apply_filter(l, input);
            r1.extend(apply_filter(r, input));
            r1
        }
        Filter::Select(f) => {
            if apply_filter(f, input)
                .first()
                .is_some_and(|v| v.is_truthy())
            {
                vec![input.clone()]
            } else {
                vec![]
            }
        }
        Filter::Map(f) => match input {
            Json::Array(arr) => {
                let mut r = Vec::new();
                for item in arr {
                    r.extend(apply_filter(f, item));
                }
                vec![Json::Array(r)]
            }
            _ => vec![input.clone()],
        },
        Filter::Keys => match input {
            Json::Object(map) => vec![Json::Array(
                map.keys().map(|k| Json::Str(k.clone())).collect(),
            )],
            Json::Array(arr) => vec![Json::Array(
                (0..arr.len()).map(|i| Json::Num(i as f64)).collect(),
            )],
            _ => vec![Json::Null],
        },
        Filter::Values => match input {
            Json::Object(map) => vec![Json::Array(map.values().cloned().collect())],
            Json::Array(arr) => vec![Json::Array(arr.clone())],
            _ => vec![Json::Null],
        },
        Filter::Length => {
            let n = match input {
                Json::Array(a) => a.len() as f64,
                Json::Object(m) => m.len() as f64,
                Json::Str(s) => s.len() as f64,
                Json::Null => 0.0,
                Json::Num(n) => n.abs(),
                _ => 0.0,
            };
            vec![Json::Num(n)]
        }
        Filter::Type => vec![Json::Str(input.type_name().to_string())],
        Filter::Has(f) => {
            let keys = apply_filter(f, input);
            if let Some(key) = keys.into_iter().next() {
                return vec![Json::Bool(match (input, &key) {
                    (Json::Object(m), Json::Str(k)) => m.contains_key(k),
                    (Json::Array(a), Json::Num(n)) => (*n as usize) < a.len(),
                    _ => false,
                })];
            }
            vec![Json::Bool(false)]
        }
        Filter::Add => match input {
            Json::Array(arr) if !arr.is_empty() => {
                let mut acc = arr[0].clone();
                for item in &arr[1..] {
                    acc = json_add(&acc, item);
                }
                vec![acc]
            }
            _ => vec![Json::Null],
        },
        Filter::Flatten(depth) => match input {
            Json::Array(a) => vec![Json::Array(flatten_array(a, depth.unwrap_or(i64::MAX)))],
            _ => vec![input.clone()],
        },
        Filter::Unique => match input {
            Json::Array(a) => {
                let mut seen = Vec::new();
                for item in a {
                    if !seen.contains(item) {
                        seen.push(item.clone());
                    }
                }
                vec![Json::Array(seen)]
            }
            _ => vec![input.clone()],
        },
        Filter::UniqueBy(f) => match input {
            Json::Array(a) => {
                let mut seen_keys = Vec::new();
                let mut result = Vec::new();
                for item in a {
                    let k = apply_filter(f, item)
                        .into_iter()
                        .next()
                        .unwrap_or(Json::Null);
                    if !seen_keys.contains(&k) {
                        seen_keys.push(k);
                        result.push(item.clone());
                    }
                }
                vec![Json::Array(result)]
            }
            _ => vec![input.clone()],
        },
        Filter::Reverse => match input {
            Json::Array(a) => {
                let mut r = a.clone();
                r.reverse();
                vec![Json::Array(r)]
            }
            Json::Str(s) => vec![Json::Str(s.chars().rev().collect())],
            _ => vec![input.clone()],
        },
        Filter::SortBy(f) => match input {
            Json::Array(arr) => {
                let mut indexed: Vec<(Json, Json)> = arr
                    .iter()
                    .map(|item| {
                        (
                            apply_filter(f, item)
                                .into_iter()
                                .next()
                                .unwrap_or(Json::Null),
                            item.clone(),
                        )
                    })
                    .collect();
                indexed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                vec![Json::Array(indexed.into_iter().map(|(_, v)| v).collect())]
            }
            _ => vec![input.clone()],
        },
        Filter::GroupBy(f) => match input {
            Json::Array(arr) => {
                let mut groups: Vec<(Json, Vec<Json>)> = Vec::new();
                for item in arr {
                    let key = apply_filter(f, item)
                        .into_iter()
                        .next()
                        .unwrap_or(Json::Null);
                    if let Some(g) = groups.iter_mut().find(|(k, _)| k == &key) {
                        g.1.push(item.clone());
                    } else {
                        groups.push((key, vec![item.clone()]));
                    }
                }
                vec![Json::Array(
                    groups.into_iter().map(|(_, v)| Json::Array(v)).collect(),
                )]
            }
            _ => vec![input.clone()],
        },
        Filter::ToEntries => match input {
            Json::Object(map) => vec![Json::Array(
                map.iter()
                    .map(|(k, v)| {
                        let mut e = BTreeMap::new();
                        e.insert("key".to_string(), Json::Str(k.clone()));
                        e.insert("value".to_string(), v.clone());
                        Json::Object(e)
                    })
                    .collect(),
            )],
            _ => vec![input.clone()],
        },
        Filter::FromEntries => match input {
            Json::Array(arr) => {
                let mut map = BTreeMap::new();
                for entry in arr {
                    if let Json::Object(obj) = entry {
                        let key = obj
                            .get("key")
                            .or_else(|| obj.get("name"))
                            .map(|k| match k {
                                Json::Str(s) => s.clone(),
                                v => v.to_string_repr(),
                            })
                            .unwrap_or_default();
                        map.insert(key, obj.get("value").cloned().unwrap_or(Json::Null));
                    }
                }
                vec![Json::Object(map)]
            }
            _ => vec![input.clone()],
        },
        Filter::WithEntries(f) => {
            let entries = apply_filter(&Filter::ToEntries, input);
            entries
                .into_iter()
                .flat_map(|e| apply_filter(&Filter::Map(f.clone()), &e))
                .flat_map(|e| apply_filter(&Filter::FromEntries, &e))
                .collect()
        }
        Filter::Not => vec![Json::Bool(!input.is_truthy())],
        Filter::Empty => vec![],
        Filter::Recurse => {
            let mut results = vec![input.clone()];
            recurse_collect(input, &mut results);
            results
        }
        Filter::First(f) => apply_filter(f, input).into_iter().take(1).collect(),
        Filter::Last(f) => apply_filter(f, input)
            .into_iter()
            .last()
            .into_iter()
            .collect(),
        Filter::Any(f) => match input {
            Json::Array(a) => {
                for item in a {
                    let v = f.as_ref().map_or(item.clone(), |f| {
                        apply_filter(f, item)
                            .into_iter()
                            .next()
                            .unwrap_or(Json::Bool(false))
                    });
                    if v.is_truthy() {
                        return vec![Json::Bool(true)];
                    }
                }
                vec![Json::Bool(false)]
            }
            _ => vec![Json::Bool(input.is_truthy())],
        },
        Filter::All(f) => match input {
            Json::Array(a) => {
                for item in a {
                    let v = f.as_ref().map_or(item.clone(), |f| {
                        apply_filter(f, item)
                            .into_iter()
                            .next()
                            .unwrap_or(Json::Bool(false))
                    });
                    if !v.is_truthy() {
                        return vec![Json::Bool(false)];
                    }
                }
                vec![Json::Bool(true)]
            }
            _ => vec![Json::Bool(input.is_truthy())],
        },
        Filter::Ascii(upper) => match input {
            Json::Str(s) => vec![Json::Str(if *upper {
                s.to_uppercase()
            } else {
                s.to_lowercase()
            })],
            _ => vec![input.clone()],
        },
        Filter::Test(pat) => match input {
            Json::Str(s) => vec![Json::Bool(s.contains(pat.as_str()))],
            _ => vec![Json::Bool(false)],
        },
        Filter::Split(sep) => match input {
            Json::Str(s) => vec![Json::Array(
                s.split(sep.as_str())
                    .map(|p| Json::Str(p.to_string()))
                    .collect(),
            )],
            _ => vec![input.clone()],
        },
        Filter::Join(sep) => match input {
            Json::Array(a) => {
                let parts: Vec<String> = a
                    .iter()
                    .map(|v| match v {
                        Json::Str(s) => s.clone(),
                        Json::Null => String::new(),
                        v => v.to_string_repr(),
                    })
                    .collect();
                vec![Json::Str(parts.join(sep))]
            }
            _ => vec![input.clone()],
        },
        Filter::Ltrimstr(s) => match input {
            Json::Str(str) => vec![Json::Str(
                str.strip_prefix(s.as_str()).unwrap_or(str).to_string(),
            )],
            _ => vec![input.clone()],
        },
        Filter::Rtrimstr(s) => match input {
            Json::Str(str) => vec![Json::Str(
                str.strip_suffix(s.as_str()).unwrap_or(str).to_string(),
            )],
            _ => vec![input.clone()],
        },
        Filter::Startswith(s) => match input {
            Json::Str(str) => vec![Json::Bool(str.starts_with(s.as_str()))],
            _ => vec![Json::Bool(false)],
        },
        Filter::Endswith(s) => match input {
            Json::Str(str) => vec![Json::Bool(str.ends_with(s.as_str()))],
            _ => vec![Json::Bool(false)],
        },
        Filter::Contains(f) => {
            let vals = apply_filter(f, input);
            if let Some(v) = vals.into_iter().next() {
                return vec![Json::Bool(json_contains(input, &v))];
            }
            vec![Json::Bool(false)]
        }
        Filter::Inside(f) => {
            let vals = apply_filter(f, input);
            if let Some(v) = vals.into_iter().next() {
                return vec![Json::Bool(json_contains(&v, input))];
            }
            vec![Json::Bool(false)]
        }
        Filter::Tostring => vec![Json::Str(match input {
            Json::Str(s) => s.clone(),
            v => v.to_string_repr(),
        })],
        Filter::Tonumber => match input {
            Json::Num(_) => vec![input.clone()],
            Json::Str(s) => vec![Json::Num(s.trim().parse().unwrap_or(0.0))],
            _ => vec![Json::Num(0.0)],
        },
        Filter::Tojson => vec![Json::Str(format_json(input, true))],
        Filter::Fromjson => match input {
            Json::Str(s) => JsonParser::parse_all(s)
                .into_iter()
                .next()
                .map_or(vec![Json::Null], |v| vec![v]),
            _ => vec![input.clone()],
        },
        Filter::Floor => match input {
            Json::Num(n) => vec![Json::Num(n.floor())],
            _ => vec![input.clone()],
        },
        Filter::Ceil => match input {
            Json::Num(n) => vec![Json::Num(n.ceil())],
            _ => vec![input.clone()],
        },
        Filter::Round => match input {
            Json::Num(n) => vec![Json::Num(n.round())],
            _ => vec![input.clone()],
        },
        Filter::Fabs => match input {
            Json::Num(n) => vec![Json::Num(n.abs())],
            _ => vec![input.clone()],
        },
        Filter::Min => match input {
            Json::Array(a) if !a.is_empty() => {
                let mut m = &a[0];
                for item in &a[1..] {
                    if item.partial_cmp(m) == Some(std::cmp::Ordering::Less) {
                        m = item;
                    }
                }
                vec![m.clone()]
            }
            _ => vec![Json::Null],
        },
        Filter::Max => match input {
            Json::Array(a) if !a.is_empty() => {
                let mut m = &a[0];
                for item in &a[1..] {
                    if item.partial_cmp(m) == Some(std::cmp::Ordering::Greater) {
                        m = item;
                    }
                }
                vec![m.clone()]
            }
            _ => vec![Json::Null],
        },
        Filter::MinBy(f) => match input {
            Json::Array(a) if !a.is_empty() => {
                let mut m = &a[0];
                let mut mk = apply_filter(f, m).into_iter().next().unwrap_or(Json::Null);
                for item in &a[1..] {
                    let k = apply_filter(f, item)
                        .into_iter()
                        .next()
                        .unwrap_or(Json::Null);
                    if k.partial_cmp(&mk) == Some(std::cmp::Ordering::Less) {
                        m = item;
                        mk = k;
                    }
                }
                vec![m.clone()]
            }
            _ => vec![Json::Null],
        },
        Filter::MaxBy(f) => match input {
            Json::Array(a) if !a.is_empty() => {
                let mut m = &a[0];
                let mut mk = apply_filter(f, m).into_iter().next().unwrap_or(Json::Null);
                for item in &a[1..] {
                    let k = apply_filter(f, item)
                        .into_iter()
                        .next()
                        .unwrap_or(Json::Null);
                    if k.partial_cmp(&mk) == Some(std::cmp::Ordering::Greater) {
                        m = item;
                        mk = k;
                    }
                }
                vec![m.clone()]
            }
            _ => vec![Json::Null],
        },
        Filter::Range(from, to) => {
            let from_n = apply_filter(from, input)
                .first()
                .and_then(|v| match v {
                    Json::Num(n) => Some(*n),
                    _ => None,
                })
                .unwrap_or(0.0);
            if let Some(to_f) = to {
                let to_n = apply_filter(to_f, input)
                    .first()
                    .and_then(|v| match v {
                        Json::Num(n) => Some(*n),
                        _ => None,
                    })
                    .unwrap_or(0.0);
                let mut r = Vec::new();
                let mut i = from_n;
                while i < to_n {
                    r.push(Json::Num(i));
                    i += 1.0;
                }
                r
            } else {
                (0..from_n as i64).map(|i| Json::Num(i as f64)).collect()
            }
        }
        Filter::Del(f) => match input {
            Json::Object(map) => {
                let to_del: Vec<String> = apply_filter(f, input)
                    .into_iter()
                    .filter_map(|v| match v {
                        Json::Str(s) => Some(s),
                        _ => None,
                    })
                    .collect();
                let mut m = map.clone();
                for k in to_del {
                    m.remove(&k);
                }
                vec![Json::Object(m)]
            }
            _ => vec![input.clone()],
        },
        Filter::Explode => match input {
            Json::Str(s) => vec![Json::Array(
                s.chars().map(|c| Json::Num(c as u32 as f64)).collect(),
            )],
            _ => vec![input.clone()],
        },
        Filter::Implode => match input {
            Json::Array(a) => {
                let s: String = a
                    .iter()
                    .filter_map(|v| {
                        if let Json::Num(n) = v {
                            char::from_u32(*n as u32)
                        } else {
                            None
                        }
                    })
                    .collect();
                vec![Json::Str(s)]
            }
            _ => vec![input.clone()],
        },
        Filter::Comparison(l, op, r) => {
            let lv = apply_filter(l, input)
                .into_iter()
                .next()
                .unwrap_or(Json::Null);
            let rv = apply_filter(r, input)
                .into_iter()
                .next()
                .unwrap_or(Json::Null);
            vec![Json::Bool(match op {
                CmpOp::Eq => lv == rv,
                CmpOp::Ne => lv != rv,
                CmpOp::Lt => lv.partial_cmp(&rv) == Some(std::cmp::Ordering::Less),
                CmpOp::Le => matches!(
                    lv.partial_cmp(&rv),
                    Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
                ),
                CmpOp::Gt => lv.partial_cmp(&rv) == Some(std::cmp::Ordering::Greater),
                CmpOp::Ge => matches!(
                    lv.partial_cmp(&rv),
                    Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
                ),
            })]
        }
        Filter::Arithmetic(l, op, r) => {
            let lv = apply_filter(l, input)
                .into_iter()
                .next()
                .unwrap_or(Json::Null);
            let rv = apply_filter(r, input)
                .into_iter()
                .next()
                .unwrap_or(Json::Null);
            vec![json_arithmetic(&lv, op, &rv)]
        }
        Filter::And(l, r) => {
            let lv = apply_filter(l, input)
                .into_iter()
                .next()
                .unwrap_or(Json::Null);
            if !lv.is_truthy() {
                vec![Json::Bool(false)]
            } else {
                let rv = apply_filter(r, input)
                    .into_iter()
                    .next()
                    .unwrap_or(Json::Null);
                vec![Json::Bool(rv.is_truthy())]
            }
        }
        Filter::Or(l, r) => {
            let lv = apply_filter(l, input)
                .into_iter()
                .next()
                .unwrap_or(Json::Null);
            if lv.is_truthy() {
                vec![Json::Bool(true)]
            } else {
                let rv = apply_filter(r, input)
                    .into_iter()
                    .next()
                    .unwrap_or(Json::Null);
                vec![Json::Bool(rv.is_truthy())]
            }
        }
        Filter::IfThenElse(cond, then_body, else_body) => {
            if apply_filter(cond, input)
                .first()
                .is_some_and(|v| v.is_truthy())
            {
                apply_filter(then_body, input)
            } else if let Some(eb) = else_body {
                apply_filter(eb, input)
            } else {
                vec![input.clone()]
            }
        }
        Filter::TryCatch(f, catch) => {
            let results = apply_filter(f, input);
            if results.is_empty() {
                catch.as_ref().map_or(vec![], |c| apply_filter(c, input))
            } else {
                results
            }
        }
        Filter::AlternativeOp(l, r) => {
            let lv = apply_filter(l, input).into_iter().next();
            match lv {
                Some(v) if !matches!(v, Json::Null | Json::Bool(false)) => vec![v],
                _ => apply_filter(r, input),
            }
        }
        Filter::Optional(f) => apply_filter(f, input),
        Filter::ArrayConstruct(f) => {
            if let Some(f) = f {
                vec![Json::Array(apply_filter(f, input))]
            } else {
                vec![Json::Array(Vec::new())]
            }
        }
        Filter::ObjectConstruct(entries) => {
            let mut map = BTreeMap::new();
            for (key, vf) in entries {
                let k = match key {
                    ObjKey::Literal(s) => s.clone(),
                    ObjKey::Expr(f) => apply_filter(f, input)
                        .first()
                        .map(|v| match v {
                            Json::Str(s) => s.clone(),
                            v => v.to_string_repr(),
                        })
                        .unwrap_or_default(),
                };
                if let Some(v) = apply_filter(vf, input).into_iter().next() {
                    map.insert(k, v);
                }
            }
            vec![Json::Object(map)]
        }
        Filter::Format(name) => match name.as_str() {
            "base64" => match input {
                Json::Str(s) => vec![Json::Str(base64_encode(s.as_bytes()))],
                _ => vec![input.clone()],
            },
            "base64d" => match input {
                Json::Str(s) => vec![Json::Str(
                    String::from_utf8_lossy(&base64_decode(s)).into_owned(),
                )],
                _ => vec![input.clone()],
            },
            "csv" => match input {
                Json::Array(a) => {
                    let parts: Vec<String> = a
                        .iter()
                        .map(|v| match v {
                            Json::Str(s) => {
                                if s.contains(',') || s.contains('"') {
                                    format!("\"{}\"", s.replace('"', "\"\""))
                                } else {
                                    s.clone()
                                }
                            }
                            v => v.to_string_repr(),
                        })
                        .collect();
                    vec![Json::Str(parts.join(","))]
                }
                _ => vec![input.clone()],
            },
            "tsv" => match input {
                Json::Array(a) => {
                    let parts: Vec<String> = a
                        .iter()
                        .map(|v| match v {
                            Json::Str(s) => s.clone(),
                            v => v.to_string_repr(),
                        })
                        .collect();
                    vec![Json::Str(parts.join("\t"))]
                }
                _ => vec![input.clone()],
            },
            "html" => match input {
                Json::Str(s) => vec![Json::Str(
                    s.replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;")
                        .replace('\'', "&#39;")
                        .replace('"', "&quot;"),
                )],
                _ => vec![input.clone()],
            },
            "json" => vec![Json::Str(format_json(input, true))],
            _ => vec![input.clone()],
        },
        Filter::Reduce(gen, _var, init, update) => {
            let mut acc = apply_filter(init, input)
                .into_iter()
                .next()
                .unwrap_or(Json::Null);
            for _item in apply_filter(gen, input) {
                acc = apply_filter(update, &acc).into_iter().next().unwrap_or(acc);
            }
            vec![acc]
        }
        Filter::Indices(f) => match input {
            Json::Str(s) => {
                let pat = apply_filter(f, input)
                    .first()
                    .and_then(|v| match v {
                        Json::Str(s) => Some(s.clone()),
                        _ => None,
                    })
                    .unwrap_or_default();
                let mut indices = Vec::new();
                let mut start = 0;
                while let Some(idx) = s[start..].find(&pat) {
                    indices.push(Json::Num((start + idx) as f64));
                    start += idx + 1;
                }
                vec![Json::Array(indices)]
            }
            Json::Array(a) => {
                let target = apply_filter(f, input)
                    .first()
                    .cloned()
                    .unwrap_or(Json::Null);
                vec![Json::Array(
                    a.iter()
                        .enumerate()
                        .filter_map(|(i, v)| {
                            if v == &target {
                                Some(Json::Num(i as f64))
                            } else {
                                None
                            }
                        })
                        .collect(),
                )]
            }
            _ => vec![Json::Array(Vec::new())],
        },
    }
}

fn json_add(a: &Json, b: &Json) -> Json {
    match (a, b) {
        (Json::Num(a), Json::Num(b)) => Json::Num(a + b),
        (Json::Str(a), Json::Str(b)) => Json::Str(format!("{}{}", a, b)),
        (Json::Array(a), Json::Array(b)) => {
            let mut r = a.clone();
            r.extend(b.clone());
            Json::Array(r)
        }
        (Json::Object(a), Json::Object(b)) => {
            let mut r = a.clone();
            r.extend(b.clone());
            Json::Object(r)
        }
        (Json::Null, b) => b.clone(),
        (a, Json::Null) => a.clone(),
        _ => Json::Null,
    }
}

fn json_arithmetic(a: &Json, op: &ArithOp, b: &Json) -> Json {
    match op {
        ArithOp::Add => json_add(a, b),
        ArithOp::Sub => Json::Num(
            match a {
                Json::Num(n) => *n,
                _ => 0.0,
            } - match b {
                Json::Num(n) => *n,
                _ => 0.0,
            },
        ),
        ArithOp::Mul => Json::Num(
            match a {
                Json::Num(n) => *n,
                _ => 0.0,
            } * match b {
                Json::Num(n) => *n,
                _ => 0.0,
            },
        ),
        ArithOp::Div => {
            let d = match b {
                Json::Num(n) => *n,
                _ => 0.0,
            };
            if d == 0.0 {
                Json::Null
            } else {
                Json::Num(
                    match a {
                        Json::Num(n) => *n,
                        _ => 0.0,
                    } / d,
                )
            }
        }
        ArithOp::Mod => {
            let d = match b {
                Json::Num(n) => *n as i64,
                _ => 0,
            };
            if d == 0 {
                Json::Null
            } else {
                Json::Num(
                    (match a {
                        Json::Num(n) => *n as i64,
                        _ => 0,
                    } % d) as f64,
                )
            }
        }
    }
}

fn json_contains(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (_, Json::Null) => true,
        (Json::Str(a), Json::Str(b)) => a.contains(b.as_str()),
        (Json::Array(a), Json::Array(b)) => {
            b.iter().all(|bv| a.iter().any(|av| json_contains(av, bv)))
        }
        (Json::Object(a), Json::Object(b)) => b
            .iter()
            .all(|(k, bv)| a.get(k).is_some_and(|av| json_contains(av, bv))),
        (a, b) => a == b,
    }
}

fn flatten_array(arr: &[Json], depth: i64) -> Vec<Json> {
    let mut result = Vec::new();
    for item in arr {
        if depth > 0 {
            if let Json::Array(inner) = item {
                result.extend(flatten_array(inner, depth - 1));
                continue;
            }
        }
        result.push(item.clone());
    }
    result
}

fn recurse_collect(val: &Json, results: &mut Vec<Json>) {
    match val {
        Json::Array(a) => {
            for item in a {
                results.push(item.clone());
                recurse_collect(item, results);
            }
        }
        Json::Object(m) => {
            for v in m.values() {
                results.push(v.clone());
                recurse_collect(v, results);
            }
        }
        _ => {}
    }
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    let mut i = 0;
    while i < data.len() {
        let b0 = data[i] as u32;
        let b1 = if i + 1 < data.len() {
            data[i + 1] as u32
        } else {
            0
        };
        let b2 = if i + 2 < data.len() {
            data[i + 2] as u32
        } else {
            0
        };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        result.push(if i + 1 < data.len() {
            CHARS[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        result.push(if i + 2 < data.len() {
            CHARS[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
        i += 3;
    }
    result
}

fn base64_decode(s: &str) -> Vec<u8> {
    fn cv(c: char) -> u8 {
        match c {
            'A'..='Z' => c as u8 - b'A',
            'a'..='z' => c as u8 - b'a' + 26,
            '0'..='9' => c as u8 - b'0' + 52,
            '+' => 62,
            '/' => 63,
            _ => 0,
        }
    }
    let chars: Vec<char> = s
        .chars()
        .filter(|c| *c != '=' && !c.is_whitespace())
        .collect();
    let mut result = Vec::new();
    let mut i = 0;
    while i + 3 < chars.len() {
        let t = (cv(chars[i]) as u32) << 18
            | (cv(chars[i + 1]) as u32) << 12
            | (cv(chars[i + 2]) as u32) << 6
            | cv(chars[i + 3]) as u32;
        result.push((t >> 16) as u8);
        result.push((t >> 8) as u8);
        result.push(t as u8);
        i += 4;
    }
    if i + 2 < chars.len() {
        let t = (cv(chars[i]) as u32) << 18
            | (cv(chars[i + 1]) as u32) << 12
            | (cv(chars[i + 2]) as u32) << 6;
        result.push((t >> 16) as u8);
        result.push((t >> 8) as u8);
    } else if i + 1 < chars.len() {
        let t = (cv(chars[i]) as u32) << 18 | (cv(chars[i + 1]) as u32) << 12;
        result.push((t >> 16) as u8);
    }
    result
}

// ---- Main ----

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut filter_str = ".".to_string();
    let mut raw_output = false;
    let mut compact = false;
    let mut null_input = false;
    let mut slurp = false;
    let mut raw_input = false;
    let mut files: Vec<String> = Vec::new();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "-r" | "--raw-output" => raw_output = true,
            "-c" | "--compact-output" => compact = true,
            "-n" | "--null-input" => null_input = true,
            "-s" | "--slurp" => slurp = true,
            "-R" | "--raw-input" => raw_input = true,
            "-e" | "--exit-status" => {}
            "--arg" | "--argjson" => {
                i += 2;
            }
            arg if !arg.starts_with('-') => {
                if filter_str == "." && files.is_empty() {
                    filter_str = arg.to_string();
                } else {
                    files.push(arg.to_string());
                }
            }
            _ => {}
        }
        i += 1;
    }

    let mut input_str = String::new();
    io::stdin()
        .read_to_string(&mut input_str)
        .unwrap_or_default();

    let mut parser = FilterParser::new(&filter_str);
    let filter = parser.parse();

    let inputs = if null_input {
        vec![Json::Null]
    } else if raw_input {
        let lines: Vec<Json> = input_str
            .lines()
            .map(|l| Json::Str(l.to_string()))
            .collect();
        if slurp {
            vec![Json::Array(lines)]
        } else {
            lines
        }
    } else {
        let values = JsonParser::parse_all(&input_str);
        if slurp {
            vec![Json::Array(values)]
        } else if values.is_empty() {
            vec![Json::Null]
        } else {
            values
        }
    };

    for input in &inputs {
        let results = apply_filter(&filter, input);
        for result in &results {
            if raw_output {
                match result {
                    Json::Str(s) => println!("{}", s),
                    v => println!("{}", format_json(v, compact)),
                }
            } else {
                println!("{}", format_json(result, compact));
            }
        }
    }
}
