//! Native `_sqlite3` module for RustPython.
//!
//! Wraps the C sqlite3 library via FFI, providing the `_sqlite3` module that
//! CPython's stdlib `sqlite3` package (frozen into RustPython) imports.
//! This module exposes `connect()`, `Connection`, `Cursor`, `Row`, and the
//! compatibility attributes that `sqlite3.dbapi2` expects.

use rustpython_vm as vm;

use std::ffi::{CStr, CString};
use std::fmt;
use std::os::raw::{c_char, c_double, c_int};
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// FFI bindings to the C sqlite3 library
// ---------------------------------------------------------------------------

mod ffi {
    use super::*;

    // Opaque types
    #[repr(C)]
    pub struct sqlite3 {
        _private: [u8; 0],
    }

    #[repr(C)]
    pub struct sqlite3_stmt {
        _private: [u8; 0],
    }

    // Result codes
    pub const SQLITE_OK: c_int = 0;
    pub const SQLITE_ROW: c_int = 100;
    pub const SQLITE_DONE: c_int = 101;

    // Column type codes
    pub const SQLITE_INTEGER: c_int = 1;
    pub const SQLITE_FLOAT: c_int = 2;
    pub const SQLITE_TEXT: c_int = 3;
    pub const SQLITE_BLOB: c_int = 4;
    pub const SQLITE_NULL: c_int = 5;

    extern "C" {
        pub fn sqlite3_open(filename: *const c_char, ppDb: *mut *mut sqlite3) -> c_int;
        pub fn sqlite3_close(db: *mut sqlite3) -> c_int;
        pub fn sqlite3_errmsg(db: *mut sqlite3) -> *const c_char;
        pub fn sqlite3_changes(db: *mut sqlite3) -> c_int;
        pub fn sqlite3_last_insert_rowid(db: *mut sqlite3) -> i64;
        pub fn sqlite3_libversion() -> *const c_char;

        pub fn sqlite3_prepare_v2(
            db: *mut sqlite3,
            zSql: *const c_char,
            nByte: c_int,
            ppStmt: *mut *mut sqlite3_stmt,
            pzTail: *mut *const c_char,
        ) -> c_int;
        pub fn sqlite3_step(stmt: *mut sqlite3_stmt) -> c_int;
        pub fn sqlite3_finalize(stmt: *mut sqlite3_stmt) -> c_int;

        pub fn sqlite3_column_count(stmt: *mut sqlite3_stmt) -> c_int;
        pub fn sqlite3_column_type(stmt: *mut sqlite3_stmt, iCol: c_int) -> c_int;
        pub fn sqlite3_column_name(stmt: *mut sqlite3_stmt, N: c_int) -> *const c_char;

        pub fn sqlite3_column_int64(stmt: *mut sqlite3_stmt, iCol: c_int) -> i64;
        pub fn sqlite3_column_double(stmt: *mut sqlite3_stmt, iCol: c_int) -> c_double;
        pub fn sqlite3_column_text(stmt: *mut sqlite3_stmt, iCol: c_int) -> *const c_char;
        pub fn sqlite3_column_blob(stmt: *mut sqlite3_stmt, iCol: c_int) -> *const u8;
        pub fn sqlite3_column_bytes(stmt: *mut sqlite3_stmt, iCol: c_int) -> c_int;

        pub fn sqlite3_bind_int64(stmt: *mut sqlite3_stmt, idx: c_int, val: i64) -> c_int;
        pub fn sqlite3_bind_double(stmt: *mut sqlite3_stmt, idx: c_int, val: c_double) -> c_int;
        pub fn sqlite3_bind_text(
            stmt: *mut sqlite3_stmt,
            idx: c_int,
            val: *const c_char,
            n: c_int,
            destructor: isize,
        ) -> c_int;
        pub fn sqlite3_bind_blob(
            stmt: *mut sqlite3_stmt,
            idx: c_int,
            val: *const u8,
            n: c_int,
            destructor: isize,
        ) -> c_int;
        pub fn sqlite3_bind_null(stmt: *mut sqlite3_stmt, idx: c_int) -> c_int;
    }

    /// SQLITE_TRANSIENT sentinel: tells sqlite3 to make its own copy of the data.
    pub const SQLITE_TRANSIENT: isize = -1;
}

// ---------------------------------------------------------------------------
// Wrapper newtype for Send+Sync on raw pointer
// ---------------------------------------------------------------------------

/// Wrapper around a raw `*mut sqlite3` pointer.
/// Send+Sync is safe because we target single-threaded wasm32.
struct DbPtr(*mut ffi::sqlite3);
unsafe impl Send for DbPtr {}
unsafe impl Sync for DbPtr {}

impl fmt::Debug for DbPtr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("DbPtr").field(&self.0).finish()
    }
}

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/// A value extracted from a SQLite column.
#[derive(Clone, Debug)]
enum SqlValue {
    Null,
    Integer(i64),
    Float(f64),
    Text(String),
    Blob(Vec<u8>),
}

/// Column description.
#[derive(Clone, Debug)]
struct ColumnDesc {
    name: String,
}

/// Result of executing a SQL statement.
struct ExecResult {
    columns: Vec<ColumnDesc>,
    rows: Vec<Vec<SqlValue>>,
    rowcount: i32,
    lastrowid: i64,
}

// ---------------------------------------------------------------------------
// Core execution helper
// ---------------------------------------------------------------------------

fn get_errmsg(db: *mut ffi::sqlite3) -> String {
    unsafe {
        let msg = ffi::sqlite3_errmsg(db);
        if msg.is_null() {
            "unknown error".to_string()
        } else {
            CStr::from_ptr(msg).to_string_lossy().into_owned()
        }
    }
}

fn execute_sql(
    db: *mut ffi::sqlite3,
    sql: &str,
    params: &[SqlValue],
) -> Result<ExecResult, String> {
    let c_sql = CString::new(sql).map_err(|e| format!("invalid SQL string: {e}"))?;

    let mut stmt: *mut ffi::sqlite3_stmt = std::ptr::null_mut();
    let rc =
        unsafe { ffi::sqlite3_prepare_v2(db, c_sql.as_ptr(), -1, &mut stmt, std::ptr::null_mut()) };
    if rc != ffi::SQLITE_OK {
        return Err(get_errmsg(db));
    }

    // Bind parameters
    for (i, param) in params.iter().enumerate() {
        let idx = (i + 1) as c_int;
        let rc = unsafe {
            match param {
                SqlValue::Null => ffi::sqlite3_bind_null(stmt, idx),
                SqlValue::Integer(v) => ffi::sqlite3_bind_int64(stmt, idx, *v),
                SqlValue::Float(v) => ffi::sqlite3_bind_double(stmt, idx, *v),
                SqlValue::Text(v) => {
                    let c = CString::new(v.as_str()).unwrap_or_default();
                    ffi::sqlite3_bind_text(
                        stmt,
                        idx,
                        c.as_ptr(),
                        c.as_bytes().len() as c_int,
                        ffi::SQLITE_TRANSIENT,
                    )
                }
                SqlValue::Blob(v) => ffi::sqlite3_bind_blob(
                    stmt,
                    idx,
                    v.as_ptr(),
                    v.len() as c_int,
                    ffi::SQLITE_TRANSIENT,
                ),
            }
        };
        if rc != ffi::SQLITE_OK {
            unsafe { ffi::sqlite3_finalize(stmt) };
            return Err(get_errmsg(db));
        }
    }

    // Collect column descriptions
    let col_count = unsafe { ffi::sqlite3_column_count(stmt) };
    let columns: Vec<ColumnDesc> = (0..col_count)
        .map(|i| {
            let name = unsafe {
                let ptr = ffi::sqlite3_column_name(stmt, i);
                if ptr.is_null() {
                    String::new()
                } else {
                    CStr::from_ptr(ptr).to_string_lossy().into_owned()
                }
            };
            ColumnDesc { name }
        })
        .collect();

    // Step through rows
    let mut rows = Vec::new();
    loop {
        let rc = unsafe { ffi::sqlite3_step(stmt) };
        match rc {
            ffi::SQLITE_ROW => {
                let mut row = Vec::with_capacity(col_count as usize);
                for i in 0..col_count {
                    let val = unsafe {
                        match ffi::sqlite3_column_type(stmt, i) {
                            ffi::SQLITE_NULL => SqlValue::Null,
                            ffi::SQLITE_INTEGER => {
                                SqlValue::Integer(ffi::sqlite3_column_int64(stmt, i))
                            }
                            ffi::SQLITE_FLOAT => {
                                SqlValue::Float(ffi::sqlite3_column_double(stmt, i))
                            }
                            ffi::SQLITE_TEXT => {
                                let ptr = ffi::sqlite3_column_text(stmt, i);
                                if ptr.is_null() {
                                    SqlValue::Null
                                } else {
                                    SqlValue::Text(
                                        CStr::from_ptr(ptr).to_string_lossy().into_owned(),
                                    )
                                }
                            }
                            ffi::SQLITE_BLOB => {
                                let ptr = ffi::sqlite3_column_blob(stmt, i);
                                let len = ffi::sqlite3_column_bytes(stmt, i) as usize;
                                if ptr.is_null() || len == 0 {
                                    SqlValue::Blob(Vec::new())
                                } else {
                                    SqlValue::Blob(std::slice::from_raw_parts(ptr, len).to_vec())
                                }
                            }
                            _ => SqlValue::Null,
                        }
                    };
                    row.push(val);
                }
                rows.push(row);
            }
            ffi::SQLITE_DONE => break,
            _ => {
                let err = get_errmsg(db);
                unsafe { ffi::sqlite3_finalize(stmt) };
                return Err(err);
            }
        }
    }

    let rowcount = unsafe { ffi::sqlite3_changes(db) };
    let lastrowid = unsafe { ffi::sqlite3_last_insert_rowid(db) };
    unsafe { ffi::sqlite3_finalize(stmt) };

    Ok(ExecResult {
        columns,
        rows,
        rowcount,
        lastrowid,
    })
}

// ---------------------------------------------------------------------------
// Convert Python params to SqlValue
// ---------------------------------------------------------------------------

#[allow(deprecated)] // payload() is deprecated in favour of downcast_ref()
fn py_to_sql_params(
    params: &vm::PyObjectRef,
    py_vm: &vm::VirtualMachine,
) -> vm::PyResult<Vec<SqlValue>> {
    use vm::builtins::{PyBytes, PyFloat, PyInt, PyList, PyStr, PyTuple};

    // Accept either a tuple or a list of params
    let items: Vec<vm::PyObjectRef> = if let Some(t) = params.payload::<PyTuple>() {
        t.as_slice().to_vec()
    } else if let Some(l) = params.payload::<PyList>() {
        l.borrow_vec().to_vec()
    } else {
        return Err(py_vm.new_type_error("parameters must be a tuple or list".to_owned()));
    };

    let mut out = Vec::with_capacity(items.len());
    for obj in &items {
        if py_vm.is_none(obj) {
            out.push(SqlValue::Null);
        } else if let Some(i) = obj.payload::<PyInt>() {
            let val = i.try_to_primitive::<i64>(py_vm).unwrap_or(0);
            out.push(SqlValue::Integer(val));
        } else if let Some(f) = obj.payload::<PyFloat>() {
            out.push(SqlValue::Float(f.to_f64()));
        } else if let Some(s) = obj.payload::<PyStr>() {
            out.push(SqlValue::Text(s.as_str().to_owned()));
        } else if let Some(b) = obj.payload::<PyBytes>() {
            out.push(SqlValue::Blob(b.as_bytes().to_vec()));
        } else {
            // Fall back to str representation
            let s = obj.str(py_vm)?;
            out.push(SqlValue::Text(s.as_str().to_owned()));
        }
    }
    Ok(out)
}

/// Convert a SqlValue to a Python object.
fn sql_to_py(val: &SqlValue, py_vm: &vm::VirtualMachine) -> vm::PyObjectRef {
    match val {
        SqlValue::Null => py_vm.ctx.none(),
        SqlValue::Integer(i) => py_vm.ctx.new_int(*i).into(),
        SqlValue::Float(f) => py_vm.ctx.new_float(*f).into(),
        SqlValue::Text(s) => py_vm.ctx.new_str(s.as_str()).into(),
        SqlValue::Blob(b) => py_vm.ctx.new_bytes(b.clone()).into(),
    }
}

/// Get the SQLite library version string.
fn sqlite_version_string() -> String {
    unsafe {
        let ptr = ffi::sqlite3_libversion();
        if ptr.is_null() {
            "3.49.1".to_string()
        } else {
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        }
    }
}

// ---------------------------------------------------------------------------
// PyConnection
// ---------------------------------------------------------------------------

#[vm::pyclass(module = "_sqlite3", name = "Connection")]
#[derive(Debug, vm::PyPayload)]
struct PyConnection {
    db: Mutex<Option<DbPtr>>,
}

#[vm::pyclass]
impl PyConnection {
    fn get_db(&self, py_vm: &vm::VirtualMachine) -> vm::PyResult<*mut ffi::sqlite3> {
        let guard = self.db.lock().unwrap();
        match &*guard {
            Some(ptr) => Ok(ptr.0),
            None => Err(py_vm.new_exception_msg(
                py_vm.ctx.exceptions.runtime_error.to_owned(),
                "Cannot operate on a closed database.".to_owned(),
            )),
        }
    }

    #[pymethod]
    fn execute(
        &self,
        sql: vm::builtins::PyStrRef,
        params: vm::function::OptionalArg<vm::PyObjectRef>,
        py_vm: &vm::VirtualMachine,
    ) -> vm::PyResult<PyCursor> {
        let db = self.get_db(py_vm)?;
        let sql_params = match params {
            vm::function::OptionalArg::Present(ref p) => py_to_sql_params(p, py_vm)?,
            vm::function::OptionalArg::Missing => Vec::new(),
        };
        let result = execute_sql(db, sql.as_str(), &sql_params).map_err(|e| {
            py_vm.new_exception_msg(py_vm.ctx.exceptions.runtime_error.to_owned(), e)
        })?;

        let description = if result.columns.is_empty() {
            None
        } else {
            Some(result.columns.iter().map(|c| c.name.clone()).collect())
        };

        Ok(PyCursor {
            db: Mutex::new(Some(DbPtr(db))),
            rows: Mutex::new(result.rows),
            row_index: Mutex::new(0),
            description: Mutex::new(description),
            rowcount: Mutex::new(result.rowcount),
            lastrowid: Mutex::new(result.lastrowid),
        })
    }

    #[pymethod]
    fn cursor(&self, py_vm: &vm::VirtualMachine) -> vm::PyResult<PyCursor> {
        let db = self.get_db(py_vm)?;
        Ok(PyCursor {
            db: Mutex::new(Some(DbPtr(db))),
            rows: Mutex::new(Vec::new()),
            row_index: Mutex::new(0),
            description: Mutex::new(None),
            rowcount: Mutex::new(-1),
            lastrowid: Mutex::new(0),
        })
    }

    #[pymethod]
    fn commit(&self, py_vm: &vm::VirtualMachine) -> vm::PyResult<()> {
        let db = self.get_db(py_vm)?;
        let _ = execute_sql(db, "COMMIT", &[]);
        Ok(())
    }

    #[pymethod]
    fn close(&self, py_vm: &vm::VirtualMachine) -> vm::PyResult<()> {
        let mut guard = self.db.lock().unwrap();
        if let Some(ptr) = guard.take() {
            let rc = unsafe { ffi::sqlite3_close(ptr.0) };
            if rc != ffi::SQLITE_OK {
                return Err(py_vm.new_exception_msg(
                    py_vm.ctx.exceptions.runtime_error.to_owned(),
                    "Failed to close database".to_owned(),
                ));
            }
        }
        Ok(())
    }

    #[pymethod]
    fn __enter__(zelf: vm::PyRef<Self>) -> vm::PyRef<Self> {
        zelf
    }

    #[pymethod]
    fn __exit__(
        &self,
        _exc_type: vm::PyObjectRef,
        _exc_val: vm::PyObjectRef,
        _exc_tb: vm::PyObjectRef,
        py_vm: &vm::VirtualMachine,
    ) -> vm::PyResult<()> {
        self.close(py_vm)
    }
}

// ---------------------------------------------------------------------------
// PyCursor
// ---------------------------------------------------------------------------

#[vm::pyclass(module = "_sqlite3", name = "Cursor")]
#[derive(Debug, vm::PyPayload)]
struct PyCursor {
    db: Mutex<Option<DbPtr>>,
    rows: Mutex<Vec<Vec<SqlValue>>>,
    row_index: Mutex<usize>,
    description: Mutex<Option<Vec<String>>>,
    rowcount: Mutex<i32>,
    lastrowid: Mutex<i64>,
}

#[vm::pyclass]
impl PyCursor {
    fn get_db(&self, py_vm: &vm::VirtualMachine) -> vm::PyResult<*mut ffi::sqlite3> {
        let guard = self.db.lock().unwrap();
        match &*guard {
            Some(ptr) => Ok(ptr.0),
            None => Err(py_vm.new_exception_msg(
                py_vm.ctx.exceptions.runtime_error.to_owned(),
                "Cursor has no database connection.".to_owned(),
            )),
        }
    }

    #[pymethod]
    fn execute(
        zelf: vm::PyRef<Self>,
        sql: vm::builtins::PyStrRef,
        params: vm::function::OptionalArg<vm::PyObjectRef>,
        py_vm: &vm::VirtualMachine,
    ) -> vm::PyResult<vm::PyRef<Self>> {
        let db = zelf.get_db(py_vm)?;
        let sql_params = match params {
            vm::function::OptionalArg::Present(ref p) => py_to_sql_params(p, py_vm)?,
            vm::function::OptionalArg::Missing => Vec::new(),
        };
        let result = execute_sql(db, sql.as_str(), &sql_params).map_err(|e| {
            py_vm.new_exception_msg(py_vm.ctx.exceptions.runtime_error.to_owned(), e)
        })?;

        {
            let desc = if result.columns.is_empty() {
                None
            } else {
                Some(result.columns.iter().map(|c| c.name.clone()).collect())
            };
            *zelf.description.lock().unwrap() = desc;
        }
        *zelf.rows.lock().unwrap() = result.rows;
        *zelf.row_index.lock().unwrap() = 0;
        *zelf.rowcount.lock().unwrap() = result.rowcount;
        *zelf.lastrowid.lock().unwrap() = result.lastrowid;

        Ok(zelf)
    }

    #[pymethod]
    fn fetchone(&self, py_vm: &vm::VirtualMachine) -> vm::PyObjectRef {
        let rows = self.rows.lock().unwrap();
        let mut idx = self.row_index.lock().unwrap();
        if *idx < rows.len() {
            let row = &rows[*idx];
            *idx += 1;
            let tuple: Vec<vm::PyObjectRef> = row.iter().map(|v| sql_to_py(v, py_vm)).collect();
            py_vm.ctx.new_tuple(tuple).into()
        } else {
            py_vm.ctx.none()
        }
    }

    #[pymethod]
    fn fetchall(&self, py_vm: &vm::VirtualMachine) -> vm::PyObjectRef {
        let rows = self.rows.lock().unwrap();
        let mut idx = self.row_index.lock().unwrap();
        let remaining: Vec<vm::PyObjectRef> = rows[*idx..]
            .iter()
            .map(|row| {
                let tuple: Vec<vm::PyObjectRef> = row.iter().map(|v| sql_to_py(v, py_vm)).collect();
                py_vm.ctx.new_tuple(tuple).into()
            })
            .collect();
        *idx = rows.len();
        py_vm.ctx.new_list(remaining).into()
    }

    #[pygetset]
    fn description(&self, py_vm: &vm::VirtualMachine) -> vm::PyObjectRef {
        let desc = self.description.lock().unwrap();
        match &*desc {
            None => py_vm.ctx.none(),
            Some(names) => {
                let tuples: Vec<vm::PyObjectRef> = names
                    .iter()
                    .map(|name| {
                        // PEP 249: 7-tuple (name, type_code, display_size,
                        // internal_size, precision, scale, null_ok)
                        let items: Vec<vm::PyObjectRef> = vec![
                            py_vm.ctx.new_str(name.as_str()).into(),
                            py_vm.ctx.none(),
                            py_vm.ctx.none(),
                            py_vm.ctx.none(),
                            py_vm.ctx.none(),
                            py_vm.ctx.none(),
                            py_vm.ctx.none(),
                        ];
                        py_vm.ctx.new_tuple(items).into()
                    })
                    .collect();
                py_vm.ctx.new_list(tuples).into()
            }
        }
    }

    #[pygetset]
    fn rowcount(&self) -> i32 {
        *self.rowcount.lock().unwrap()
    }

    #[pygetset]
    fn lastrowid(&self) -> i64 {
        *self.lastrowid.lock().unwrap()
    }
}

// ---------------------------------------------------------------------------
// Row - minimal implementation for stdlib compatibility
// ---------------------------------------------------------------------------

/// Minimal Row type required by sqlite3.dbapi2 (`collections.abc.Sequence.register(Row)`).
/// This is a tuple-like type; we implement it as a wrapper around a tuple.
#[vm::pyclass(module = "_sqlite3", name = "Row")]
#[derive(Debug, vm::PyPayload)]
struct PyRow;

#[vm::pyclass]
impl PyRow {}

// ---------------------------------------------------------------------------
// Python module: _sqlite3
// ---------------------------------------------------------------------------

#[allow(non_snake_case)]
#[vm::pymodule]
pub mod _sqlite3 {
    use super::*;
    use vm::class::PyClassImpl;
    use vm::{PyResult, VirtualMachine};

    #[pyattr]
    fn Connection(vm: &VirtualMachine) -> vm::builtins::PyTypeRef {
        PyConnection::make_class(&vm.ctx)
    }

    #[pyattr]
    fn Cursor(vm: &VirtualMachine) -> vm::builtins::PyTypeRef {
        PyCursor::make_class(&vm.ctx)
    }

    #[pyattr]
    fn Row(vm: &VirtualMachine) -> vm::builtins::PyTypeRef {
        PyRow::make_class(&vm.ctx)
    }

    #[pyattr]
    fn sqlite_version(_vm: &VirtualMachine) -> String {
        sqlite_version_string()
    }

    #[pyfunction]
    fn connect(path: vm::builtins::PyStrRef, py_vm: &VirtualMachine) -> PyResult<PyConnection> {
        let c_path =
            CString::new(path.as_str()).map_err(|e| py_vm.new_value_error(e.to_string()))?;
        let mut db: *mut ffi::sqlite3 = std::ptr::null_mut();
        let rc = unsafe { ffi::sqlite3_open(c_path.as_ptr(), &mut db) };
        if rc != ffi::SQLITE_OK {
            let err = if db.is_null() {
                "Failed to open database".to_string()
            } else {
                let msg = get_errmsg(db);
                unsafe { ffi::sqlite3_close(db) };
                msg
            };
            return Err(py_vm.new_exception_msg(py_vm.ctx.exceptions.runtime_error.to_owned(), err));
        }
        Ok(PyConnection {
            db: Mutex::new(Some(DbPtr(db))),
        })
    }

    /// No-op adapter registration for stdlib compatibility.
    #[pyfunction]
    fn register_adapter(
        _type_obj: vm::PyObjectRef,
        _callable: vm::PyObjectRef,
        _py_vm: &VirtualMachine,
    ) {
        // No-op: adapter/converter system not implemented
    }

    /// No-op converter registration for stdlib compatibility.
    #[pyfunction]
    fn register_converter(
        _name: vm::builtins::PyStrRef,
        _callable: vm::PyObjectRef,
        _py_vm: &VirtualMachine,
    ) {
        // No-op: adapter/converter system not implemented
    }
}

/// Public entry point for module registration.
pub fn module_def(ctx: &vm::Context) -> &'static vm::builtins::PyModuleDef {
    _sqlite3::module_def(ctx)
}
