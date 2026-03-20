use calamine::{open_workbook_auto, Data};
use std::io::{self, Read, Write};

pub const EXIT_OK: i32 = 0;
pub const EXIT_INPUT: i32 = 1;
pub const EXIT_OUTPUT: i32 = 2;

pub fn print_version(command: &str) {
    println!("{command} 0.1.0");
}

pub fn print_help(usage: &str, options: &[&str]) {
    println!("Usage: {usage}");
    if !options.is_empty() {
        println!();
        println!("Options:");
        for option in options {
            println!("  {option}");
        }
    }
}

pub fn load_workbook(
    path: &str,
) -> Result<calamine::Sheets<std::io::BufReader<std::fs::File>>, String> {
    open_workbook_auto(path).map_err(|err| format!("failed to open '{path}': {err}"))
}

pub fn data_to_string(value: &Data) -> String {
    match value {
        Data::Empty => String::new(),
        Data::String(text) => text.clone(),
        Data::Float(value) => {
            if value.fract() == 0.0 {
                format!("{value:.0}")
            } else {
                value.to_string()
            }
        }
        Data::Int(value) => value.to_string(),
        Data::Bool(value) => value.to_string(),
        Data::DateTime(value) => value.to_string(),
        Data::DateTimeIso(value) => value.clone(),
        Data::DurationIso(value) => value.clone(),
        Data::Error(value) => format!("{value:?}"),
    }
}

pub fn read_input_csv(path: Option<&str>) -> Result<String, String> {
    if let Some(path) = path {
        return std::fs::read_to_string(path)
            .map_err(|err| format!("failed to read '{path}': {err}"));
    }

    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|err| format!("failed to read stdin: {err}"))?;
    Ok(input)
}

pub fn csv_writer_to<W: Write>(writer: W, use_crlf: bool) -> csv::Writer<W> {
    let terminator = if use_crlf {
        csv::Terminator::CRLF
    } else {
        csv::Terminator::Any(b'\n')
    };
    csv::WriterBuilder::new()
        .terminator(terminator)
        .from_writer(writer)
}
