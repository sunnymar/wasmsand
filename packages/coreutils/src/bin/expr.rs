use std::env;
use std::process;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("expr: missing operand");
        process::exit(2);
    }

    // Handle "length STRING"
    if args.len() == 2 && args[0] == "length" {
        println!("{}", args[1].len());
        return;
    }

    // Handle binary operations: expr A OP B
    if args.len() == 3 {
        let left = &args[0];
        let op = &args[1];
        let right = &args[2];

        // Try integer operations
        if let (Ok(l), Ok(r)) = (left.parse::<i64>(), right.parse::<i64>()) {
            let result = match op.as_str() {
                "+" => l + r,
                "-" => l - r,
                "*" => l * r,
                "/" => {
                    if r == 0 {
                        eprintln!("expr: division by zero");
                        process::exit(2);
                    }
                    l / r
                }
                "%" => {
                    if r == 0 {
                        eprintln!("expr: division by zero");
                        process::exit(2);
                    }
                    l % r
                }
                "<" => {
                    if l < r {
                        1
                    } else {
                        0
                    }
                }
                "<=" => {
                    if l <= r {
                        1
                    } else {
                        0
                    }
                }
                ">" => {
                    if l > r {
                        1
                    } else {
                        0
                    }
                }
                ">=" => {
                    if l >= r {
                        1
                    } else {
                        0
                    }
                }
                "=" => {
                    if l == r {
                        1
                    } else {
                        0
                    }
                }
                "!=" => {
                    if l != r {
                        1
                    } else {
                        0
                    }
                }
                _ => {
                    eprintln!("expr: unknown operator: {op}");
                    process::exit(2);
                }
            };
            println!("{result}");
            if result == 0 {
                process::exit(1);
            }
            return;
        }

        // String comparison
        let result = match op.as_str() {
            "=" => {
                if left == right {
                    1
                } else {
                    0
                }
            }
            "!=" => {
                if left != right {
                    1
                } else {
                    0
                }
            }
            _ => {
                eprintln!("expr: non-integer argument");
                process::exit(2);
            }
        };
        println!("{result}");
        if result == 0 {
            process::exit(1);
        }
        return;
    }

    // Single arg: print it (non-zero string = true)
    if args.len() == 1 {
        println!("{}", args[0]);
        if args[0].is_empty() || args[0] == "0" {
            process::exit(1);
        }
        return;
    }

    eprintln!("expr: syntax error");
    process::exit(2);
}
