use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// The CLI now delegates all state operations to the web server.
/// These tests start a real web server (from apps/web/dist), seed it
/// with a temp HOME, then run CLI commands against it.
struct TestEnv {
    /// The .band directory (used as `BAND_HOME` for the CLI)
    band_dir: PathBuf,
    /// The fake HOME directory (parent of .band, used as HOME for the server)
    _home_dir: PathBuf,
    repo_path: PathBuf,
    server_process: Child,
    tmp: tempfile::TempDir,
}

impl TestEnv {
    fn new() -> Self {
        let tmp = tempfile::tempdir().expect("create tempdir");
        // home_dir is the fake HOME — server computes band_home as HOME/.band
        let home_dir = tmp.path().to_path_buf();
        // band_dir is HOME/.band — used as BAND_HOME for the CLI
        let band_dir = home_dir.join(".band");
        let repo_path = tmp.path().join("my-project");
        let token = "test-token-12345";

        // Create .band dirs
        fs::create_dir_all(band_dir.join("status")).unwrap();
        fs::create_dir_all(band_dir.join("worktrees")).unwrap();

        // Create a real git repo. Canonicalize the path immediately so it
        // matches what `git worktree list --porcelain` reports — on
        // macOS, `tempfile::tempdir()` gives `/var/folders/...` while
        // git resolves the symlink to `/private/var/folders/...`. The
        // server's syncWorktrees (now invoked at boot via
        // runFirstTimeSetup) compares the seeded worktree path against
        // git's canonical form with string equality, so without this
        // shadowing the seeded row would be reconciled away on the very
        // first boot, leaving `statuses.resolve` unable to map the
        // CLI's cwd back to a workspaceId. See #427.
        fs::create_dir_all(&repo_path).unwrap();
        let repo_path = fs::canonicalize(&repo_path).expect("canonicalize repo_path");
        git(&repo_path, &["init", "-b", "main"]);
        git(&repo_path, &["commit", "--allow-empty", "-m", "init"]);

        // Find a free port
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };

        let settings = serde_json::json!({
            "tokenSecret": token,
            "webServerPort": port,
            "worktreesDir": band_dir.join("worktrees").to_string_lossy(),
        });

        // Seed SQLite database with migrations, project data, and settings
        seed_db(&band_dir, &repo_path, &settings);

        // Start the web server
        let web_dist =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist/start-server.mjs");
        assert!(
            web_dist.exists(),
            "Web server not built. Run: pnpm -F @band-app/server build"
        );

        let mut child = Command::new("node")
            .arg(&web_dist)
            .env("HOME", &home_dir)
            .env("PORT", port.to_string())
            .env("NODE_ENV", "production")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to start web server");

        // Wait for "listening" on stdout with a timeout.
        // Spawn a reader thread so we can enforce a deadline without blocking
        // the test forever if the server fails to start. The thread keeps
        // draining stdout for the full lifetime of the server — otherwise
        // the OS pipe buffer fills up under chatty pino logging and the
        // server blocks on its next write, causing later requests to hang
        // or get reset.
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut signaled = false;
            for line in reader.lines() {
                let line = line.unwrap_or_default();
                if !signaled && line.contains("listening") {
                    let _ = tx.send(true);
                    signaled = true;
                }
                // Continue reading to keep the pipe drained.
            }
            if !signaled {
                let _ = tx.send(false);
            }
        });
        let found = rx.recv_timeout(Duration::from_secs(30)).unwrap_or(false);
        if !found {
            // Kill server and capture stderr for diagnostics
            let _ = child.kill();
            let output = child.wait_with_output().ok();
            let stderr_output = output
                .as_ref()
                .map(|o| String::from_utf8_lossy(&o.stderr).to_string())
                .unwrap_or_default();
            panic!(
                "web server did not emit 'listening' within 30s.\nstderr: {}",
                if stderr_output.is_empty() {
                    "(empty)"
                } else {
                    &stderr_output
                }
            );
        }

        Self {
            band_dir,
            _home_dir: home_dir,
            repo_path,
            server_process: child,
            tmp,
        }
    }

    /// Run the `band` binary with `BAND_HOME` set to the test environment.
    fn band(&self, args: &[&str]) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_band"))
            .args(args)
            .env("BAND_HOME", &self.band_dir)
            .output()
            .expect("failed to execute band")
    }

    /// Run the `band` binary with a specific working directory.
    fn band_in(&self, dir: &Path, args: &[&str]) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_band"))
            .args(args)
            .env("BAND_HOME", &self.band_dir)
            .current_dir(dir)
            .output()
            .expect("failed to execute band")
    }

    fn state_json(&self) -> serde_json::Value {
        query_state(&self.band_dir)
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        let _ = self.server_process.kill();
        let _ = self.server_process.wait();
    }
}

/// Seed the `SQLite` database with Drizzle migrations, a test project, and settings.
///
/// Runs a Node.js script that uses `node:sqlite` to apply migrations and
/// insert seed data.
fn seed_db(band_dir: &Path, repo_path: &Path, settings: &serde_json::Value) {
    let seed_script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/seed-db.mjs");
    let output = Command::new("node")
        .arg(&seed_script)
        .arg(band_dir)
        .arg("my-project")
        .arg(repo_path)
        .arg("main")
        .arg(settings.to_string())
        .env("NODE_OPTIONS", "--no-warnings=ExperimentalWarning")
        .output()
        .expect("seed-db.mjs failed to execute");

    assert!(
        output.status.success(),
        "seed-db.mjs failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// List every `panel_states` row for a workspace. Each entry is
/// `{ id, workspace_id, panel_type }`. Used by tests that assert
/// teardown cleanup is complete (i.e. removing the workspace strips
/// all chat/terminal/browser/layout rows associated with it).
fn list_panel_states(band_dir: &Path, workspace_id: &str) -> Vec<serde_json::Value> {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/list-panel-states.mjs");
    let output = Command::new("node")
        .arg(&script)
        .arg(band_dir)
        .arg(workspace_id)
        .output()
        .expect("list-panel-states.mjs failed to execute");

    assert!(
        output.status.success(),
        "list-panel-states.mjs failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value =
        serde_json::from_str(stdout_str.trim()).expect("list-panel-states.mjs returned bad JSON");
    parsed.as_array().cloned().unwrap_or_default()
}

/// Read a saved dockview layout panel-state row (chat, terminal, or
/// browser) for a workspace from the `panel_states` table. Returns
/// `Value::Null` if no layout has been persisted.
fn read_layout(band_dir: &Path, workspace_id: &str, panel_type: &str) -> serde_json::Value {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/read-layout.mjs");
    let output = Command::new("node")
        .arg(&script)
        .arg(band_dir)
        .arg(workspace_id)
        .arg(panel_type)
        .output()
        .expect("read-layout.mjs failed to execute");

    assert!(
        output.status.success(),
        "read-layout.mjs failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout_str.trim()).unwrap_or(serde_json::Value::Null)
}

/// Seed a chat layout (dockview tree) directly into the `panel_states`
/// table. Used by tests that exercise default-chat-panel resolution
/// without going through the dashboard UI to drive the layout.
fn seed_chat_layout(band_dir: &Path, workspace_id: &str, layout: &serde_json::Value) {
    let seed_script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/seed-chat-layout.mjs");
    let output = Command::new("node")
        .arg(&seed_script)
        .arg(band_dir)
        .arg(workspace_id)
        .arg(layout.to_string())
        .output()
        .expect("seed-chat-layout.mjs failed to execute");

    assert!(
        output.status.success(),
        "seed-chat-layout.mjs failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Seed only settings into the database (no project data).
/// Used by tests that don't need a full `TestEnv` but need a valid settings row.
fn seed_settings_only(band_dir: &Path, settings: &serde_json::Value) {
    let seed_script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/seed-settings.mjs");
    let output = Command::new("node")
        .arg(&seed_script)
        .arg(band_dir)
        .arg(settings.to_string())
        .output()
        .expect("seed-settings.mjs failed to execute");

    assert!(
        output.status.success(),
        "seed-settings.mjs failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Query the `SQLite` database and return state in the same shape as the old state.json.
fn query_state(band_dir: &Path) -> serde_json::Value {
    let db_path = band_dir.join("band.db");
    let script = format!(
        r#"
        const {{ DatabaseSync }} = await import("node:sqlite");
        const db = new DatabaseSync("{db}");
        const projects = db.prepare(
            "SELECT name, path, default_branch as defaultBranch FROM projects ORDER BY sort_order"
        ).all();
        const worktrees = db.prepare(
            "SELECT project_name as projectName, branch, path, head FROM worktrees"
        ).all();
        for (const p of projects) {{
            p.worktrees = worktrees.filter(w => w.projectName === p.name);
        }}
        console.log(JSON.stringify({{ projects }}));
        db.close();
        "#,
        db = db_path.to_string_lossy().replace('\\', "/"),
    );

    let output = Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .env("NODE_OPTIONS", "--no-warnings=ExperimentalWarning")
        .output()
        .expect("node query failed");

    assert!(
        output.status.success(),
        "query_state failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("parse state json")
}

fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@test.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@test.com")
        .output()
        .expect("git command failed");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn stdout(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn stderr(output: &std::process::Output) -> String {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
}

// --- Projects tests ---

#[test]
fn projects_list_shows_registered_project() {
    let env = TestEnv::new();
    let output = env.band(&["projects", "list"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("my-project"), "expected project name: {out}");
}

#[test]
fn projects_add_registers_new_project() {
    let env = TestEnv::new();

    // Create a new git repo to add
    let new_repo = env.tmp.path().join("new-project");
    fs::create_dir_all(&new_repo).unwrap();
    git(&new_repo, &["init", "-b", "main"]);
    git(&new_repo, &["commit", "--allow-empty", "-m", "init"]);

    let output = env.band(&["projects", "add", new_repo.to_str().unwrap()]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(
        out.contains("new-project"),
        "expected project name in output: {out}"
    );

    // Verify it appears in projects list
    let list_output = env.band(&["projects", "list"]);
    assert!(list_output.status.success());
    let list_out = stdout(&list_output);
    assert!(
        list_out.contains("new-project"),
        "expected new-project in list: {list_out}"
    );
}

#[test]
fn projects_remove_unregisters_project() {
    let env = TestEnv::new();

    // First add a new project
    let new_repo = env.tmp.path().join("to-remove");
    fs::create_dir_all(&new_repo).unwrap();
    git(&new_repo, &["init", "-b", "main"]);
    git(&new_repo, &["commit", "--allow-empty", "-m", "init"]);

    let add_output = env.band(&["projects", "add", new_repo.to_str().unwrap()]);
    assert!(add_output.status.success());

    // Now remove it
    let output = env.band(&["projects", "remove", "to-remove"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    // Verify it's gone from projects list
    let list_output = env.band(&["projects", "list"]);
    assert!(list_output.status.success());
    let list_out = stdout(&list_output);
    assert!(
        !list_out.contains("to-remove"),
        "expected to-remove to be gone: {list_out}"
    );
}

// --- Workspaces tests ---

#[test]
fn workspaces_create_makes_worktree_and_registers_state() {
    let env = TestEnv::new();
    let output = env.band(&["workspaces", "create", "my-project", "feat/test"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let path = stdout(&output);
    assert!(
        path.contains("feat/test"),
        "expected path with branch: {path}"
    );

    // Worktree directory exists on disk
    assert!(Path::new(&path).exists(), "worktree dir should exist");

    // State was updated (default "main" worktree + newly created one)
    let state = env.state_json();
    let worktrees = state["projects"][0]["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 2);
    assert!(
        worktrees.iter().any(|w| w["branch"] == "feat/test"),
        "expected feat/test in worktrees: {worktrees:?}"
    );
}

#[test]
fn workspaces_create_is_idempotent() {
    let env = TestEnv::new();

    let out1 = env.band(&["workspaces", "create", "my-project", "feat/idem"]);
    assert!(out1.status.success(), "stderr: {}", stderr(&out1));

    let out2 = env.band(&["workspaces", "create", "my-project", "feat/idem"]);
    assert!(out2.status.success(), "stderr: {}", stderr(&out2));

    // Both return the same path
    assert_eq!(stdout(&out1), stdout(&out2));
}

#[test]
fn workspaces_create_with_base_branch() {
    let env = TestEnv::new();

    // Create a commit on main so there's something to branch from
    let marker = env.repo_path.join("marker.txt");
    fs::write(&marker, "hello").unwrap();
    git(&env.repo_path, &["add", "marker.txt"]);
    git(&env.repo_path, &["commit", "-m", "add marker"]);

    let output = env.band(&[
        "workspaces",
        "create",
        "my-project",
        "feat/from-main",
        "--base",
        "main",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let path = stdout(&output);
    assert!(
        Path::new(&path).join("marker.txt").exists(),
        "worktree should have marker.txt from main"
    );
}

#[test]
fn workspaces_create_unknown_project_fails() {
    let env = TestEnv::new();
    let output = env.band(&["workspaces", "create", "nonexistent", "feat/x"]);

    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("not found"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn workspaces_list_shows_created_worktrees() {
    let env = TestEnv::new();
    env.band(&["workspaces", "create", "my-project", "feat/a"]);
    env.band(&["workspaces", "create", "my-project", "feat/b"]);

    let output = env.band(&["workspaces", "list"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("feat/a"), "should list feat/a: {out}");
    assert!(out.contains("feat/b"), "should list feat/b: {out}");
}

#[test]
fn workspaces_list_filters_by_project() {
    let env = TestEnv::new();
    env.band(&["workspaces", "create", "my-project", "feat/filtered"]);

    let output = env.band(&["workspaces", "list", "my-project"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert!(stdout(&output).contains("feat/filtered"));

    let output = env.band(&["workspaces", "list", "nonexistent"]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("not found"));
}

#[test]
fn workspaces_remove_cleans_up_worktree_and_state() {
    let env = TestEnv::new();

    let create_out = env.band(&["workspaces", "create", "my-project", "feat/rm"]);
    assert!(
        create_out.status.success(),
        "stderr: {}",
        stderr(&create_out)
    );
    let path = stdout(&create_out);

    let output = env.band(&["workspaces", "remove", "my-project", "feat/rm"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    // Worktree removed from state (only the seeded "main" worktree remains)
    let state = env.state_json();
    let worktrees = state["projects"][0]["worktrees"].as_array().unwrap();
    assert_eq!(worktrees.len(), 1);
    assert_eq!(worktrees[0]["branch"], "main");

    // Worktree directory removed from disk
    assert!(!Path::new(&path).exists(), "worktree dir should be gone");
}

#[test]
fn workspaces_remove_unknown_branch_fails() {
    let env = TestEnv::new();
    let output = env.band(&["workspaces", "remove", "my-project", "nonexistent"]);

    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("not found"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn workspaces_remove_unknown_project_fails() {
    let env = TestEnv::new();
    let output = env.band(&["workspaces", "remove", "nonexistent", "main"]);

    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("not found"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn setup_script_runs_on_create() {
    let env = TestEnv::new();

    let band_dir = env.repo_path.join(".band");
    fs::create_dir_all(&band_dir).unwrap();
    fs::write(
        band_dir.join("config.json"),
        r#"{ "setup": "touch setup-ran.txt" }"#,
    )
    .unwrap();
    git(&env.repo_path, &["add", ".band/config.json"]);
    git(&env.repo_path, &["commit", "-m", "add config"]);

    let output = env.band(&["workspaces", "create", "my-project", "feat/setup"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let path = stdout(&output);
    // Setup runs asynchronously on the server; poll until the marker file appears.
    let marker = Path::new(&path).join("setup-ran.txt");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !marker.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "setup script should have created setup-ran.txt"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[test]
fn teardown_script_runs_on_remove() {
    let env = TestEnv::new();

    let band_dir = env.repo_path.join(".band");
    fs::create_dir_all(&band_dir).unwrap();
    let marker_path = env.band_dir.join("teardown-ran.txt");
    let config = serde_json::json!({
        "teardown": format!("touch '{}'", marker_path.to_string_lossy())
    });
    fs::write(
        band_dir.join("config.json"),
        serde_json::to_string(&config).unwrap(),
    )
    .unwrap();
    git(&env.repo_path, &["add", ".band/config.json"]);
    git(&env.repo_path, &["commit", "-m", "add config"]);

    let create_out = env.band(&["workspaces", "create", "my-project", "feat/teardown"]);
    assert!(create_out.status.success());

    let output = env.band(&["workspaces", "remove", "my-project", "feat/teardown"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    // Teardown runs asynchronously on the server; poll until the marker file appears.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !marker_path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "teardown script should have created marker"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[test]
fn workspaces_create_with_prompt_submits_task() {
    let env = TestEnv::new();
    let output = env.band(&[
        "workspaces",
        "create",
        "my-project",
        "feat/run",
        "--prompt",
        "hello world",
    ]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let path = stdout(&output);
    assert!(Path::new(&path).exists(), "worktree dir should exist");

    let state = env.state_json();
    let worktrees = &state["projects"][0]["worktrees"];
    assert!(
        worktrees
            .as_array()
            .unwrap()
            .iter()
            .any(|wt| wt["branch"] == "feat/run"),
        "worktree should be in state"
    );
}

#[test]
fn workspaces_create_with_prompt_and_base() {
    let env = TestEnv::new();

    let marker = env.repo_path.join("marker.txt");
    fs::write(&marker, "hello").unwrap();
    git(&env.repo_path, &["add", "marker.txt"]);
    git(&env.repo_path, &["commit", "-m", "add marker"]);

    let output = env.band(&[
        "workspaces",
        "create",
        "my-project",
        "feat/run-base",
        "--prompt",
        "do stuff",
        "--base",
        "main",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let path = stdout(&output);
    assert!(
        Path::new(&path).join("marker.txt").exists(),
        "worktree should have marker.txt from main"
    );
}

#[test]
fn workspaces_create_unknown_project_with_prompt_fails() {
    let env = TestEnv::new();
    let output = env.band(&[
        "workspaces",
        "create",
        "nonexistent",
        "feat/x",
        "--prompt",
        "hello",
    ]);

    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("not found"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn setup_failure_is_non_fatal() {
    let env = TestEnv::new();

    let band_dir = env.repo_path.join(".band");
    fs::create_dir_all(&band_dir).unwrap();
    fs::write(band_dir.join("config.json"), r#"{ "setup": "exit 1" }"#).unwrap();
    git(&env.repo_path, &["add", ".band/config.json"]);
    git(&env.repo_path, &["commit", "-m", "add failing setup"]);

    let output = env.band(&["workspaces", "create", "my-project", "feat/fail-setup"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let path = stdout(&output);
    assert!(Path::new(&path).exists());
}

#[test]
fn notify_silently_succeeds_when_server_unreachable() {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let band_home = tmp.path().join("band-home");
    fs::create_dir_all(&band_home).unwrap();

    let settings = serde_json::json!({
        "tokenSecret": "fake-token",
        "webServerPort": 19999,
    });
    seed_settings_only(&band_home, &settings);

    let output = Command::new(env!("CARGO_BIN_EXE_band"))
        .args(["notify"])
        .env("BAND_HOME", &band_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            use std::io::Write;
            if let Some(ref mut stdin) = child.stdin {
                let _ = stdin.write_all(b"{\"hook_event_name\": \"Stop\", \"cwd\": \"/tmp\"}");
            }
            child.wait_with_output()
        })
        .expect("failed to execute band notify");

    assert!(
        output.status.success(),
        "notify should not fail when server is down. stderr: {}",
        stderr(&output)
    );
}

/// Helper: run `band notify` piping `payload` to stdin, using the live server
/// from a TestEnv.
fn band_notify(env: &TestEnv, payload: &serde_json::Value) -> std::process::Output {
    use std::io::Write;
    let mut child = Command::new(env!("CARGO_BIN_EXE_band"))
        .args(["notify"])
        .env("BAND_HOME", &env.band_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn band notify");
    if let Some(ref mut stdin) = child.stdin {
        let _ = stdin.write_all(payload.to_string().as_bytes());
    }
    child.wait_with_output().expect("band notify failed")
}

/// Helper: query workspace status from the SQLite database.
fn query_agent_status(band_dir: &Path, workspace_id: &str) -> Option<String> {
    let db_path = band_dir.join("band.db");
    let script = format!(
        r#"
        const {{ DatabaseSync }} = await import("node:sqlite");
        const db = new DatabaseSync("{db}");
        const row = db.prepare(
            "SELECT agent_status FROM workspace_statuses WHERE workspace_id = ?"
        ).get("{ws}");
        console.log(JSON.stringify({{ status: row ? row.agent_status : null }}));
        db.close();
        "#,
        db = db_path.to_string_lossy().replace('\\', "/"),
        ws = workspace_id,
    );
    let output = Command::new("node")
        .args(["--input-type=module", "-e", &script])
        .env("NODE_OPTIONS", "--no-warnings=ExperimentalWarning")
        .output()
        .expect("query_agent_status failed");
    assert!(
        output.status.success(),
        "query_agent_status failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("parse json");
    json["status"].as_str().map(String::from)
}

#[test]
fn notify_pre_tool_use_ask_user_question_sets_needs_attention() {
    let env = TestEnv::new();
    let payload = serde_json::json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "AskUserQuestion",
        "cwd": env.repo_path.to_string_lossy()
    });
    let output = band_notify(&env, &payload);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let status = query_agent_status(&env.band_dir, "my-project-main");
    assert_eq!(
        status.as_deref(),
        Some("needs_attention"),
        "PreToolUse+AskUserQuestion should set needs_attention"
    );
}

#[test]
fn notify_pre_tool_use_exit_plan_mode_sets_needs_attention() {
    let env = TestEnv::new();
    let payload = serde_json::json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "ExitPlanMode",
        "cwd": env.repo_path.to_string_lossy()
    });
    let output = band_notify(&env, &payload);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let status = query_agent_status(&env.band_dir, "my-project-main");
    assert_eq!(
        status.as_deref(),
        Some("needs_attention"),
        "PreToolUse+ExitPlanMode should set needs_attention"
    );
}

#[test]
fn notify_pre_tool_use_regular_tool_stays_working() {
    let env = TestEnv::new();
    let payload = serde_json::json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "Read",
        "cwd": env.repo_path.to_string_lossy()
    });
    let output = band_notify(&env, &payload);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let status = query_agent_status(&env.band_dir, "my-project-main");
    assert_eq!(
        status.as_deref(),
        Some("working"),
        "PreToolUse+Read should set working, not needs_attention"
    );
}

#[test]
fn notify_post_tool_use_after_ask_user_restores_working() {
    let env = TestEnv::new();

    // First, AskUserQuestion triggers needs_attention
    let payload = serde_json::json!({
        "hook_event_name": "PreToolUse",
        "tool_name": "AskUserQuestion",
        "cwd": env.repo_path.to_string_lossy()
    });
    let output = band_notify(&env, &payload);
    assert!(output.status.success());
    assert_eq!(
        query_agent_status(&env.band_dir, "my-project-main").as_deref(),
        Some("needs_attention")
    );

    // Then PostToolUse fires after user responds → back to working
    let payload = serde_json::json!({
        "hook_event_name": "PostToolUse",
        "tool_name": "AskUserQuestion",
        "cwd": env.repo_path.to_string_lossy()
    });
    let output = band_notify(&env, &payload);
    assert!(output.status.success());
    assert_eq!(
        query_agent_status(&env.band_dir, "my-project-main").as_deref(),
        Some("working"),
        "PostToolUse should restore working status"
    );
}

#[test]
fn notify_permission_request_sets_working() {
    let env = TestEnv::new();
    let payload = serde_json::json!({
        "hook_event_name": "PermissionRequest",
        "tool_name": "Bash",
        "cwd": env.repo_path.to_string_lossy()
    });
    let output = band_notify(&env, &payload);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let status = query_agent_status(&env.band_dir, "my-project-main");
    assert_eq!(
        status.as_deref(),
        Some("working"),
        "PermissionRequest should set working (not needs_attention)"
    );
}

// --- Settings tests ---

#[test]
fn settings_shows_config() {
    let env = TestEnv::new();
    let output = env.band(&["settings", "--output", "json"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    assert!(
        json.get("worktreesDir").is_some(),
        "expected worktreesDir in settings: {json}"
    );
}

// --- Tunnel tests ---

#[test]
fn tunnel_status_shows_not_running() {
    let env = TestEnv::new();
    let output = env.band(&["tunnel", "status"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(
        out.contains("running: no"),
        "expected tunnel not running: {out}"
    );
}

#[test]
fn tunnel_status_json_output() {
    let env = TestEnv::new();
    let output = env.band(&["tunnel", "status", "--output", "json"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    assert_eq!(json["running"], false, "json: {json}");
}

// --- JSON output tests ---

#[test]
fn workspaces_create_json_output() {
    let env = TestEnv::new();
    let output = env.band(&[
        "workspaces",
        "create",
        "my-project",
        "feat/json",
        "--output",
        "json",
    ]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    assert!(
        json["path"].as_str().unwrap().contains("feat/json"),
        "json: {json}"
    );
}

#[test]
fn workspaces_list_json_output() {
    let env = TestEnv::new();
    env.band(&["workspaces", "create", "my-project", "feat/j1"]);

    let output = env.band(&["workspaces", "list", "--output", "json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    let workspaces = json["workspaces"].as_array().expect("workspaces array");
    assert!(
        workspaces.iter().any(|w| w["branch"] == "feat/j1"),
        "should contain feat/j1: {json}"
    );
}

#[test]
fn projects_list_json_output() {
    let env = TestEnv::new();
    let output = env.band(&["projects", "list", "--output", "json"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    let projects = json["projects"].as_array().expect("projects array");
    assert!(
        projects.iter().any(|p| p["name"] == "my-project"),
        "should contain my-project: {json}"
    );
}

#[test]
fn workspaces_remove_json_output() {
    let env = TestEnv::new();
    env.band(&["workspaces", "create", "my-project", "feat/rmjson"]);

    let output = env.band(&[
        "workspaces",
        "remove",
        "my-project",
        "feat/rmjson",
        "--output",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    assert_eq!(json["ok"], true, "json: {json}");
}

#[test]
fn error_json_output() {
    let env = TestEnv::new();
    let output = env.band(&[
        "workspaces",
        "create",
        "nonexistent",
        "feat/x",
        "--output",
        "json",
    ]);

    assert!(!output.status.success());
    let json: serde_json::Value = serde_json::from_str(&stderr(&output))
        .unwrap_or_else(|e| panic!("invalid JSON error: {e}\nstderr: {}", stderr(&output)));
    assert!(json["error"].as_str().is_some(), "json: {json}");
}

// --- Input validation tests ---

#[test]
fn workspaces_create_rejects_path_traversal() {
    let env = TestEnv::new();
    let output = env.band(&["workspaces", "create", "my-project", "feat/../etc"]);

    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("path traversal"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn workspaces_create_rejects_control_chars() {
    let env = TestEnv::new();
    let output = env.band(&["workspaces", "create", "my-project", "feat/\x01test"]);

    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("control character"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn workspaces_create_rejects_empty_branch() {
    let env = TestEnv::new();
    let output = env.band(&["workspaces", "create", "my-project", ""]);

    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("cannot be empty"),
        "stderr: {}",
        stderr(&output)
    );
}

// --- Chat tests ---

#[test]
fn chat_returns_task_id() {
    let env = TestEnv::new();

    // Create a workspace first
    let create_out = env.band(&["workspaces", "create", "my-project", "feat/task-test"]);
    assert!(
        create_out.status.success(),
        "stderr: {}",
        stderr(&create_out)
    );

    let workspace_id = "my-project-feat-task-test";
    let output = env.band(&[
        "chats",
        "send",
        "--workspace",
        workspace_id,
        "--message",
        "write hello world",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let out = stdout(&output);
    assert!(
        out.starts_with("tsk_"),
        "expected task ID starting with tsk_: {out}"
    );
}

#[test]
fn chat_json_output_includes_chat_id() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/task-json"]);

    let output = env.band(&[
        "chats",
        "send",
        "--workspace",
        "my-project-feat-task-json",
        "--message",
        "hello",
        "--output",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    assert!(
        json["id"].as_str().unwrap().starts_with("tsk_"),
        "json: {json}"
    );
    assert_eq!(
        json["workspaceId"].as_str().unwrap(),
        "my-project-feat-task-json",
        "json: {json}"
    );
    // No --chat-id was passed, so the server resolved the default panel.
    // The chatId should be populated and look like a chat id.
    let resolved = json["chatId"].as_str().unwrap_or("");
    assert!(
        resolved.starts_with("chat_"),
        "expected resolved chatId to start with chat_: {json}"
    );
}

#[test]
fn chat_conflict_returns_error() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/conflict"]);

    // Submit first task — will start running
    let out1 = env.band(&[
        "chats",
        "send",
        "--workspace",
        "my-project-feat-conflict",
        "--message",
        "first task",
    ]);
    assert!(out1.status.success(), "stderr: {}", stderr(&out1));

    // Immediately submit a second task — should fail with conflict
    let out2 = env.band(&[
        "chats",
        "send",
        "--workspace",
        "my-project-feat-conflict",
        "--message",
        "second task",
    ]);
    // Might succeed (if first finished fast) or fail with conflict
    // We just verify it doesn't crash and returns a reasonable response
    let _ = out2;
}

// --- Cronjobs tests ---

#[test]
fn cronjobs_list_empty() {
    let env = TestEnv::new();
    let output = env.band(&["cronjobs", "list"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    // No cronjobs yet — should have empty output
}

#[test]
fn cronjobs_list_json_empty() {
    let env = TestEnv::new();
    let output = env.band(&["cronjobs", "list", "--output", "json"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    let jobs = json["jobs"].as_array().expect("jobs array");
    assert!(jobs.is_empty(), "expected no cronjobs: {json}");
}

#[test]
fn cronjobs_create_and_list() {
    let env = TestEnv::new();

    let output = env.band(&[
        "cronjobs",
        "create",
        "my-project",
        "--name",
        "Daily check",
        "--prompt",
        "Check for issues",
        "--cron",
        "0 9 * * *",
        "--output",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    let job_id = json["job"]["id"].as_str().unwrap();
    assert!(job_id.starts_with("cj_"), "expected cj_ prefix: {job_id}");
    assert_eq!(json["job"]["name"], "Daily check");
    assert_eq!(json["job"]["scope"], "project");

    // Verify it shows in list
    let list_output = env.band(&["cronjobs", "list", "--output", "json"]);
    assert!(list_output.status.success());
    let list_json: serde_json::Value = serde_json::from_str(&stdout(&list_output)).unwrap();
    let jobs = list_json["jobs"].as_array().expect("jobs array");
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["id"], job_id);
}

#[test]
fn cronjobs_create_text_output() {
    let env = TestEnv::new();
    let output = env.band(&[
        "cronjobs",
        "create",
        "my-project",
        "--name",
        "Test job",
        "--prompt",
        "Do something",
        "--cron",
        "0 * * * *",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let out = stdout(&output);
    assert!(
        out.starts_with("cj_"),
        "expected cj_ ID in text output: {out}"
    );
}

#[test]
fn cronjobs_create_invalid_cron_fails() {
    let env = TestEnv::new();
    let output = env.band(&[
        "cronjobs",
        "create",
        "my-project",
        "--name",
        "Bad cron",
        "--prompt",
        "something",
        "--cron",
        "not valid",
    ]);
    assert!(!output.status.success());
}

#[test]
fn cronjobs_update_modifies_job() {
    let env = TestEnv::new();

    // Create a job first
    let create_output = env.band(&[
        "cronjobs",
        "create",
        "my-project",
        "--name",
        "Original",
        "--prompt",
        "original prompt",
        "--cron",
        "0 9 * * *",
        "--output",
        "json",
    ]);
    assert!(create_output.status.success());
    let create_json: serde_json::Value = serde_json::from_str(&stdout(&create_output)).unwrap();
    let job_id = create_json["job"]["id"].as_str().unwrap();

    // Update the name
    let output = env.band(&[
        "cronjobs",
        "update",
        "my-project",
        job_id,
        "--name",
        "Updated",
        "--output",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let json: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(json["job"]["name"], "Updated");
}

#[test]
fn cronjobs_update_enable_disable() {
    let env = TestEnv::new();

    let create_output = env.band(&[
        "cronjobs",
        "create",
        "my-project",
        "--name",
        "Toggle test",
        "--prompt",
        "test",
        "--cron",
        "0 * * * *",
        "--output",
        "json",
    ]);
    assert!(create_output.status.success());
    let create_json: serde_json::Value = serde_json::from_str(&stdout(&create_output)).unwrap();
    let job_id = create_json["job"]["id"].as_str().unwrap();

    // Disable
    let output = env.band(&[
        "cronjobs",
        "update",
        "my-project",
        job_id,
        "--disable",
        "--output",
        "json",
    ]);
    assert!(output.status.success());
    let json: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(json["job"]["enabled"], false);

    // Enable
    let output = env.band(&[
        "cronjobs",
        "update",
        "my-project",
        job_id,
        "--enable",
        "--output",
        "json",
    ]);
    assert!(output.status.success());
    let json: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(json["job"]["enabled"], true);
}

#[test]
fn cronjobs_delete_removes_job() {
    let env = TestEnv::new();

    let create_output = env.band(&[
        "cronjobs",
        "create",
        "my-project",
        "--name",
        "Delete me",
        "--prompt",
        "test",
        "--cron",
        "0 * * * *",
        "--output",
        "json",
    ]);
    assert!(create_output.status.success());
    let create_json: serde_json::Value = serde_json::from_str(&stdout(&create_output)).unwrap();
    let job_id = create_json["job"]["id"].as_str().unwrap();

    let output = env.band(&["cronjobs", "delete", "my-project", job_id]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    // Verify it's gone
    let list_output = env.band(&["cronjobs", "list", "--output", "json"]);
    let list_json: serde_json::Value = serde_json::from_str(&stdout(&list_output)).unwrap();
    let jobs = list_json["jobs"].as_array().expect("jobs array");
    assert!(
        jobs.is_empty(),
        "expected no cronjobs after delete: {list_json}"
    );
}

#[test]
fn cronjobs_delete_nonexistent_fails() {
    let env = TestEnv::new();
    let output = env.band(&["cronjobs", "delete", "my-project", "cj_nonexistent"]);
    assert!(!output.status.success());
}

#[test]
fn cronjobs_list_filter_by_project() {
    let env = TestEnv::new();

    env.band(&[
        "cronjobs",
        "create",
        "my-project",
        "--name",
        "Proj job",
        "--prompt",
        "test",
        "--cron",
        "0 * * * *",
    ]);

    let output = env.band(&[
        "cronjobs",
        "list",
        "--project",
        "my-project",
        "--output",
        "json",
    ]);
    assert!(output.status.success());
    let json: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    let jobs = json["jobs"].as_array().expect("jobs array");
    assert_eq!(jobs.len(), 1);

    // Filter by nonexistent project — should be empty
    let output = env.band(&[
        "cronjobs",
        "list",
        "--project",
        "nonexistent",
        "--output",
        "json",
    ]);
    assert!(output.status.success());
    let json: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    let jobs = json["jobs"].as_array().expect("jobs array");
    assert!(jobs.is_empty());
}

#[test]
fn cronjobs_list_text_output_shows_table() {
    let env = TestEnv::new();

    env.band(&[
        "cronjobs",
        "create",
        "my-project",
        "--name",
        "My Job",
        "--prompt",
        "do stuff",
        "--cron",
        "0 9 * * 1",
    ]);

    let output = env.band(&["cronjobs", "list"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let out = stdout(&output);
    assert!(out.contains("cj_"), "expected cj_ ID: {out}");
    assert!(out.contains("My Job"), "expected job name: {out}");
    assert!(out.contains("0 9 * * 1"), "expected cron expr: {out}");
}

// --- Layout persistence parity tests ---
//
// Every CLI-driven creation of a chat / terminal / browser must persist
// the new pane to the workspace's saved dockview layout, not just the
// in-memory registry. Otherwise the dashboard renders nothing for that
// pane until the user manually re-creates it via the UI. These tests
// pin the contract at the CLI boundary so future refactors of the
// underlying `createChat` / `createBrowser` / `spawnTerminal` helpers
// can't silently regress it.

/// Regression: `band terminals create` must add the new terminal to the
/// workspace's saved `terminal_layout`. Before the fix, only
/// `terminals.create` (the tRPC mutation) added it; any other path that
/// called `spawnTerminal` directly (e.g. the WebSocket handler in
/// `terminal-ws.ts`) skipped the layout. Moving `addTerminalToLayout`
/// into `spawnTerminal` makes it a single source of truth.
#[test]
fn terminals_create_adds_terminal_to_layout() {
    let env = TestEnv::new();
    env.band(&["workspaces", "create", "my-project", "feat/term-layout"]);
    let workspace_id = "my-project-feat-term-layout";

    let out = env.band(&["terminals", "create", workspace_id, "--output", "json"]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    let json: serde_json::Value = serde_json::from_str(&stdout(&out)).unwrap();
    let terminal_id = json["terminalId"].as_str().expect("terminalId in response");

    let layout = read_layout(&env.band_dir, workspace_id, "terminal_layout");
    assert!(
        !layout.is_null(),
        "expected a terminal_layout row to be persisted, got null"
    );
    let panels = layout
        .get("panels")
        .and_then(|p| p.as_object())
        .unwrap_or_else(|| panic!("expected layout.panels object: {layout}"));
    assert!(
        panels.contains_key(terminal_id),
        "expected terminal {terminal_id} in layout panels, got {panels:?}"
    );
}

/// Regression: same shape as `terminals_create_adds_terminal_to_layout`,
/// but for browsers. Before the fix, `addBrowserToLayout` was only called
/// from the `browsers.create` mutation; future callers of `createBrowser`
/// would skip the layout. Moving the call into `createBrowser` itself
/// closes that hole.
#[test]
fn browsers_create_adds_browser_to_layout() {
    let env = TestEnv::new();
    env.band(&["workspaces", "create", "my-project", "feat/browser-layout"]);
    let workspace_id = "my-project-feat-browser-layout";

    let out = env.band(&[
        "browsers",
        "create",
        workspace_id,
        "--url",
        "https://example.com",
        "--output",
        "json",
    ]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));
    let json: serde_json::Value = serde_json::from_str(&stdout(&out)).unwrap();
    let browser_id = json["browser"]["id"]
        .as_str()
        .expect("browser.id in response");

    let layout = read_layout(&env.band_dir, workspace_id, "browser_layout");
    assert!(
        !layout.is_null(),
        "expected a browser_layout row to be persisted, got null"
    );
    let panels = layout
        .get("panels")
        .and_then(|p| p.as_object())
        .unwrap_or_else(|| panic!("expected layout.panels object: {layout}"));
    assert!(
        panels.contains_key(browser_id),
        "expected browser {browser_id} in layout panels, got {panels:?}"
    );
    // The initial URL flows through `createBrowser` -> `addBrowserToLayout`.
    let panel = panels.get(browser_id).unwrap();
    let initial_url = panel
        .pointer("/params/initialUrl")
        .and_then(serde_json::Value::as_str);
    assert_eq!(
        initial_url,
        Some("https://example.com"),
        "expected initialUrl to be persisted in panel params: {panel}"
    );
}

/// Regression: `band workspaces create --prompt ...` followed by
/// `band workspaces remove` must wipe every `panel_states` row tied
/// to that workspace. The lazy-create path in `workspaces.create`
/// goes through a different code path than `chats.create` (it calls
/// `getOrCreateDefaultChat` server-side rather than the explicit CLI
/// mutation), so it's worth a dedicated test to make sure both paths
/// teardown cleanly.
#[test]
fn workspaces_create_with_prompt_then_remove_clears_panel_states() {
    let env = TestEnv::new();
    let create = env.band(&[
        "workspaces",
        "create",
        "my-project",
        "feat/prompt-teardown",
        "--prompt",
        "say hi",
    ]);
    assert!(create.status.success(), "stderr: {}", stderr(&create));
    let workspace_id = "my-project-feat-prompt-teardown";

    let before = list_panel_states(&env.band_dir, workspace_id);
    assert!(
        !before.is_empty(),
        "pre-condition: lazy-created chat + layout should be present: {before:?}"
    );

    let out = env.band(&["workspaces", "remove", "my-project", "feat/prompt-teardown"]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));

    let after = list_panel_states(&env.band_dir, workspace_id);
    assert!(
        after.is_empty(),
        "expected panel_states empty after `workspaces remove`, got {after:?}"
    );
}

/// Regression: `band workspaces remove` must wipe every `panel_states`
/// row associated with the workspace — chat records, browser records,
/// and the three layout rows (`chat_layout_<id>`, `terminal_layout_<id>`,
/// `browser_layout_<id>`). A leak means stale state survives across
/// recreations of a workspace with the same name.
#[test]
fn workspaces_remove_clears_all_panel_states() {
    let env = TestEnv::new();
    env.band(&["workspaces", "create", "my-project", "feat/teardown"]);
    let workspace_id = "my-project-feat-teardown";

    // Seed the workspace with one of each pane type so all relevant
    // panel_states rows exist.
    env.band(&["chats", "create", workspace_id, "--name", "Side"]);
    env.band(&[
        "browsers",
        "create",
        workspace_id,
        "--url",
        "https://example.com",
    ]);
    env.band(&["terminals", "create", workspace_id]);

    // Pre-condition: panel_states has multiple rows for this workspace
    // (1 chat record, 1 browser record, 3 layout rows — chat/terminal/browser).
    let before = list_panel_states(&env.band_dir, workspace_id);
    assert!(
        before.len() >= 5,
        "pre-condition: expected at least 5 panel_states rows (chat, browser, 3 layouts), got: {before:?}"
    );

    // Tear down the workspace.
    let out = env.band(&["workspaces", "remove", "my-project", "feat/teardown"]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));

    // Every row keyed to this workspace should be gone — no chat records,
    // no browser records, no chat_layout / terminal_layout / browser_layout.
    let after = list_panel_states(&env.band_dir, workspace_id);
    assert!(
        after.is_empty(),
        "expected panel_states to be empty after `workspaces remove`, got {after:?}"
    );
}

/// Regression: `band chats remove` must not only delete the chat record
/// but also strip the panel from the saved `chat_layout` row. Mirrors
/// what `terminal.kill` and `browsers.remove` do for their respective
/// layouts. Without this, an open dashboard would show a ghost tab for
/// a chat whose record is gone — and the dashboard's orphan-pruning
/// pass on next mount would have to clean it up.
#[test]
fn chats_remove_strips_chat_from_layout() {
    let env = TestEnv::new();
    env.band(&[
        "workspaces",
        "create",
        "my-project",
        "feat/chat-remove-layout",
    ]);
    let workspace_id = "my-project-feat-chat-remove-layout";

    // `workspaces create` lazily creates a default chat. Add a second so
    // we can assert the *target* chat is removed without affecting the
    // other.
    let second = env.band(&[
        "chats",
        "create",
        workspace_id,
        "--name",
        "Second",
        "--output",
        "json",
    ]);
    assert!(second.status.success(), "stderr: {}", stderr(&second));
    let second_id = serde_json::from_str::<serde_json::Value>(&stdout(&second)).unwrap()["chat"]
        ["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Snapshot pre-state: layout contains both chats.
    let before = read_layout(&env.band_dir, workspace_id, "chat_layout");
    let before_panels = before.get("panels").and_then(|p| p.as_object()).unwrap();
    assert!(
        before_panels.contains_key(&second_id),
        "pre-condition: second chat should be in layout: {before}"
    );
    assert_eq!(before_panels.len(), 2, "pre-condition: 2 panels in layout");

    // Remove the second chat via the CLI.
    let remove = env.band(&["chats", "remove", &second_id]);
    assert!(remove.status.success(), "stderr: {}", stderr(&remove));

    // Layout no longer references the removed chat, but the other panel
    // is preserved.
    let after = read_layout(&env.band_dir, workspace_id, "chat_layout");
    let after_panels = after
        .get("panels")
        .and_then(|p| p.as_object())
        .unwrap_or_else(|| panic!("expected layout.panels object after remove: {after}"));
    assert!(
        !after_panels.contains_key(&second_id),
        "expected removed chat {second_id} to be stripped from layout, got {after_panels:?}"
    );
    assert_eq!(
        after_panels.len(),
        1,
        "expected exactly one remaining chat panel: {after}"
    );

    // And `chats list` agrees — the removed chat is gone from the registry too.
    let list = env.band(&["chats", "list", workspace_id, "--output", "json"]);
    let list_json: serde_json::Value = serde_json::from_str(&stdout(&list)).unwrap();
    let chats = list_json["chats"].as_array().unwrap();
    assert_eq!(
        chats.len(),
        1,
        "expected exactly one chat remaining in registry: {list_json}"
    );
    assert_ne!(
        chats[0]["id"].as_str().unwrap(),
        second_id,
        "the surviving chat shouldn't be the one we removed"
    );
}

// --- Chat command / default-panel resolution tests ---

/// Regression: `band workspaces create --prompt ...` lazily creates a default
/// chat pane and submits the prompt to it, but the chat record has to land
/// in the saved `chat_layout` so the dashboard renders the tab when the user
/// opens the workspace. Before the fix, only the chats registry was updated,
/// not the layout — so the chat existed but was invisible in the dashboard.
#[test]
fn workspaces_create_prompt_adds_chat_to_layout() {
    let env = TestEnv::new();
    let out = env.band(&[
        "workspaces",
        "create",
        "my-project",
        "feat/prompt-layout",
        "--prompt",
        "say hi",
        "--output",
        "json",
    ]);
    assert!(out.status.success(), "stderr: {}", stderr(&out));

    let workspace_id = "my-project-feat-prompt-layout";

    // The chat exists in the registry.
    let list = env.band(&["chats", "list", workspace_id, "--output", "json"]);
    assert!(list.status.success(), "stderr: {}", stderr(&list));
    let list_json: serde_json::Value = serde_json::from_str(&stdout(&list)).unwrap();
    let chats = list_json["chats"].as_array().expect("chats array");
    assert_eq!(
        chats.len(),
        1,
        "expected exactly one chat after `workspaces create --prompt`: {list_json}"
    );
    let chat_id = chats[0]["id"].as_str().unwrap();

    // ...AND it shows up in the persisted dockview chat layout. Asserting on
    // the layout shape directly (rather than via the dashboard) is the only
    // way to catch the invisible-chat bug at the CLI layer.
    let layout = read_layout(&env.band_dir, workspace_id, "chat_layout");
    assert!(
        !layout.is_null(),
        "expected a chat_layout row to be persisted, got null"
    );
    let panels = layout
        .get("panels")
        .and_then(|p| p.as_object())
        .unwrap_or_else(|| panic!("expected layout.panels object: {layout}"));
    assert!(
        panels.contains_key(chat_id),
        "expected chat {chat_id} in layout panels, got {panels:?}"
    );

    // The grid root MUST be a `branch` — that's the shape dockview's
    // `toJSON()` produces and the only shape `fromJSON()` round-trips
    // cleanly. Earlier the helper produced a bare `leaf` as root with
    // `size: 1`, which dockview's `fromJSON` rejected. The catch in
    // `DockviewChatContainer.onReady` then fell back to
    // `createDefaultPanel`, minted a brand-new chat ID with
    // `newChatId()`, and the server-created lazy-default chat (the one
    // running the user's --prompt task) was orphaned out of the layout
    // — so opening the workspace showed an *empty* tab with a freshly-
    // generated chat ID instead of the prompt the user just submitted.
    //
    // Pin the dockview-native shape: `grid.root.type === "branch"` with
    // a child leaf containing the chat.
    let root_type = layout
        .pointer("/grid/root/type")
        .and_then(serde_json::Value::as_str);
    assert_eq!(
        root_type,
        Some("branch"),
        "expected grid.root.type=='branch' (dockview-native), got: {layout}"
    );
    let leaves = layout
        .pointer("/grid/root/data")
        .and_then(serde_json::Value::as_array)
        .unwrap_or_else(|| panic!("expected grid.root.data array: {layout}"));
    assert!(
        leaves.iter().any(|node| {
            node.pointer("/data/views")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|views| views.iter().any(|v| v.as_str() == Some(chat_id)))
        }),
        "expected branch.data leaves to contain chat {chat_id}, got {leaves:?}"
    );
}

#[test]
fn chat_creates_default_panel_when_workspace_has_no_chats() {
    let env = TestEnv::new();
    let create = env.band(&["workspaces", "create", "my-project", "feat/chat-empty"]);
    assert!(create.status.success(), "stderr: {}", stderr(&create));

    // No chats yet — `band chats send` should lazily create one and target it.
    let output = env.band(&[
        "chats",
        "send",
        "--workspace",
        "my-project-feat-chat-empty",
        "--message",
        "first message",
        "--output",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    let resolved_chat = json["chatId"].as_str().unwrap_or("");
    assert!(
        resolved_chat.starts_with("chat_"),
        "expected a chat id to be resolved: {json}"
    );

    // The chat now exists in the workspace's chat list.
    let list = env.band(&[
        "chats",
        "list",
        "my-project-feat-chat-empty",
        "--output",
        "json",
    ]);
    assert!(list.status.success(), "stderr: {}", stderr(&list));
    let list_json: serde_json::Value = serde_json::from_str(&stdout(&list)).unwrap();
    let chats = list_json["chats"].as_array().expect("chats array");
    assert!(
        chats.iter().any(|c| c["id"] == resolved_chat),
        "expected resolved chat in workspace list: {list_json}"
    );
}

#[test]
fn chat_targets_most_recently_added_chat_by_default() {
    // Every chat created (lazy-default in `workspaces create`, explicit
    // `chats create`, or via `tasks.submit` lazy-create) now also lands
    // in the saved chat_layout, with the new pane marked as the active
    // view of its group. So `chats send` without an explicit chat_id
    // resolves through `defaultPanelIdFromLayout` -> active panel ->
    // most recently added chat.
    let env = TestEnv::new();
    env.band(&["workspaces", "create", "my-project", "feat/chat-default"]);
    let workspace_id = "my-project-feat-chat-default";

    // `workspaces create` lazily creates the first chat panel and
    // inserts it into the layout (active). Add a second pane on top.
    let second = env.band(&[
        "chats",
        "create",
        workspace_id,
        "--name",
        "Second",
        "--output",
        "json",
    ]);
    assert!(second.status.success(), "stderr: {}", stderr(&second));
    let second_id = serde_json::from_str::<serde_json::Value>(&stdout(&second)).unwrap()["chat"]
        ["id"]
        .as_str()
        .unwrap()
        .to_string();

    // Sanity-check that there really are two chats.
    let list = env.band(&["chats", "list", workspace_id, "--output", "json"]);
    let list_json: serde_json::Value = serde_json::from_str(&stdout(&list)).unwrap();
    let chats = list_json["chats"].as_array().expect("chats array");
    assert!(chats.len() >= 2, "expected at least 2 chats: {list_json}");

    // `chats send` (no chat_id) should target the most recently added
    // chat — i.e. the one we just created — not the lazy-default first.
    let output = env.band(&[
        "chats",
        "send",
        "--workspace",
        workspace_id,
        "--message",
        "hello",
        "--output",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(
        json["chatId"].as_str().unwrap(),
        second_id,
        "expected most recently added chat to be the default: {json}"
    );
}

#[test]
fn chat_targets_active_panel_from_layout() {
    let env = TestEnv::new();
    env.band(&["workspaces", "create", "my-project", "feat/chat-layout"]);
    let workspace_id = "my-project-feat-chat-layout";

    // Add a second pane on top of the auto-created default. We'll mark
    // this one as active in the layout below.
    let second = env.band(&[
        "chats",
        "create",
        workspace_id,
        "--name",
        "Active",
        "--output",
        "json",
    ]);
    assert!(second.status.success(), "stderr: {}", stderr(&second));
    let second_json: serde_json::Value = serde_json::from_str(&stdout(&second)).unwrap();
    let second_id = second_json["chat"]["id"].as_str().unwrap().to_string();

    // Snapshot the registry-order first chat so the assertion below is
    // sharp: we want to verify the resolution differs from "first chat".
    let list = env.band(&["chats", "list", workspace_id, "--output", "json"]);
    let list_json: serde_json::Value = serde_json::from_str(&stdout(&list)).unwrap();
    let first_id = list_json["chats"][0]["id"].as_str().unwrap().to_string();
    assert_ne!(first_id, second_id, "list should have at least 2 chats");

    // Persist a chat layout that marks `second_id` as the active view of
    // the active group — mimicking the user clicking that tab in the
    // dashboard. The layout shape mirrors what
    // DockviewLayoutManager.addPanel writes.
    let group_id = format!("group_{second_id}");
    let layout = serde_json::json!({
        "grid": {
            "root": {
                "type": "leaf",
                "data": {
                    "id": group_id,
                    "views": [first_id.clone(), second_id.clone()],
                    "activeView": second_id.clone(),
                },
                "size": 1,
            },
            "height": 500,
            "width": 500,
            "orientation": "HORIZONTAL",
        },
        "panels": {
            first_id.clone(): {
                "id": first_id,
                "contentComponent": "chatTab",
                "tabComponent": "chatTab",
                "title": "First",
                "params": {"workspaceId": workspace_id, "chatId": first_id.clone()},
            },
            second_id.clone(): {
                "id": second_id,
                "contentComponent": "chatTab",
                "tabComponent": "chatTab",
                "title": "Active",
                "params": {"workspaceId": workspace_id, "chatId": second_id.clone()},
            },
        },
        "activeGroup": group_id,
    });
    seed_chat_layout(&env.band_dir, workspace_id, &layout);

    // `band chats send` without an explicit chat_id should target the
    // active panel from the saved layout — not the first chat in
    // insertion order.
    let output = env.band(&[
        "chats",
        "send",
        "--workspace",
        workspace_id,
        "--message",
        "to active panel",
        "--output",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(
        json["chatId"].as_str().unwrap(),
        second_id,
        "expected layout's active panel to be the default: {json}"
    );
}

#[test]
fn chat_explicit_chat_id_overrides_default() {
    let env = TestEnv::new();
    env.band(&["workspaces", "create", "my-project", "feat/chat-explicit"]);
    let workspace_id = "my-project-feat-chat-explicit";

    env.band(&["chats", "create", workspace_id, "--name", "First"]);
    let second = env.band(&[
        "chats",
        "create",
        workspace_id,
        "--name",
        "Second",
        "--output",
        "json",
    ]);
    let second_json: serde_json::Value = serde_json::from_str(&stdout(&second)).unwrap();
    let second_id = second_json["chat"]["id"].as_str().unwrap().to_string();

    let output = env.band(&[
        "chats",
        "send",
        &second_id,
        "--workspace",
        workspace_id,
        "--message",
        "directly",
        "--output",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(
        json["chatId"].as_str().unwrap(),
        second_id,
        "expected --chat-id to win over default resolution: {json}"
    );
}

#[test]
fn chat_auto_detects_workspace_from_cwd() {
    let env = TestEnv::new();

    let create_out = env.band(&["workspaces", "create", "my-project", "feat/chat-cwd"]);
    assert!(
        create_out.status.success(),
        "stderr: {}",
        stderr(&create_out)
    );
    let worktree_path = stdout(&create_out);

    // Run `band chats send` with NO workspace from inside the worktree.
    let output = env.band_in(
        Path::new(&worktree_path),
        &[
            "chats",
            "send",
            "--message",
            "auto-detect",
            "--output",
            "json",
        ],
    );
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let json: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    assert_eq!(
        json["workspaceId"].as_str().unwrap(),
        "my-project-feat-chat-cwd",
        "expected workspace to be auto-detected from cwd: {json}"
    );
}

#[test]
fn chat_outside_workspace_fails_with_helpful_error() {
    let env = TestEnv::new();

    // A git repo that is NOT a registered workspace.
    let unrelated = env.tmp.path().join("chat-unrelated");
    fs::create_dir_all(&unrelated).unwrap();
    git(&unrelated, &["init", "-b", "main"]);
    git(&unrelated, &["commit", "--allow-empty", "-m", "init"]);

    let output = env.band_in(&unrelated, &["chats", "send", "--message", "hello"]);

    assert!(
        !output.status.success(),
        "expected failure when not in a registered workspace"
    );
    let err = stderr(&output);
    assert!(
        err.contains("No workspace found"),
        "expected helpful error: {err}"
    );
}

// --- Schema tests ---

#[test]
fn schema_lists_all_commands() {
    let env = TestEnv::new();
    let output = env.band(&["schema"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    let commands = json["commands"].as_array().expect("commands array");
    let names: Vec<&str> = commands
        .iter()
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"projects list"), "missing: {names:?}");
    assert!(names.contains(&"projects add"), "missing: {names:?}");
    assert!(names.contains(&"projects remove"), "missing: {names:?}");
    assert!(names.contains(&"workspaces list"), "missing: {names:?}");
    assert!(names.contains(&"workspaces create"), "missing: {names:?}");
    assert!(names.contains(&"workspaces remove"), "missing: {names:?}");
    assert!(names.contains(&"settings"), "missing: {names:?}");
    // The `tasks` subcommand was fully removed — agent task submission
    // happens via the top-level `chat` command, and lifecycle management
    // moved server-side.
    for removed in [
        "tasks list",
        "tasks create",
        "tasks cancel",
        "tasks rerun",
        "tasks watch",
    ] {
        assert!(
            !names.contains(&removed),
            "expected `{removed}` to be removed: {names:?}"
        );
    }
    // The chat surface lives entirely under `chats *`. The top-level
    // singular `chat` and the redundant `chats chat` are both gone —
    // message submission goes through `chats send` (which calls
    // `tasks.submit` server-side with full agent-config flags).
    for removed in ["chat", "chats chat"] {
        assert!(
            !names.contains(&removed),
            "expected `{removed}` to be removed (now `chats send`): {names:?}"
        );
    }
    assert!(names.contains(&"chats send"), "missing: {names:?}");
    assert!(names.contains(&"chats list"), "missing: {names:?}");
    assert!(names.contains(&"chats watch"), "missing: {names:?}");
    assert!(names.contains(&"chats stop"), "missing: {names:?}");
    assert!(names.contains(&"tunnel status"), "missing: {names:?}");
    assert!(names.contains(&"tunnel start"), "missing: {names:?}");
    assert!(names.contains(&"tunnel stop"), "missing: {names:?}");
    assert!(names.contains(&"cronjobs list"), "missing: {names:?}");
    assert!(names.contains(&"cronjobs create"), "missing: {names:?}");
    assert!(names.contains(&"cronjobs update"), "missing: {names:?}");
    assert!(names.contains(&"cronjobs delete"), "missing: {names:?}");
    assert!(names.contains(&"cronjobs trigger"), "missing: {names:?}");
    assert!(names.contains(&"notify"), "missing: {names:?}");
    assert!(names.contains(&"schema"), "missing: {names:?}");
}

#[test]
fn schema_shows_single_command() {
    let env = TestEnv::new();
    let output = env.band(&["schema", "workspaces create"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    assert_eq!(json["name"], "workspaces create");
    let params = json["parameters"].as_array().expect("parameters array");
    assert!(
        params.iter().any(|p| p["name"] == "project"),
        "json: {json}"
    );
    assert!(params.iter().any(|p| p["name"] == "branch"), "json: {json}");
}

#[test]
fn schema_unknown_command_fails() {
    let env = TestEnv::new();
    let output = env.band(&["schema", "nonexistent"]);

    assert!(!output.status.success());
    let json: serde_json::Value = serde_json::from_str(&stderr(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstderr: {}", stderr(&output)));
    assert!(
        json["error"].as_str().unwrap().contains("Unknown command"),
        "json: {json}"
    );
}

// --- chats watch tests (mock SSE server) ---
//
// `band chats watch` streams `GET /api/tasks/<chat_id>/stream`. To exercise
// the SSE-decoding path without standing up a full agent run we use a
// lightweight mock HTTP server that returns a canned response on the first
// connection. These tests cover (1) the happy path where each `data:`
// payload is dumped as one NDJSON line, (2) the 204 "no running task" path,
// and (3) the URL-encoding of the chat_id path segment.

/// Mock HTTP/SSE server that serves one canned response then closes.
struct MockHttpServer {
    port: u16,
    /// Captured request path (set after the first connection completes).
    request_path: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    _handle: std::thread::JoinHandle<()>,
}

impl MockHttpServer {
    fn new(response: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let request_path = std::sync::Arc::new(std::sync::Mutex::new(None));
        let path_for_thread = std::sync::Arc::clone(&request_path);

        let handle = std::thread::spawn(move || {
            use std::io::Write;
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            // Parse request line: "METHOD PATH HTTP/1.1"
            let req = String::from_utf8_lossy(&buf[..n]);
            if let Some(line) = req.lines().next() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 {
                    *path_for_thread.lock().unwrap() = Some(parts[1].to_string());
                }
            }
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        });

        Self {
            port,
            request_path,
            _handle: handle,
        }
    }

    /// Wait briefly for the request to land, then return the captured path.
    fn captured_path(&self) -> Option<String> {
        for _ in 0..50 {
            if let Some(p) = self.request_path.lock().unwrap().clone() {
                return Some(p);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }
}

/// Run the `band` binary against a mock HTTP server.
fn band_against_mock(
    tmp: &tempfile::TempDir,
    mock: &MockHttpServer,
    args: &[&str],
) -> std::process::Output {
    let band_dir = tmp.path().join(".band");
    fs::create_dir_all(&band_dir).ok();
    seed_settings_only(&band_dir, &serde_json::json!({"tokenSecret": "mock-token"}));

    Command::new(env!("CARGO_BIN_EXE_band"))
        .args(args)
        .env("BAND_HOME", &band_dir)
        .env("BAND_SERVER_URL", format!("http://127.0.0.1:{}", mock.port))
        .output()
        .expect("failed to execute band")
}

#[test]
fn chats_watch_dumps_each_sse_event_as_ndjson_line() {
    use std::fmt::Write as _;

    let chunks = [
        serde_json::json!({"type": "text-delta", "delta": "Hello "}),
        serde_json::json!({"type": "text-delta", "delta": "world!"}),
        serde_json::json!({"type": "finish"}),
    ];
    let mut sse_body = String::new();
    for c in &chunks {
        write!(sse_body, "data: {}\n\n", serde_json::to_string(c).unwrap()).unwrap();
    }
    let response = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/event-stream\r\n\
         Connection: close\r\n\
         \r\n\
         {sse_body}"
    );

    let mock = MockHttpServer::new(response);
    let tmp = tempfile::tempdir().unwrap();
    let out = band_against_mock(&tmp, &mock, &["chats", "watch", "chat_abc"]);

    assert!(out.status.success(), "stderr: {}", stderr(&out));
    let stdout_str = stdout(&out);

    // Each SSE event becomes exactly one NDJSON line on stdout.
    let lines: Vec<&str> = stdout_str.lines().collect();
    assert_eq!(
        lines.len(),
        chunks.len(),
        "expected {} lines, got {}: {stdout_str}",
        chunks.len(),
        lines.len()
    );
    for (i, line) in lines.iter().enumerate() {
        let parsed: serde_json::Value = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("line {i} is not JSON: {e}\nline: {line}"));
        assert_eq!(parsed, chunks[i], "line {i}: {line}");
    }
}

#[test]
fn chats_watch_no_running_task_exits_zero_with_empty_stdout() {
    // Server returns 204 No Content when there's no active task.
    let response = "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_string();
    let mock = MockHttpServer::new(response);
    let tmp = tempfile::tempdir().unwrap();
    let out = band_against_mock(&tmp, &mock, &["chats", "watch", "chat_idle"]);

    assert!(out.status.success(), "stderr: {}", stderr(&out));
    assert_eq!(stdout(&out), "", "expected empty stdout for 204");
}

#[test]
fn chats_watch_url_encodes_chat_id_path_segment() {
    // A hostile chat_id with a `/` must be percent-encoded so it can't
    // smuggle path components into the request URL.
    let response = "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_string();
    let mock = MockHttpServer::new(response);
    let tmp = tempfile::tempdir().unwrap();
    let _ = band_against_mock(&tmp, &mock, &["chats", "watch", "evil/../escape"]);

    let path = mock.captured_path().expect("mock did not capture a path");
    assert!(
        path.starts_with("/api/tasks/"),
        "expected /api/tasks/ prefix: {path}"
    );
    assert!(
        !path.contains("/../"),
        "chat_id slashes should be encoded, got: {path}"
    );
    assert!(
        path.contains("evil%2F..%2Fescape"),
        "expected percent-encoded chat_id segment: {path}"
    );
}

// --- generate-skills tests ---

/// Run the `band` binary with no `BAND_HOME` and no server. Used by tests for
/// pure commands (like `generate-skills` and `schema`) that don't talk to the
/// web server.
fn band_offline(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_band"))
        .args(args)
        .output()
        .expect("failed to execute band")
}

/// Read the generated SKILL.md for a given skill name from the output dir.
fn read_skill(output_dir: &Path, name: &str) -> String {
    let path = output_dir.join(name).join("SKILL.md");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()))
}

/// Extract the auto-generated `## Commands` section from a SKILL.md.
///
/// The generator replaces the `<!-- COMMANDS -->` placeholder with a block
/// that starts with `## Commands` and ends at the next top-level `## ` heading
/// in the template (e.g. `## Workflows`). Tests use this to assert each
/// domain's skill ships only its own schema-derived commands while still
/// allowing cross-reference prose to mention sibling skills' commands.
fn commands_section(skill: &str) -> &str {
    let start = skill
        .find("## Commands")
        .unwrap_or_else(|| panic!("SKILL.md has no `## Commands` section"));
    let rest = &skill[start..];
    // Skip the heading itself when searching for the next `## ` heading.
    let after_heading = &rest["## Commands".len()..];
    let end_offset = after_heading
        .find("\n## ")
        .map_or(rest.len(), |i| "## Commands".len() + i + 1);
    &rest[..end_offset]
}

/// Extract a single frontmatter field from a SKILL.md file's YAML header.
fn frontmatter_field<'a>(skill: &'a str, key: &'a str) -> Option<&'a str> {
    let mut lines = skill.lines();
    // First line must be the opening `---`.
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }
    for line in lines {
        if line.trim() == "---" {
            return None;
        }
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(value) = rest.strip_prefix(':') {
                return Some(value.trim());
            }
        }
    }
    None
}

#[test]
fn generate_skills_emits_all_domain_skills() {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let out = tmp.path();

    let output = band_offline(&["generate-skills", "--output-dir", out.to_str().unwrap()]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    for name in [
        "band",
        "band-chat",
        "band-terminal",
        "band-browser",
        "band-start",
        "band-loop",
    ] {
        let path = out.join(name).join("SKILL.md");
        assert!(
            path.exists(),
            "expected {} to exist; out={}",
            path.display(),
            stdout(&output)
        );
    }
}

#[test]
fn generate_skills_each_skill_has_non_empty_description() {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let out = tmp.path();
    let output = band_offline(&["generate-skills", "--output-dir", out.to_str().unwrap()]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    for name in [
        "band",
        "band-chat",
        "band-terminal",
        "band-browser",
        "band-start",
        "band-loop",
    ] {
        let skill = read_skill(out, name);
        let desc = frontmatter_field(&skill, "description")
            .unwrap_or_else(|| panic!("{name} has no description"));
        assert!(!desc.is_empty(), "{name} description must be non-empty");
        // The description must be specific enough to mention what triggers
        // the skill — sanity-check that each domain's description references
        // its own keyword and not the others'.
        let lower = desc.to_lowercase();
        match name {
            "band-chat" => {
                assert!(lower.contains("chat"), "{name}: {desc}");
                assert!(
                    !lower.contains("terminal") && !lower.contains("browser"),
                    "{name} description leaks other domains: {desc}"
                );
            }
            "band-terminal" => {
                assert!(lower.contains("terminal"), "{name}: {desc}");
                assert!(
                    !lower.contains(" chat ") && !lower.contains("browser"),
                    "{name} description leaks other domains: {desc}"
                );
            }
            "band-browser" => {
                assert!(lower.contains("browser"), "{name}: {desc}");
                assert!(
                    !lower.contains(" chat ") && !lower.contains("terminal"),
                    "{name} description leaks other domains: {desc}"
                );
            }
            "band-start" => {
                // band-start's trigger keywords cover kickoff/workspace creation.
                assert!(
                    lower.contains("workspace") || lower.contains("kick off"),
                    "{name}: {desc}"
                );
            }
            "band-loop" => {
                // band-loop's trigger keywords cover recurring scheduling.
                assert!(
                    lower.contains("recurring") || lower.contains("cronjob"),
                    "{name}: {desc}"
                );
            }
            _ => {}
        }
    }
}

#[test]
fn generate_skills_general_skill_excludes_domain_commands() {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let out = tmp.path();
    let output = band_offline(&["generate-skills", "--output-dir", out.to_str().unwrap()]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let band = read_skill(out, "band");
    let cmds = commands_section(&band);

    // Includes general commands.
    for needle in [
        "band projects list",
        "band workspaces create",
        "band workspaces remove",
        "band cronjobs create",
        "band tunnel start",
        "band settings",
        "band schema",
        "band generate-skills",
    ] {
        assert!(
            cmds.contains(needle),
            "general skill Commands section missing `{needle}`"
        );
    }

    // The Commands section must not document any domain commands — those
    // live in the sibling skills. Cross-reference prose elsewhere in the
    // skill is allowed and verified separately.
    //
    // The whole `band chats *` group belongs to band-chat. The `tasks`
    // subcommand was fully removed.
    assert!(
        !cmds.contains("\nband chats "),
        "general skill Commands section leaks `band chats` command"
    );
    assert!(
        !cmds.contains("\nband tasks "),
        "general skill Commands section leaks removed `band tasks` command"
    );
    for needle in [
        "band chats list",
        "band chats create",
        "band chats send",
        "band terminals list",
        "band terminals create",
        "band terminals send",
        "band browsers list",
        "band browsers create",
        "band browsers navigate",
    ] {
        assert!(
            !cmds.contains(needle),
            "general skill Commands section leaks domain command `{needle}`"
        );
    }
}

#[test]
fn generate_skills_chat_skill_contains_only_chat_commands() {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let out = tmp.path();
    let output = band_offline(&["generate-skills", "--output-dir", out.to_str().unwrap()]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let chat = read_skill(out, "band-chat");
    let cmds = commands_section(&chat);

    // The entire `band chats *` group lives here. `chats send` is the
    // message-sending entry point (replaces the old `chats chat`).
    for needle in [
        "band chats list",
        "band chats create",
        "band chats send",
        "band chats watch",
        "band chats stop",
        "band chats remove",
    ] {
        assert!(
            cmds.contains(needle),
            "band-chat Commands section missing `{needle}`"
        );
    }

    for needle in [
        "band terminals list",
        "band browsers list",
        "band workspaces list",
        "band projects list",
    ] {
        assert!(
            !cmds.contains(needle),
            "band-chat Commands section leaks foreign command `{needle}`"
        );
    }
}

#[test]
fn generate_skills_terminal_skill_contains_only_terminal_commands() {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let out = tmp.path();
    let output = band_offline(&["generate-skills", "--output-dir", out.to_str().unwrap()]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let term = read_skill(out, "band-terminal");
    let cmds = commands_section(&term);

    for needle in [
        "band terminals list",
        "band terminals create",
        "band terminals send",
        "band terminals output",
        "band terminals kill",
        "band terminals attach",
    ] {
        assert!(
            cmds.contains(needle),
            "band-terminal Commands section missing `{needle}`"
        );
    }

    for needle in [
        "band chats list",
        "band browsers list",
        "band workspaces list",
        "band projects list",
    ] {
        assert!(
            !cmds.contains(needle),
            "band-terminal Commands section leaks foreign command `{needle}`"
        );
    }
}

#[test]
fn generate_skills_browser_skill_contains_only_browser_commands() {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let out = tmp.path();
    let output = band_offline(&["generate-skills", "--output-dir", out.to_str().unwrap()]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let browser = read_skill(out, "band-browser");
    let cmds = commands_section(&browser);

    for needle in [
        "band browsers list",
        "band browsers create",
        "band browsers navigate",
        "band browsers get",
        "band browsers remove",
    ] {
        assert!(
            cmds.contains(needle),
            "band-browser Commands section missing `{needle}`"
        );
    }

    for needle in [
        "band chats list",
        "band terminals list",
        "band workspaces list",
        "band projects list",
    ] {
        assert!(
            !cmds.contains(needle),
            "band-browser Commands section leaks foreign command `{needle}`"
        );
    }
}

#[test]
fn generate_skills_filter_limits_to_one_skill() {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let out = tmp.path();
    let output = band_offline(&[
        "generate-skills",
        "--output-dir",
        out.to_str().unwrap(),
        "--filter",
        "chat",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    assert!(out.join("band-chat").join("SKILL.md").exists());
    assert!(!out.join("band").join("SKILL.md").exists());
    assert!(!out.join("band-terminal").join("SKILL.md").exists());
    assert!(!out.join("band-browser").join("SKILL.md").exists());
    assert!(!out.join("band-start").join("SKILL.md").exists());
    assert!(!out.join("band-loop").join("SKILL.md").exists());
}

#[test]
fn generate_skills_json_output_lists_generated_skills() {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let out = tmp.path();
    let output = band_offline(&[
        "generate-skills",
        "--output-dir",
        out.to_str().unwrap(),
        "--output",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    let skills = json["skills"].as_array().expect("skills array");
    let names: Vec<&str> = skills.iter().map(|s| s["name"].as_str().unwrap()).collect();

    // Reference-shaped skills must report at least one command. Workflow-
    // shaped skills (band-start, band-loop) are self-contained recipes that
    // omit the `commands:` frontmatter, so their commandCount is 0 by design.
    let workflow_skills: &[&str] = &["band-start", "band-loop"];

    assert_eq!(names.len(), 6, "expected 6 skills, got {names:?}");
    for expected in [
        "band",
        "band-chat",
        "band-terminal",
        "band-browser",
        "band-start",
        "band-loop",
    ] {
        assert!(names.contains(&expected), "missing skill: {expected}");
    }

    for skill in skills {
        let name = skill["name"].as_str().unwrap_or("?");
        let count = skill["commandCount"].as_u64().unwrap_or(0);
        if workflow_skills.contains(&name) {
            assert_eq!(count, 0, "workflow skill {name} unexpectedly has commands");
        } else {
            assert!(count > 0, "reference skill {name} has no commands");
        }
    }
}

// --- skills install tests ---

/// Set up a fresh sandbox HOME for `skills install` tests. Optionally
/// pre-creates the listed agent config dirs so detection picks them up.
fn skills_sandbox(agent_dirs: &[&str]) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().expect("create tempdir");
    let home = tmp.path();
    for rel in agent_dirs {
        fs::create_dir_all(home.join(rel)).expect("create agent config dir");
    }
    tmp
}

/// Run `band skills install --home <tmp>` with a clean environment (no
/// inherited `CODEX_HOME`) and parse its JSON output.
///
/// The CLI's `codex_home()` helper reads `$CODEX_HOME` at call time and
/// uses it instead of `home` when set. If a developer runs the test
/// suite from a shell that has `CODEX_HOME` exported (real install,
/// previous test session, accidental export), the subprocess would
/// pick it up and either:
///   - link skills into the developer's real `$CODEX_HOME/skills/`, or
///   - silently skip codex detection (if `$CODEX_HOME` points
///     somewhere that doesn't exist), making assertions like
///     `agents.len() == 2` flake on otherwise-correct code.
///
/// Stripping `CODEX_HOME` from the child's env at this seam isolates
/// every `run_install_json` caller without touching the developer's
/// actual shell. Tests that *want* to exercise the env override can use
/// `run_install_json_with_env` below.
fn run_install_json(home: &Path) -> serde_json::Value {
    let output = Command::new(env!("CARGO_BIN_EXE_band"))
        .env_remove("CODEX_HOME")
        .args([
            "--output",
            "json",
            "skills",
            "install",
            "--home",
            home.to_str().unwrap(),
        ])
        .output()
        .expect("failed to execute band");
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)))
}

#[test]
fn skills_install_writes_shared_skills_and_links_into_claude() {
    let tmp = skills_sandbox(&[".claude"]);
    let home = tmp.path();
    let result = run_install_json(home);

    // Shared SKILL.md files all created fresh.
    let written = result["shared"]["written"]
        .as_array()
        .expect("written array");
    assert_eq!(
        written.len(),
        6,
        "expected 6 shared writes, got {written:?}"
    );

    let shared_dir = home.join(".agents").join("skills");
    for name in [
        "band",
        "band-chat",
        "band-terminal",
        "band-browser",
        "band-start",
        "band-loop",
    ] {
        let shared = shared_dir.join(name).join("SKILL.md");
        assert!(
            shared.is_file(),
            "shared file missing: {}",
            shared.display()
        );

        let link = home.join(".claude").join("skills").join(name);
        let metadata = fs::symlink_metadata(&link)
            .unwrap_or_else(|e| panic!("symlink_metadata({}) failed: {e}", link.display()));
        assert!(
            metadata.file_type().is_symlink(),
            "{} is not a symlink",
            link.display()
        );
        // Symlink should resolve to the shared dir for this skill (via realpath).
        let resolved = fs::canonicalize(&link).expect("canonicalize link");
        let expected = fs::canonicalize(shared_dir.join(name)).expect("canonicalize shared dir");
        assert_eq!(
            resolved,
            expected,
            "link {} points elsewhere",
            link.display()
        );
    }
}

#[test]
fn skills_install_is_idempotent_on_second_run() {
    let tmp = skills_sandbox(&[".claude"]);
    let home = tmp.path();

    let first = run_install_json(home);
    assert_eq!(first["shared"]["written"].as_array().unwrap().len(), 6);
    assert_eq!(
        first["symlinks"]["linked"].as_array().unwrap().len(),
        6,
        "expected 6 fresh symlinks on first run"
    );

    let second = run_install_json(home);
    assert_eq!(
        second["shared"]["written"].as_array().unwrap().len(),
        0,
        "second run should not write any shared files"
    );
    assert_eq!(
        second["shared"]["unchanged"].as_array().unwrap().len(),
        6,
        "second run should report 6 unchanged shared files"
    );
    assert_eq!(
        second["symlinks"]["linked"].as_array().unwrap().len(),
        0,
        "second run should not create any new symlinks"
    );
    assert_eq!(
        second["symlinks"]["alreadyLinked"]
            .as_array()
            .unwrap()
            .len(),
        6,
        "second run should report 6 already-linked"
    );
}

#[test]
fn skills_install_skips_agents_without_a_config_dir() {
    // Only .gemini exists; the other supported agents should be skipped.
    let tmp = skills_sandbox(&[".gemini"]);
    let home = tmp.path();
    let result = run_install_json(home);

    let agents = result["agents"].as_array().expect("agents array");
    assert_eq!(agents.len(), 1, "expected 1 agent detected, got {agents:?}");
    assert_eq!(agents[0]["type"].as_str(), Some("gemini-cli"));

    // No symlinks anywhere except under .gemini/skills.
    assert!(!home.join(".claude").exists());
    assert!(!home.join(".codex").exists());
    assert!(!home.join(".config").join("opencode").exists());
    for name in [
        "band",
        "band-chat",
        "band-terminal",
        "band-browser",
        "band-start",
        "band-loop",
    ] {
        let link = home.join(".gemini").join("skills").join(name);
        let meta = fs::symlink_metadata(&link)
            .unwrap_or_else(|e| panic!("expected {} to exist: {e}", link.display()));
        assert!(
            meta.file_type().is_symlink(),
            "{} not symlink",
            link.display()
        );
    }
}

// The conflict path relies on `std::os::unix::fs::symlink` to plant a
// decoy, so it only exercises a meaningful scenario on unix. Gating the
// whole test on `#[cfg(unix)]` avoids it silently passing-by-omission on
// other platforms (which would make a Windows-port regression invisible
// here).
#[cfg(unix)]
#[test]
fn skills_install_surfaces_conflict_when_wrong_target_symlink_exists() {
    let tmp = skills_sandbox(&[".claude"]);
    let home = tmp.path();

    // Plant a symlink at ~/.claude/skills/band that points at a decoy.
    let decoy = home.join("decoy-band-skill");
    fs::create_dir_all(&decoy).expect("create decoy");
    let claude_skills = home.join(".claude").join("skills");
    fs::create_dir_all(&claude_skills).expect("create skills dir");
    let link = claude_skills.join("band");
    std::os::unix::fs::symlink(&decoy, &link).expect("plant decoy symlink");

    let result = run_install_json(home);

    // Conflict reported, link untouched.
    let conflicts = result["symlinks"]["conflicts"]
        .as_array()
        .expect("conflicts");
    assert!(
        conflicts
            .iter()
            .any(|c| c["path"].as_str() == Some(link.to_str().unwrap())),
        "expected conflict for {} in {conflicts:?}",
        link.display()
    );
    let resolved = fs::canonicalize(&link).expect("canonicalize");
    let expected = fs::canonicalize(&decoy).expect("canonicalize decoy");
    assert_eq!(resolved, expected, "link should still point at decoy");

    // Other skills still get linked normally.
    assert!(result["symlinks"]["linked"].as_array().unwrap().len() >= 5);
}

// Dangling-symlink scenario: the link exists but its target has been
// removed (e.g. the user manually pruned `~/.agents/skills/`, or `$HOME`
// moved since the last install). Implementation reports
// `existing symlink is broken (...)` as a Conflict; lock that in.
#[cfg(unix)]
#[test]
fn skills_install_surfaces_conflict_when_dangling_symlink_exists() {
    let tmp = skills_sandbox(&[".claude"]);
    let home = tmp.path();

    let claude_skills = home.join(".claude").join("skills");
    fs::create_dir_all(&claude_skills).expect("create skills dir");
    let link = claude_skills.join("band");

    // Plant a symlink at ~/.claude/skills/band whose target never existed.
    let bogus_target = home.join("never-existed").join("agents-skills-band");
    std::os::unix::fs::symlink(&bogus_target, &link).expect("plant dangling symlink");
    // Sanity: lstat sees the symlink, canonicalize/read on it fails.
    assert!(fs::symlink_metadata(&link).is_ok());
    assert!(fs::canonicalize(&link).is_err());

    let result = run_install_json(home);

    let conflicts = result["symlinks"]["conflicts"]
        .as_array()
        .expect("conflicts");
    assert!(
        conflicts
            .iter()
            .any(|c| c["path"].as_str() == Some(link.to_str().unwrap())
                && c["reason"].as_str().unwrap_or("").contains("broken")),
        "expected broken-symlink conflict for {} in {conflicts:?}",
        link.display()
    );
    // The dangling symlink is left in place — no overwrite.
    let meta = fs::symlink_metadata(&link).expect("metadata");
    assert!(
        meta.file_type().is_symlink(),
        "link should still be a symlink"
    );
    assert!(
        fs::canonicalize(&link).is_err(),
        "link should still be dangling"
    );
    // Other skills still get linked correctly.
    assert!(result["symlinks"]["linked"].as_array().unwrap().len() >= 5);
}

#[test]
fn skills_install_surfaces_conflict_when_real_directory_occupies_path() {
    let tmp = skills_sandbox(&[".claude"]);
    let home = tmp.path();

    // Plant a real directory with user content at ~/.claude/skills/band.
    let claude_skills = home.join(".claude").join("skills");
    let real_dir = claude_skills.join("band");
    fs::create_dir_all(&real_dir).expect("create real dir");
    let user_file = real_dir.join("SKILL.md");
    fs::write(&user_file, "# user-authored band skill\n").expect("write user file");

    let result = run_install_json(home);

    let conflicts = result["symlinks"]["conflicts"]
        .as_array()
        .expect("conflicts");
    assert!(
        conflicts
            .iter()
            .any(|c| c["path"].as_str() == Some(real_dir.to_str().unwrap())
                && c["reason"]
                    .as_str()
                    .unwrap_or("")
                    .contains("real directory")),
        "expected real-directory conflict, got {conflicts:?}"
    );
    // User content preserved.
    assert_eq!(
        fs::read_to_string(&user_file).expect("read user file"),
        "# user-authored band skill\n"
    );
    // Path is still a real directory, not a symlink.
    let meta = fs::symlink_metadata(&real_dir).expect("metadata");
    assert!(!meta.file_type().is_symlink());
}

#[test]
fn skills_install_writes_shared_skills_even_when_no_agents_are_detected() {
    // No agent config dirs exist — installing still populates ~/.agents/skills/
    // because the shared content is useful on its own.
    let tmp = skills_sandbox(&[]);
    let home = tmp.path();
    let result = run_install_json(home);

    assert_eq!(result["shared"]["written"].as_array().unwrap().len(), 6);
    assert_eq!(result["symlinks"]["linked"].as_array().unwrap().len(), 0);
    assert_eq!(result["agents"].as_array().unwrap().len(), 0);

    let shared_dir = home.join(".agents").join("skills");
    for name in [
        "band",
        "band-chat",
        "band-terminal",
        "band-browser",
        "band-start",
        "band-loop",
    ] {
        assert!(
            shared_dir.join(name).join("SKILL.md").is_file(),
            "shared {} should exist",
            name
        );
    }
}

#[test]
fn skills_install_text_output_summarizes_each_stage() {
    let tmp = skills_sandbox(&[".claude"]);
    let home = tmp.path();
    let output = band_offline(&["skills", "install", "--home", home.to_str().unwrap()]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let stdout = stdout(&output);
    assert!(stdout.contains("Installed 6 skill(s)"));
    assert!(stdout.contains("shared: 6 written"));
    assert!(stdout.contains("symlinks: 6 created"));
    assert!(stdout.contains("claude-code →"));
}

#[test]
fn skills_install_filter_limits_to_matching_skills_only() {
    let tmp = skills_sandbox(&[".claude"]);
    let home = tmp.path();
    let output = band_offline(&[
        "--output",
        "json",
        "skills",
        "install",
        "--home",
        home.to_str().unwrap(),
        "--filter",
        "chat",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let result: serde_json::Value = serde_json::from_str(&stdout(&output)).expect("json");

    let skills = result["skills"].as_array().expect("skills");
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0]["name"].as_str(), Some("band-chat"));

    assert!(home
        .join(".agents")
        .join("skills")
        .join("band-chat")
        .join("SKILL.md")
        .is_file());
    assert!(!home.join(".agents").join("skills").join("band").exists());
    // Only one symlink (just band-chat) under .claude/skills/.
    assert_eq!(result["symlinks"]["linked"].as_array().unwrap().len(), 1);
}
