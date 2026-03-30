//! Integration tests for SandboxManager — exercises the high-level sandbox
//! abstraction that the dispatcher uses.

use sdk_server_wasmtime::sandbox::SandboxManager;

fn wasm_bytes() -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm");
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[tokio::test]
async fn test_create_and_run() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, None).await.unwrap();
    let result = mgr.root_run("echo hello").await.unwrap();
    assert_eq!(result["exitCode"].as_i64().unwrap(), 0);
    assert!(result["stdout"].as_str().unwrap().contains("hello"));
}

#[tokio::test]
async fn test_file_ops() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, None).await.unwrap();

    let sb = mgr.root.as_mut().unwrap();

    // write
    sb.shell.vfs_mut().write_file("/tmp/hello.txt", b"hello world", false).unwrap();

    // read
    let content = sb.shell.vfs().read_file("/tmp/hello.txt").unwrap();
    assert_eq!(content.as_slice(), b"hello world");

    // stat
    let st = sb.shell.vfs().stat("/tmp/hello.txt").unwrap();
    assert_eq!(st.size, 11);

    // list
    let entries = sb.shell.vfs().readdir("/tmp").unwrap();
    assert!(entries.iter().any(|e| e.name == "hello.txt"));

    // mkdir + list
    sb.shell.vfs_mut().mkdir("/tmp/subdir").unwrap();
    let entries2 = sb.shell.vfs().readdir("/tmp").unwrap();
    assert!(entries2.iter().any(|e| e.name == "subdir"));

    // rm (unlink)
    sb.shell.vfs_mut().unlink("/tmp/hello.txt").unwrap();
    assert!(sb.shell.vfs().read_file("/tmp/hello.txt").is_err());
}

#[tokio::test]
async fn test_file_ops_rpc() {
    use base64::Engine as _;
    use tokio::sync::mpsc;

    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = sdk_server_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    // create
    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm");
    let (r, _) = disp
        .dispatch(
            Some(sdk_server_wasmtime::rpc::RequestId::Int(1)),
            "create",
            serde_json::json!({
                "shellWasmPath": wasm_path.to_str().unwrap(),
            }),
        )
        .await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    // files.write
    let data = base64::engine::general_purpose::STANDARD.encode(b"test content");
    let (r2, _) = disp
        .dispatch(
            Some(sdk_server_wasmtime::rpc::RequestId::Int(2)),
            "files.write",
            serde_json::json!({
                "path": "/tmp/rpc_test.txt",
                "data": data,
            }),
        )
        .await;
    assert!(r2.result.is_some(), "files.write failed: {:?}", r2.error);

    // files.read
    let (r3, _) = disp
        .dispatch(
            Some(sdk_server_wasmtime::rpc::RequestId::Int(3)),
            "files.read",
            serde_json::json!({
                "path": "/tmp/rpc_test.txt",
            }),
        )
        .await;
    let result = r3.result.unwrap();
    let decoded =
        base64::engine::general_purpose::STANDARD.decode(result["data"].as_str().unwrap()).unwrap();
    assert_eq!(decoded, b"test content");

    // files.list
    let (r4, _) = disp
        .dispatch(
            Some(sdk_server_wasmtime::rpc::RequestId::Int(4)),
            "files.list",
            serde_json::json!({
                "path": "/tmp",
            }),
        )
        .await;
    let entries = r4.result.unwrap();
    let names: Vec<_> = entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(names.contains(&"rpc_test.txt".to_owned()));

    // files.mkdir
    let (r5, _) = disp
        .dispatch(
            Some(sdk_server_wasmtime::rpc::RequestId::Int(5)),
            "files.mkdir",
            serde_json::json!({
                "path": "/tmp/newdir",
            }),
        )
        .await;
    assert!(r5.result.is_some(), "files.mkdir failed: {:?}", r5.error);

    // files.stat
    let (r6, _) = disp
        .dispatch(
            Some(sdk_server_wasmtime::rpc::RequestId::Int(6)),
            "files.stat",
            serde_json::json!({
                "path": "/tmp/rpc_test.txt",
            }),
        )
        .await;
    let stat = r6.result.unwrap();
    assert_eq!(stat["type"].as_str().unwrap(), "file");

    // files.rm
    let (r7, _) = disp
        .dispatch(
            Some(sdk_server_wasmtime::rpc::RequestId::Int(7)),
            "files.rm",
            serde_json::json!({
                "path": "/tmp/rpc_test.txt",
            }),
        )
        .await;
    assert!(r7.result.is_some(), "files.rm failed: {:?}", r7.error);
}

#[tokio::test]
async fn test_run_and_env() {
    use tokio::sync::mpsc;
    let wasm = wasm_bytes();
    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = sdk_server_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm");
    disp.dispatch(Some(sdk_server_wasmtime::rpc::RequestId::Int(1)), "create", serde_json::json!({
        "shellWasmPath": wasm_path.to_str().unwrap(),
    })).await;

    // basic run
    let (r, _) = disp.dispatch(Some(sdk_server_wasmtime::rpc::RequestId::Int(2)), "run", serde_json::json!({
        "command": "echo hello",
    })).await;
    let result = r.result.unwrap();
    assert_eq!(result["exitCode"].as_i64().unwrap(), 0);
    assert!(result["stdout"].as_str().unwrap().trim() == "hello");

    // env.set + env.get
    let (r2, _) = disp.dispatch(Some(sdk_server_wasmtime::rpc::RequestId::Int(3)), "env.set", serde_json::json!({
        "name": "MYVAR",
        "value": "testvalue",
    })).await;
    assert!(r2.result.is_some(), "env.set failed: {:?}", r2.error);

    let (r3, _) = disp.dispatch(Some(sdk_server_wasmtime::rpc::RequestId::Int(4)), "env.get", serde_json::json!({
        "name": "MYVAR",
    })).await;
    // After setting via 'export MYVAR=testvalue', the env should sync on next run.
    // env.get returns from manager.env which is synced after each run_command call.
    // Since env.set runs 'export ...' as a command, env is synced.
    assert_eq!(r3.result.unwrap()["value"].as_str().unwrap(), "testvalue");
}

#[tokio::test]
async fn test_snapshot() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, None).await.unwrap();

    let sb = mgr.root.as_mut().unwrap();
    sb.shell.vfs_mut().write_file("/tmp/before.txt", b"before", false).unwrap();

    let snap_id = sb.shell.vfs_mut().snapshot();
    sb.shell.vfs_mut().write_file("/tmp/after.txt", b"after", false).unwrap();
    assert!(sb.shell.vfs().read_file("/tmp/after.txt").is_ok());

    sb.shell.vfs_mut().restore(&snap_id).unwrap();
    assert!(sb.shell.vfs().read_file("/tmp/before.txt").is_ok());
    assert!(sb.shell.vfs().read_file("/tmp/after.txt").is_err());
}

#[tokio::test]
async fn test_mount() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, None).await.unwrap();

    let sb = mgr.root.as_mut().unwrap();
    sb.shell.vfs_mut().mkdirp("/mnt/tools").unwrap();
    sb.shell.vfs_mut().write_file("/mnt/tools/greet.sh", b"echo greetings", false).unwrap();

    let result = sb.run("sh /mnt/tools/greet.sh").await.unwrap();
    assert!(result["stdout"].as_str().unwrap().contains("greetings"));
}

#[tokio::test]
async fn test_snapshot_rpc() {
    use base64::Engine as _;
    use tokio::sync::mpsc;

    let (tx, mut rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = sdk_server_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm");

    // create
    let (r, _) = disp.dispatch(
        Some(sdk_server_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    // write a file
    let data = base64::engine::general_purpose::STANDARD.encode(b"original");
    let (r, _) = disp.dispatch(
        Some(sdk_server_wasmtime::rpc::RequestId::Int(2)),
        "files.write",
        serde_json::json!({"path": "/tmp/snap.txt", "data": data}),
    ).await;
    assert!(r.result.is_some(), "files.write failed: {:?}", r.error);

    // take snapshot
    let (r, _) = disp.dispatch(
        Some(sdk_server_wasmtime::rpc::RequestId::Int(3)),
        "snapshot.create",
        serde_json::json!({}),
    ).await;
    assert!(r.result.is_some(), "snapshot.create failed: {:?}", r.error);
    let snap_id = r.result.unwrap()["id"].as_str().unwrap().to_string();

    // overwrite file
    let data2 = base64::engine::general_purpose::STANDARD.encode(b"modified");
    let (r, _) = disp.dispatch(
        Some(sdk_server_wasmtime::rpc::RequestId::Int(4)),
        "files.write",
        serde_json::json!({"path": "/tmp/snap.txt", "data": data2}),
    ).await;
    assert!(r.result.is_some(), "files.write 2 failed: {:?}", r.error);

    // restore snapshot
    let (r, _) = disp.dispatch(
        Some(sdk_server_wasmtime::rpc::RequestId::Int(5)),
        "snapshot.restore",
        serde_json::json!({"id": snap_id}),
    ).await;
    assert!(r.result.is_some(), "snapshot.restore failed: {:?}", r.error);

    // verify original content restored
    let (r, _) = disp.dispatch(
        Some(sdk_server_wasmtime::rpc::RequestId::Int(6)),
        "files.read",
        serde_json::json!({"path": "/tmp/snap.txt"}),
    ).await;
    assert!(r.result.is_some(), "files.read failed: {:?}", r.error);
    let b64 = r.result.unwrap()["data"].as_str().unwrap().to_string();
    let content = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
    assert_eq!(content, b"original");

    // drain any pending notifications
    while rx.try_recv().is_ok() {}
}

#[tokio::test]
async fn test_mount_rpc() {
    use base64::Engine as _;
    use tokio::sync::mpsc;

    let (tx, mut rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = sdk_server_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/orchestrator/src/platform/__tests__/fixtures/codepod-shell-exec.wasm");

    // create
    let (r, _) = disp.dispatch(
        Some(sdk_server_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    // mount files
    let script_b64 = base64::engine::general_purpose::STANDARD.encode(b"echo mounted");
    let (r, _) = disp.dispatch(
        Some(sdk_server_wasmtime::rpc::RequestId::Int(2)),
        "mount",
        serde_json::json!({
            "path": "/mnt/scripts",
            "files": {"run.sh": script_b64},
        }),
    ).await;
    assert!(r.result.is_some(), "mount failed: {:?}", r.error);

    // run the mounted script
    let (r, _) = disp.dispatch(
        Some(sdk_server_wasmtime::rpc::RequestId::Int(3)),
        "run",
        serde_json::json!({"command": "sh /mnt/scripts/run.sh"}),
    ).await;
    assert!(r.result.is_some(), "run failed: {:?}", r.error);
    let stdout = r.result.unwrap()["stdout"].as_str().unwrap().to_string();
    assert!(stdout.contains("mounted"), "expected 'mounted' in stdout, got: {stdout}");

    // drain any pending notifications
    while rx.try_recv().is_ok() {}
}
