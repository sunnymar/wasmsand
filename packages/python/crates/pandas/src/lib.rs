// Stub: pandas native module (to be implemented)
use rustpython_vm as vm;

#[vm::pymodule]
mod _pandas_native {
    use rustpython_vm as vm;
    use vm::VirtualMachine;

    #[pyfunction]
    fn _stub(_vm: &VirtualMachine) -> vm::PyResult<()> {
        Ok(())
    }
}

pub fn module_def(ctx: &vm::Context) -> &'static vm::builtins::PyModuleDef {
    _pandas_native::module_def(ctx)
}
