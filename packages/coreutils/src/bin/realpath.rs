use std::env;

fn main() {
    for arg in env::args().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        // Simple path normalization: resolve . and ..
        let mut parts: Vec<&str> = Vec::new();
        for component in arg.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                s => parts.push(s),
            }
        }
        println!("/{}", parts.join("/"));
    }
}
