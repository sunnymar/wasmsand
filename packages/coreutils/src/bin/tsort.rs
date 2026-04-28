//! tsort - topological sort

use std::collections::{HashMap, HashSet, VecDeque};
use std::env;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Write};
use std::process;

fn run() -> i32 {
    let args: Vec<String> = env::args().collect();

    let input: Box<dyn BufRead> = if args.len() > 1 && args[1] != "-" {
        match File::open(&args[1]) {
            Ok(f) => Box::new(BufReader::new(f)),
            Err(e) => {
                eprintln!("tsort: {}: {}", args[1], e);
                return 1;
            }
        }
    } else {
        Box::new(BufReader::new(io::stdin()))
    };

    // Collect all tokens from input
    let mut tokens: Vec<String> = Vec::new();
    for line in input.lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("tsort: read error: {e}");
                return 1;
            }
        };
        for tok in line.split_whitespace() {
            tokens.push(tok.to_string());
        }
    }

    // POSIX/GNU/BusyBox: tsort takes pairs of tokens. An odd count means
    // the last token has no partner, which is an input error (not a
    // singleton — that interpretation predates the standard and BusyBox
    // explicitly rejects it; see tsort.tests "odd"/"odd2" cases).
    if tokens.len() % 2 != 0 {
        let source = if args.len() > 1 && args[1] != "-" {
            args[1].as_str()
        } else {
            "-"
        };
        eprintln!("tsort: {source}: input contains an odd number of tokens");
        return 1;
    }

    // Build adjacency list and in-degree map
    // Nodes appear in insertion order
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    let mut in_degree: HashMap<String, usize> = HashMap::new();
    let mut order: Vec<String> = Vec::new(); // insertion order
    let mut seen: HashSet<String> = HashSet::new();

    let ensure_node = |node: &str,
                       order: &mut Vec<String>,
                       seen: &mut HashSet<String>,
                       adj: &mut HashMap<String, Vec<String>>,
                       in_degree: &mut HashMap<String, usize>| {
        if seen.insert(node.to_string()) {
            order.push(node.to_string());
            adj.entry(node.to_string()).or_default();
            in_degree.entry(node.to_string()).or_insert(0);
        }
    };

    // Process pairs of tokens
    let mut i = 0;
    while i < tokens.len() {
        let a = &tokens[i].clone();
        ensure_node(a, &mut order, &mut seen, &mut adj, &mut in_degree);

        if i + 1 < tokens.len() {
            let b = &tokens[i + 1].clone();
            ensure_node(b, &mut order, &mut seen, &mut adj, &mut in_degree);

            // Add edge a -> b (unless a == b, which is just a node)
            if a != b {
                adj.get_mut(a).unwrap().push(b.clone());
                *in_degree.get_mut(b).unwrap() += 1;
            }
            i += 2;
        } else {
            // Odd token at end: just a node
            i += 1;
        }
    }

    // Kahn's algorithm
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let mut exit_code = 0;

    // Initialize queue with nodes having in-degree 0, in insertion order
    let mut queue: VecDeque<String> = VecDeque::new();
    for node in &order {
        if in_degree[node] == 0 {
            queue.push_back(node.clone());
        }
    }

    let mut emitted: HashSet<String> = HashSet::new();

    while !queue.is_empty() {
        let node = queue.pop_front().unwrap();
        if emitted.contains(&node) {
            continue;
        }
        emitted.insert(node.clone());

        if writeln!(out, "{node}").is_err() {
            return 0; // broken pipe
        }

        // Collect neighbors and sort by insertion order for determinism
        let neighbors = adj.get(&node).cloned().unwrap_or_default();
        let mut ready: Vec<(usize, String)> = Vec::new();
        for neighbor in &neighbors {
            let deg = in_degree.get_mut(neighbor).unwrap();
            *deg -= 1;
            if *deg == 0 && !emitted.contains(neighbor) {
                let pos = order
                    .iter()
                    .position(|n| n == neighbor)
                    .unwrap_or(usize::MAX);
                ready.push((pos, neighbor.clone()));
            }
        }
        ready.sort_by_key(|(pos, _)| *pos);
        for (_, n) in ready {
            queue.push_back(n);
        }
    }

    // Check for cycles: any node not emitted is in a cycle
    if emitted.len() < order.len() {
        exit_code = 1;
        let source = if args.len() > 1 && args[1] != "-" {
            &args[1]
        } else {
            "-"
        };
        eprintln!("tsort: {source}: input contains a loop:");
        for node in &order {
            if !emitted.contains(node) {
                eprintln!("tsort: {node}");
                // Still output cycle members
                let _ = writeln!(out, "{node}");
            }
        }
    }

    exit_code
}

fn main() {
    process::exit(run());
}
