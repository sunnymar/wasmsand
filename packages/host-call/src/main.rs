use std::env;
use std::io::{Read, Write};
use std::path::Path;

const STDIN_SNAPSHOT_LIMIT: usize = 1024 * 1024;

fn main() {
    let argv: Vec<String> = env::args().collect();
    let extension = extension_name(argv.first().map(String::as_str).unwrap_or("host-call"));
    let stdin = read_available_stdin();
    let args_json = argv_json(&argv[1..], &stdin);

    match codepod_host::extension_invoke(&extension, "run", &args_json) {
        Ok(response) => {
            let stdout = extract_json_string(&response, "stdout").unwrap_or_default();
            let stderr = extract_json_string(&response, "stderr").unwrap_or_default();
            let exit_code = extract_json_i32(&response, "exit_code").unwrap_or(0);
            let mut out = std::io::stdout();
            let mut err = std::io::stderr();
            out.write_all(stdout.as_bytes()).ok();
            out.flush().ok();
            err.write_all(stderr.as_bytes()).ok();
            err.flush().ok();
            if exit_code != 0 {
                std::process::exit(exit_code);
            }
        }
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(1);
        }
    }
}

fn read_available_stdin() -> String {
    let mut buf = vec![0_u8; STDIN_SNAPSHOT_LIMIT];
    match std::io::stdin().read(&mut buf) {
        Ok(n) => String::from_utf8_lossy(&buf[..n]).into_owned(),
        Err(err) => {
            eprintln!("failed to read stdin: {err}");
            std::process::exit(1);
        }
    }
}

fn extension_name(argv0: &str) -> String {
    let name = Path::new(argv0)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(argv0);
    name.strip_suffix(".wasm").unwrap_or(name).to_string()
}

fn argv_json(args: &[String], stdin: &str) -> String {
    let encoded = args
        .iter()
        .map(|arg| format!("\"{}\"", codepod_host::json_escape(arg)))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "{{\"args\":[{encoded}],\"stdin\":\"{}\"}}",
        codepod_host::json_escape(stdin),
    )
}

fn extract_json_i32(json: &str, key: &str) -> Option<i32> {
    let pattern = format!("\"{key}\":");
    let start = json.find(&pattern)? + pattern.len();
    let rest = json[start..].trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '-')
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

fn extract_json_string(json: &str, key: &str) -> Option<String> {
    let pattern = format!("\"{key}\":\"");
    let start = json.find(&pattern)? + pattern.len();
    let mut out = String::new();
    let mut chars = json[start..].chars();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => return Some(out),
            '\\' => match chars.next()? {
                '"' => out.push('"'),
                '\\' => out.push('\\'),
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                other => out.push(other),
            },
            other => out.push(other),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_name_comes_from_invocation_basename() {
        assert_eq!(extension_name("/usr/extensions/demo"), "demo");
        assert_eq!(extension_name("/bin/host-call.wasm"), "host-call");
    }

    #[test]
    fn argv_json_escapes_arguments() {
        let args = vec!["a".to_string(), "b\"c".to_string()];
        assert_eq!(
            argv_json(&args, "hi\n"),
            "{\"args\":[\"a\",\"b\\\"c\"],\"stdin\":\"hi\\n\"}",
        );
    }

    #[test]
    fn extracts_extension_response_fields() {
        let json = "{\"exit_code\":7,\"stdout\":\"hi\\n\",\"stderr\":\"bad\\\"news\"}";
        assert_eq!(extract_json_i32(json, "exit_code"), Some(7));
        assert_eq!(extract_json_string(json, "stdout").as_deref(), Some("hi\n"));
        assert_eq!(
            extract_json_string(json, "stderr").as_deref(),
            Some("bad\"news")
        );
    }
}
