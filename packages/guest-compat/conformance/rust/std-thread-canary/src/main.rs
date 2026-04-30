use std::num::NonZeroUsize;

fn main() {
    let n: NonZeroUsize = std::thread::available_parallelism().unwrap();
    println!("parallelism={}", n.get());
}
