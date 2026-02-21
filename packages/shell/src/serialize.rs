use crate::ast::Command;

/// Serialize a parsed command AST to a JSON string.
pub fn serialize_command(cmd: &Command) -> String {
    serde_json::to_string(cmd).expect("AST serialization should never fail")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::parse;

    #[test]
    fn serialize_simple_command() {
        let cmd = parse("echo hello");
        let json = serialize_command(&cmd);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["Simple"]["words"][0]["parts"][0]["Literal"], "echo");
        assert_eq!(value["Simple"]["words"][1]["parts"][0]["Literal"], "hello");
    }

    #[test]
    fn serialize_pipeline() {
        let cmd = parse("cat file | grep x");
        let json = serialize_command(&cmd);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value["Pipeline"]["commands"].is_array());
        assert_eq!(value["Pipeline"]["commands"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn serialize_list() {
        let cmd = parse("cmd1 && cmd2");
        let json = serialize_command(&cmd);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["List"]["op"], "And");
    }

    #[test]
    fn serialize_if() {
        let cmd = parse("if true; then echo yes; fi");
        let json = serialize_command(&cmd);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(value["If"]["condition"].is_object());
        assert!(value["If"]["then_body"].is_object());
    }

    #[test]
    fn serialize_for() {
        let cmd = parse("for x in a b; do echo $x; done");
        let json = serialize_command(&cmd);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["For"]["var"], "x");
    }

    #[test]
    fn serialize_variable() {
        let cmd = parse("echo $HOME");
        let json = serialize_command(&cmd);
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["Simple"]["words"][1]["parts"][0]["Variable"], "HOME");
    }

    #[test]
    fn round_trip_all_types() {
        for input in &[
            "echo hello",
            "cat f | grep x",
            "cmd1 && cmd2 || cmd3",
            "if true; then echo yes; else echo no; fi",
            "for x in a b c; do echo $x; done",
            "while true; do echo loop; done",
            "( cmd1 ; cmd2 )",
            "FOO=bar echo $FOO",
            "echo hello > file.txt",
            "cmd 2>&1",
        ] {
            let cmd = parse(input);
            let json = serialize_command(&cmd);
            let _: serde_json::Value = serde_json::from_str(&json).unwrap();
        }
    }
}
