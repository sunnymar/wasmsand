use std::process::ExitCode;

use rustpython::InterpreterBuilderExt;

fn main() -> ExitCode {
    let config = rustpython::InterpreterBuilder::new().init_stdlib();

    // Extract module defs while config is still borrowed, then move config.
    // Each cfg block gets the def first, then re-binds config.

    #[cfg(feature = "numpy")]
    let numpy_def = numpy_rust_python::numpy_module_def(&config.ctx);
    #[cfg(feature = "numpy")]
    let config = config.add_native_module(numpy_def);

    #[cfg(feature = "pandas")]
    let pandas_def = pandas_native::module_def(&config.ctx);
    #[cfg(feature = "pandas")]
    let config = config.add_native_module(pandas_def);

    #[cfg(feature = "pil")]
    let pil_def = pil_native::pil_module_def(&config.ctx);
    #[cfg(feature = "pil")]
    let config = config.add_native_module(pil_def);

    // matplotlib is pure Python — no native module needed.

    #[cfg(feature = "sklearn")]
    let sklearn_def = sklearn_native::module_def(&config.ctx);
    #[cfg(feature = "sklearn")]
    let config = config.add_native_module(sklearn_def);

    #[cfg(feature = "sqlite3")]
    let sqlite3_def = sqlite3_native::module_def(&config.ctx);
    #[cfg(feature = "sqlite3")]
    let config = config.add_native_module(sqlite3_def);

    // _codepod host bridge module — always available (not feature-gated)
    let codepod_def = codepod_host_native::module_def(&config.ctx);
    let config = config.add_native_module(codepod_def);

    rustpython::run(config)
}
