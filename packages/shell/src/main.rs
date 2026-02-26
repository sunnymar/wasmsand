use std::io::{self, Read, Write};

use codepod_shell::parser::parse;
use codepod_shell::serialize::serialize_command;

fn main() {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("failed to read stdin");

    let input = input.trim();
    if input.is_empty() {
        io::stdout().write_all(b"null").unwrap();
        return;
    }

    let cmd = parse(input);
    let json = serialize_command(&cmd);

    io::stdout().write_all(json.as_bytes()).unwrap();
    io::stdout().write_all(b"\n").unwrap();
}
