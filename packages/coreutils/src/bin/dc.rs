use std::collections::HashMap;
use std::io::{self, BufWriter, Read, Write};

#[derive(Clone, Debug)]
enum Value {
    Number(f64),
    Str(String),
}

struct DcState {
    stack: Vec<Value>,
    registers: HashMap<char, Value>,
    scale: u32,
    iradix: u32,
    oradix: u32,
}

impl DcState {
    fn new() -> Self {
        DcState {
            stack: Vec::new(),
            registers: HashMap::new(),
            scale: 0,
            iradix: 10,
            oradix: 10,
        }
    }

    fn pop_number(&mut self) -> Option<f64> {
        if self.stack.is_empty() {
            eprintln!("dc: stack empty");
            return None;
        }
        match self.stack.pop().unwrap() {
            Value::Number(n) => Some(n),
            Value::Str(_) => {
                eprintln!("dc: non-numeric value");
                None
            }
        }
    }

    fn pop_value(&mut self) -> Option<Value> {
        if self.stack.is_empty() {
            eprintln!("dc: stack empty");
            return None;
        }
        self.stack.pop()
    }

    fn peek_value(&self) -> Option<&Value> {
        if self.stack.is_empty() {
            eprintln!("dc: stack empty");
            return None;
        }
        self.stack.last()
    }

    fn format_number(&self, n: f64) -> String {
        if self.oradix != 10 {
            return self.format_number_radix(n);
        }
        if self.scale == 0 {
            if n == n.trunc() && n.abs() < 1e15 {
                return format!("{}", n as i64);
            }
            // Large or non-integer: just print
            return format!("{}", n);
        }
        // With scale, show exactly `scale` decimal places
        let s = format!("{:.*}", self.scale as usize, n);
        s
    }

    fn format_number_radix(&self, n: f64) -> String {
        let radix = self.oradix;
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
        // Fractional part
        let frac = abs_n - abs_n.trunc();
        if self.scale > 0 && frac > 0.0 {
            result.push('.');
            let mut f = frac;
            for _ in 0..self.scale {
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
}

fn tokenize(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = input.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        let ch = chars[i];

        // Skip whitespace
        if ch.is_ascii_whitespace() {
            i += 1;
            continue;
        }

        // Comment: # to end of line
        if ch == '#' {
            while i < len && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }

        // String literal: [text] with nesting
        if ch == '[' {
            let mut depth = 1;
            let mut s = String::new();
            i += 1;
            while i < len && depth > 0 {
                if chars[i] == '[' {
                    depth += 1;
                    s.push('[');
                } else if chars[i] == ']' {
                    depth -= 1;
                    if depth > 0 {
                        s.push(']');
                    }
                } else {
                    s.push(chars[i]);
                }
                i += 1;
            }
            tokens.push(format!("[{}]", s));
            continue;
        }

        // Negative number prefix: _
        if ch == '_' {
            i += 1;
            let mut num = String::from("-");
            while i < len && (chars[i].is_ascii_digit() || chars[i] == '.') {
                num.push(chars[i]);
                i += 1;
            }
            if num.len() > 1 {
                tokens.push(num);
            }
            continue;
        }

        // Number: digits and dots only. Uppercase hex digits (A-F) are NOT consumed
        // here because tokenization is static and iradix is a runtime value — we can't
        // know at tokenize-time whether A-F are digits or commands. Users must separate
        // hex digits with spaces when using iradix > 10.
        if ch.is_ascii_digit() || ch == '.' {
            let mut num = String::new();
            while i < len && (chars[i].is_ascii_digit() || chars[i] == '.') {
                num.push(chars[i]);
                i += 1;
            }
            tokens.push(num);
            continue;
        }

        // Two-character commands with register: s, l, S, L followed by register char
        if (ch == 's' || ch == 'l' || ch == 'S' || ch == 'L')
            && i + 1 < len
            && !chars[i + 1].is_ascii_whitespace()
        {
            let mut tok = String::new();
            tok.push(ch);
            i += 1;
            tok.push(chars[i]);
            i += 1;
            tokens.push(tok);
            continue;
        }

        // Comparison operators: =r, >r, <r, !<r, !>r, !=r
        if ch == '!'
            && i + 2 < len
            && (chars[i + 1] == '<' || chars[i + 1] == '>' || chars[i + 1] == '=')
        {
            let mut tok = String::new();
            tok.push('!');
            tok.push(chars[i + 1]);
            tok.push(chars[i + 2]);
            i += 3;
            tokens.push(tok);
            continue;
        }

        if (ch == '=' || ch == '>' || ch == '<') && i + 1 < len {
            let mut tok = String::new();
            tok.push(ch);
            tok.push(chars[i + 1]);
            i += 2;
            tokens.push(tok);
            continue;
        }

        // Single character commands
        tokens.push(ch.to_string());
        i += 1;
    }

    tokens
}

fn parse_number(s: &str, radix: u32) -> f64 {
    if radix == 10 {
        s.parse::<f64>().unwrap_or(0.0)
    } else {
        // Parse integer part in given radix
        let negative = s.starts_with('-');
        let s = if negative { &s[1..] } else { s };
        let parts: Vec<&str> = s.split('.').collect();
        let int_part = i64::from_str_radix(parts[0], radix).unwrap_or(0) as f64;
        let frac_part = if parts.len() > 1 {
            let mut frac = 0.0;
            let mut place = 1.0 / radix as f64;
            for ch in parts[1].chars() {
                let d = ch.to_digit(radix).unwrap_or(0) as f64;
                frac += d * place;
                place /= radix as f64;
            }
            frac
        } else {
            0.0
        };
        let result = int_part + frac_part;
        if negative {
            -result
        } else {
            result
        }
    }
}

fn execute(tokens: &[String], state: &mut DcState, out: &mut BufWriter<io::StdoutLock>) {
    let mut i = 0;
    while i < tokens.len() {
        let tok = &tokens[i];
        i += 1;

        // String literal
        if tok.starts_with('[') && tok.ends_with(']') {
            let inner = &tok[1..tok.len() - 1];
            state.stack.push(Value::Str(inner.to_string()));
            continue;
        }

        // Number (starts with digit, dot, or minus for _-prefixed negatives)
        // A bare "-" is the subtraction operator, not a number.
        if tok.starts_with(|c: char| c.is_ascii_digit() || c == '.')
            || (tok.starts_with('-') && tok.len() > 1)
        {
            let n = parse_number(tok, state.iradix);
            state.stack.push(Value::Number(n));
            continue;
        }

        // Register store/load
        if tok.len() == 2 {
            let first = tok.chars().next().unwrap();
            let reg = tok.chars().nth(1).unwrap();

            match first {
                's' => {
                    if let Some(val) = state.pop_value() {
                        state.registers.insert(reg, val);
                    }
                    continue;
                }
                'l' => {
                    if let Some(val) = state.registers.get(&reg) {
                        state.stack.push(val.clone());
                    } else {
                        eprintln!("dc: register '{}' is empty", reg);
                    }
                    continue;
                }
                'S' => {
                    // S is same as s for our simplified implementation
                    if let Some(val) = state.pop_value() {
                        state.registers.insert(reg, val);
                    }
                    continue;
                }
                'L' => {
                    // L is same as l for our simplified implementation
                    if let Some(val) = state.registers.get(&reg) {
                        state.stack.push(val.clone());
                    } else {
                        eprintln!("dc: register '{}' is empty", reg);
                    }
                    continue;
                }
                _ => {}
            }

            // Comparison operators: =r, >r, <r
            if tok.len() == 2 && (first == '=' || first == '>' || first == '<') {
                let b = state.pop_number();
                let a = state.pop_number();
                if let (Some(a), Some(b)) = (a, b) {
                    let cond = match first {
                        '=' => a == b,
                        '>' => a > b,
                        '<' => a < b,
                        _ => false,
                    };
                    if cond {
                        if let Some(val) = state.registers.get(&reg) {
                            if let Value::Str(s) = val.clone() {
                                let sub_tokens = tokenize(&s);
                                execute(&sub_tokens, state, out);
                            }
                        }
                    }
                }
                continue;
            }
        }

        // Negated comparison operators: !=r, !<r, !>r
        if tok.len() == 3 && tok.starts_with('!') {
            let op = tok.chars().nth(1).unwrap();
            let reg = tok.chars().nth(2).unwrap();
            let b = state.pop_number();
            let a = state.pop_number();
            if let (Some(a), Some(b)) = (a, b) {
                let cond = match op {
                    '=' => a != b,
                    '<' => a >= b, // !< means >=
                    '>' => a <= b, // !> means <=
                    _ => false,
                };
                if cond {
                    if let Some(val) = state.registers.get(&reg) {
                        if let Value::Str(s) = val.clone() {
                            let sub_tokens = tokenize(&s);
                            execute(&sub_tokens, state, out);
                        }
                    }
                }
            }
            continue;
        }

        // Single character commands
        if tok.len() == 1 {
            let ch = tok.chars().next().unwrap();
            match ch {
                '+' => {
                    let b = state.pop_number();
                    let a = state.pop_number();
                    if let (Some(a), Some(b)) = (a, b) {
                        state.stack.push(Value::Number(a + b));
                    }
                }
                '-' => {
                    let b = state.pop_number();
                    let a = state.pop_number();
                    if let (Some(a), Some(b)) = (a, b) {
                        state.stack.push(Value::Number(a - b));
                    }
                }
                '*' => {
                    let b = state.pop_number();
                    let a = state.pop_number();
                    if let (Some(a), Some(b)) = (a, b) {
                        state.stack.push(Value::Number(a * b));
                    }
                }
                '/' => {
                    let b = state.pop_number();
                    let a = state.pop_number();
                    if let (Some(a), Some(b)) = (a, b) {
                        if b == 0.0 {
                            eprintln!("dc: division by zero");
                        } else {
                            let result = a / b;
                            if state.scale == 0 {
                                state.stack.push(Value::Number(result.trunc()));
                            } else {
                                let factor = 10f64.powi(state.scale as i32);
                                state
                                    .stack
                                    .push(Value::Number((result * factor).trunc() / factor));
                            }
                        }
                    }
                }
                '%' => {
                    let b = state.pop_number();
                    let a = state.pop_number();
                    if let (Some(a), Some(b)) = (a, b) {
                        if b == 0.0 {
                            eprintln!("dc: remainder by zero");
                        } else {
                            state.stack.push(Value::Number(a % b));
                        }
                    }
                }
                '^' => {
                    let b = state.pop_number();
                    let a = state.pop_number();
                    if let (Some(a), Some(b)) = (a, b) {
                        state.stack.push(Value::Number(a.powf(b)));
                    }
                }
                'v' => {
                    if let Some(a) = state.pop_number() {
                        if a < 0.0 {
                            eprintln!("dc: square root of negative number");
                        } else {
                            state.stack.push(Value::Number(a.sqrt()));
                        }
                    }
                }
                'p' => {
                    if let Some(val) = state.peek_value() {
                        match val {
                            Value::Number(n) => {
                                let s = state.format_number(*n);
                                let _ = writeln!(out, "{}", s);
                            }
                            Value::Str(s) => {
                                let _ = writeln!(out, "{}", s);
                            }
                        }
                    }
                }
                'n' => {
                    if let Some(val) = state.pop_value() {
                        match val {
                            Value::Number(n) => {
                                let s = state.format_number(n);
                                let _ = write!(out, "{}", s);
                            }
                            Value::Str(s) => {
                                let _ = write!(out, "{}", s);
                            }
                        }
                    }
                }
                'f' => {
                    for j in (0..state.stack.len()).rev() {
                        match &state.stack[j] {
                            Value::Number(n) => {
                                let s = state.format_number(*n);
                                let _ = writeln!(out, "{}", s);
                            }
                            Value::Str(s) => {
                                let _ = writeln!(out, "{}", s);
                            }
                        }
                    }
                }
                'c' => {
                    state.stack.clear();
                }
                'd' => {
                    if let Some(val) = state.peek_value() {
                        let cloned = val.clone();
                        state.stack.push(cloned);
                    }
                }
                'r' => {
                    let len = state.stack.len();
                    if len < 2 {
                        eprintln!("dc: stack empty");
                    } else {
                        state.stack.swap(len - 1, len - 2);
                    }
                }
                'z' => {
                    let depth = state.stack.len() as f64;
                    state.stack.push(Value::Number(depth));
                }
                'Z' => {
                    if let Some(val) = state.pop_value() {
                        match val {
                            Value::Number(n) => {
                                // Number of digits (excluding minus sign and decimal point)
                                let s = format!("{}", n.abs());
                                let digits = s.chars().filter(|c| c.is_ascii_digit()).count();
                                state.stack.push(Value::Number(digits as f64));
                            }
                            Value::Str(s) => {
                                state.stack.push(Value::Number(s.len() as f64));
                            }
                        }
                    }
                }
                'k' => {
                    if let Some(n) = state.pop_number() {
                        let k = n as u32;
                        state.scale = k;
                    }
                }
                'K' => {
                    state.stack.push(Value::Number(state.scale as f64));
                }
                'i' => {
                    if let Some(n) = state.pop_number() {
                        let r = n as u32;
                        if !(2..=36).contains(&r) {
                            eprintln!("dc: input base must be between 2 and 36");
                        } else {
                            state.iradix = r;
                        }
                    }
                }
                'o' => {
                    if let Some(n) = state.pop_number() {
                        let r = n as u32;
                        if !(2..=36).contains(&r) {
                            eprintln!("dc: output base must be between 2 and 36");
                        } else {
                            state.oradix = r;
                        }
                    }
                }
                'I' => {
                    state.stack.push(Value::Number(state.iradix as f64));
                }
                'O' => {
                    state.stack.push(Value::Number(state.oradix as f64));
                }
                'x' => {
                    if let Some(val) = state.pop_value() {
                        match val {
                            Value::Str(s) => {
                                let sub_tokens = tokenize(&s);
                                execute(&sub_tokens, state, out);
                            }
                            Value::Number(n) => {
                                // Push number back if not a string
                                state.stack.push(Value::Number(n));
                            }
                        }
                    }
                }
                'q' => {
                    let _ = out.flush();
                    std::process::exit(0);
                }
                _ => {
                    // Unknown command, ignore
                }
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let input = if args.len() >= 2 && args[0] == "-e" {
        args[1..].join(" ")
    } else if args.len() == 1 && args[0] == "-e" {
        eprintln!("dc: option requires an argument -- 'e'");
        std::process::exit(1);
    } else if !args.is_empty() {
        // Try to read from file
        match std::fs::read_to_string(&args[0]) {
            Ok(contents) => contents,
            Err(e) => {
                eprintln!("dc: {}: {}", args[0], e);
                std::process::exit(1);
            }
        }
    } else {
        // Read from stdin
        let mut buf = String::new();
        let _ = io::stdin().read_to_string(&mut buf);
        buf
    };

    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let mut state = DcState::new();

    let tokens = tokenize(&input);
    execute(&tokens, &mut state, &mut out);
    let _ = out.flush();
}
