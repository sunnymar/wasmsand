use std::env;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    // No real symlinks in VFS — just print the path (-f canonicalizes)
    let paths: Vec<&str> = args
        .iter()
        .filter(|a| !a.starts_with('-'))
        .map(|s| s.as_str())
        .collect();
    for path in paths {
        println!("{path}");
    }
}
