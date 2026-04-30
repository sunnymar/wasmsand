# Rust 1.94.1 Codepod std patches

Applied by `scripts/build-rust-std.sh --rust 1.94.1` to a copied
`rust-src` tree before building the wasm32-wasip1 target libraries.

Rust 1.94.1 uses the newer `sys/pal/wasi` plus Unix fs/thread layout.
That is why these patches are closer to 1.95.0 than 1.93.0.
