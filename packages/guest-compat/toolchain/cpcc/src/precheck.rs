use anyhow::{anyhow, Context, Result};
use std::path::Path;
use std::process::Command;

/// Stage 1: `llvm-nm` on the archive — every named Tier 1 symbol and its
/// marker must be defined in the same object. `llvm-nm -A` prefixes each
/// line with `archive.a(obj):` so we can correlate the object that owns
/// each defined symbol.
pub fn check_archive(nm: &Path, archive: &Path, symbols: &[&str]) -> Result<()> {
    let out = Command::new(nm)
        .arg("-A")
        .arg("--defined-only")
        .arg(archive)
        .output()
        .with_context(|| format!("running {} -A {}", nm.display(), archive.display()))?;
    if !out.status.success() {
        return Err(anyhow!(
            "llvm-nm failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    for sym in symbols {
        let marker = format!("__codepod_guest_compat_marker_{sym}");
        let sym_obj = find_object_for(&text, sym)
            .ok_or_else(|| anyhow!("archive missing defined symbol {sym}"))?;
        let marker_obj = find_object_for(&text, &marker)
            .ok_or_else(|| anyhow!("archive missing defined marker {marker}"))?;
        if sym_obj != marker_obj {
            return Err(anyhow!(
                "§Verifying Precedence step 1 failed: {sym} in {sym_obj} but {marker} in {marker_obj}"
            ));
        }
    }
    Ok(())
}

fn find_object_for(nm_output: &str, sym: &str) -> Option<String> {
    for line in nm_output.lines() {
        // llvm-nm -A lines: `archive.a(obj.o): <addr> <type> <name>`
        let rest = match line.rsplit_once(' ') {
            Some((head, tail)) if tail == sym => head,
            _ => continue,
        };
        let head = rest.split_whitespace().next()?;
        let obj = head
            .rsplit_once('(')
            .and_then(|(_, o)| o.strip_suffix("):"))
            .map(|o| o.to_string())
            .unwrap_or_else(|| head.to_string());
        return Some(obj);
    }
    None
}

/// Stages 2+3: inspect the pre-opt `.wasm`. Every queried symbol's marker
/// must be exported, and the symbol's function body must call the marker.
pub fn check_wasm(pre_opt: &Path, symbols: &[&str]) -> Result<()> {
    let bytes = std::fs::read(pre_opt).with_context(|| format!("reading {}", pre_opt.display()))?;
    let mut exports: std::collections::HashMap<String, u32> = Default::default();
    let mut imports_count: u32 = 0;
    let parser = wasmparser::Parser::new(0);
    for payload in parser.parse_all(&bytes) {
        let payload = payload.context("wasm parse")?;
        match payload {
            wasmparser::Payload::ImportSection(reader) => {
                // In wasmparser 0.247, ImportSectionReader iterates Imports<'a>
                // (grouped entries). Use into_imports() to flatten to individual
                // Import items.
                for imp in reader.into_imports() {
                    let imp = imp.context("import")?;
                    if matches!(
                        imp.ty,
                        wasmparser::TypeRef::Func(_) | wasmparser::TypeRef::FuncExact(_)
                    ) {
                        imports_count += 1;
                    }
                }
            }
            wasmparser::Payload::ExportSection(reader) => {
                for exp in reader {
                    let exp = exp.context("export")?;
                    if exp.kind == wasmparser::ExternalKind::Func {
                        exports.insert(exp.name.to_string(), exp.index);
                    }
                }
            }
            _ => {}
        }
    }
    for sym in symbols {
        let marker = format!("__codepod_guest_compat_marker_{sym}");
        if !exports.contains_key(&marker) {
            return Err(anyhow!(
                "§Verifying Precedence step 2 failed: pre-opt wasm missing export {marker}"
            ));
        }
    }
    verify_call_edges(&bytes, symbols, imports_count, &exports)
}

fn verify_call_edges(
    bytes: &[u8],
    symbols: &[&str],
    imports_count: u32,
    exports: &std::collections::HashMap<String, u32>,
) -> Result<()> {
    let parser = wasmparser::Parser::new(0);
    let mut code_idx: u32 = 0;
    let mut callees_by_func: std::collections::HashMap<u32, Vec<u32>> = Default::default();
    for payload in parser.parse_all(bytes) {
        let payload = payload.context("parse")?;
        if let wasmparser::Payload::CodeSectionEntry(body) = payload {
            let func_index = imports_count + code_idx;
            code_idx += 1;
            let mut calls = Vec::new();
            for op in body.get_operators_reader()? {
                if let Ok(wasmparser::Operator::Call { function_index }) = op {
                    calls.push(function_index);
                }
            }
            callees_by_func.insert(func_index, calls);
        }
    }
    for sym in symbols {
        let sym_idx = *exports.get(*sym).ok_or_else(|| {
            anyhow!("§Verifying Precedence step 2 failed: export for {sym} missing in pre-opt wasm")
        })?;
        let marker_idx = *exports
            .get(&format!("__codepod_guest_compat_marker_{sym}"))
            .expect("marker export presence already checked");
        let callees = callees_by_func
            .get(&sym_idx)
            .ok_or_else(|| anyhow!("no body recorded for {sym} at func index {sym_idx}"))?;
        if !callees.contains(&marker_idx) {
            return Err(anyhow!(
                "§Verifying Precedence step 3 failed: {sym} body does not call its marker"
            ));
        }
    }
    Ok(())
}
