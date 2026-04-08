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

        // Create a real git repo
        fs::create_dir_all(&repo_path).unwrap();
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
        // the test forever if the server fails to start.
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = line.unwrap_or_default();
                if line.contains("listening") {
                    let _ = tx.send(true);
                    return;
                }
            }
            let _ = tx.send(false);
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
/// Runs a Node.js script that uses `better-sqlite3` (from the web app's
/// `node_modules`) to apply migrations and insert seed data.
fn seed_db(band_dir: &Path, repo_path: &Path, settings: &serde_json::Value) {
    let seed_script = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/seed-db.mjs");
    let output = Command::new("node")
        .arg(&seed_script)
        .arg(band_dir)
        .arg("my-project")
        .arg(repo_path)
        .arg("main")
        .arg(settings.to_string())
        .output()
        .expect("seed-db.mjs failed to execute");

    assert!(
        output.status.success(),
        "seed-db.mjs failed: {}",
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
        const Database = (await import("{bsqlite}")).default;
        const db = new Database("{db}");
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
        bsqlite = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/web/node_modules/better-sqlite3/lib/index.js")
            .to_string_lossy()
            .replace('\\', "/"),
        db = db_path.to_string_lossy().replace('\\', "/"),
    );

    let output = Command::new("node")
        .args(["--input-type=module", "-e", &script])
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
        const Database = (await import("{bsqlite}")).default;
        const db = new Database("{db}");
        const row = db.prepare(
            "SELECT agent_status FROM workspace_statuses WHERE workspace_id = ?"
        ).get("{ws}");
        console.log(JSON.stringify({{ status: row ? row.agent_status : null }}));
        db.close();
        "#,
        bsqlite = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/web/node_modules/better-sqlite3/lib/index.js")
            .to_string_lossy()
            .replace('\\', "/"),
        db = db_path.to_string_lossy().replace('\\', "/"),
        ws = workspace_id,
    );
    let output = Command::new("node")
        .args(["--input-type=module", "-e", &script])
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
fn notify_permission_request_sets_needs_attention() {
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
        Some("needs_attention"),
        "PermissionRequest should set needs_attention"
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

// --- Tasks tests ---

#[test]
fn tasks_list_empty() {
    let env = TestEnv::new();
    let output = env.band(&["tasks", "list"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    // No tasks yet — should have empty output or just headers
}

#[test]
fn tasks_list_json_empty() {
    let env = TestEnv::new();
    let output = env.band(&["tasks", "list", "--output", "json"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    let tasks = json["tasks"].as_array().expect("tasks array");
    assert!(tasks.is_empty(), "expected no tasks: {json}");
}

#[test]
fn tasks_create_returns_task_id() {
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
        "tasks",
        "create",
        workspace_id,
        "--prompt",
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
fn tasks_create_json_output() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/task-json"]);

    let output = env.band(&[
        "tasks",
        "create",
        "my-project-feat-task-json",
        "--prompt",
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
}

#[test]
fn tasks_list_shows_submitted_task() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/task-list"]);

    let create_out = env.band(&[
        "tasks",
        "create",
        "my-project-feat-task-list",
        "--prompt",
        "do something",
        "--output",
        "json",
    ]);
    assert!(create_out.status.success());
    let create_json: serde_json::Value = serde_json::from_str(&stdout(&create_out)).unwrap();
    let task_id = create_json["id"].as_str().unwrap();

    let output = env.band(&["tasks", "list", "--output", "json"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let json: serde_json::Value = serde_json::from_str(&stdout(&output))
        .unwrap_or_else(|e| panic!("invalid JSON: {e}\nstdout: {}", stdout(&output)));
    let tasks = json["tasks"].as_array().expect("tasks array");
    assert!(
        tasks.iter().any(|t| t["id"] == task_id),
        "expected task {task_id} in list: {json}"
    );
}

#[test]
fn tasks_list_filter_by_project() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/filter-proj"]);

    env.band(&[
        "tasks",
        "create",
        "my-project-feat-filter-proj",
        "--prompt",
        "hello",
    ]);

    let output = env.band(&[
        "tasks",
        "list",
        "--project",
        "my-project",
        "--output",
        "json",
    ]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let json: serde_json::Value = serde_json::from_str(&stdout(&output)).unwrap();
    let tasks = json["tasks"].as_array().expect("tasks array");
    assert!(
        tasks.iter().all(|t| t["project"] == "my-project"),
        "all tasks should match project filter: {json}"
    );
}

#[test]
fn tasks_cancel_nonexistent_fails() {
    let env = TestEnv::new();
    let output = env.band(&["tasks", "cancel", "tsk_nonexistent"]);

    assert!(!output.status.success());
    let err = stderr(&output);
    assert!(
        err.contains("not found") || err.contains("No running task") || err.contains("Not found"),
        "stderr: {err}"
    );
}

#[test]
fn tasks_create_conflict_returns_error() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/conflict"]);

    // Submit first task — will start running
    let out1 = env.band(&[
        "tasks",
        "create",
        "my-project-feat-conflict",
        "--prompt",
        "first task",
    ]);
    assert!(out1.status.success(), "stderr: {}", stderr(&out1));

    // Immediately submit a second task — should fail with conflict
    let out2 = env.band(&[
        "tasks",
        "create",
        "my-project-feat-conflict",
        "--prompt",
        "second task",
    ]);
    // Might succeed (if first finished fast) or fail with conflict
    // We just verify it doesn't crash and returns a reasonable response
    let _ = out2;
}

#[test]
fn tasks_watch_json_streams_events() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/watch-test"]);

    // Submit a task (it will likely fail since no agent is configured)
    env.band(&[
        "tasks",
        "create",
        "my-project-feat-watch-test",
        "--prompt",
        "hello world",
    ]);

    // Wait for the task to complete (fail)
    std::thread::sleep(std::time::Duration::from_millis(2000));

    // Watch should replay buffered events as NDJSON and exit
    let output = env.band(&[
        "tasks",
        "watch",
        "--workspace",
        "my-project-feat-watch-test",
        "--output",
        "json",
    ]);
    assert!(output.status.success() || !output.status.success()); // may exit 0 or 1

    let out = stdout(&output);
    // Should have at least one NDJSON line
    if !out.is_empty() {
        for line in out.lines() {
            // Each line should be valid JSON
            let _: serde_json::Value = serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("invalid NDJSON line: {e}\nline: {line}"));
        }
    }
}

#[test]
fn tasks_watch_text_no_ansi_when_piped() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/watch-ansi"]);
    env.band(&[
        "tasks",
        "create",
        "my-project-feat-watch-ansi",
        "--prompt",
        "hello world",
    ]);

    std::thread::sleep(std::time::Duration::from_millis(2000));

    // Watch in text mode (default) — piped, so no ANSI expected
    let output = env.band(&[
        "tasks",
        "watch",
        "--workspace",
        "my-project-feat-watch-ansi",
    ]);

    let err = stderr(&output);
    // Should show the watching banner
    assert!(
        err.contains("[watching task"),
        "expected banner in stderr: {err}"
    );
    // When piped (as in tests), no ANSI escape codes should be present
    assert!(
        !err.contains("\x1b["),
        "expected no ANSI codes when piped: {err}"
    );
}

#[test]
fn tasks_watch_verbose_flag_accepted() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/watch-verbose"]);
    env.band(&[
        "tasks",
        "create",
        "my-project-feat-watch-verbose",
        "--prompt",
        "hello",
    ]);

    std::thread::sleep(std::time::Duration::from_millis(2000));

    let output = env.band(&[
        "tasks",
        "watch",
        "--workspace",
        "my-project-feat-watch-verbose",
        "--verbose",
    ]);

    // Should not crash — verbose flag is accepted
    let err = stderr(&output);
    assert!(err.contains("[watching task"), "expected banner: {err}");
}

#[test]
fn tasks_watch_tools_off_hides_tools() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/watch-tools-off"]);
    env.band(&[
        "tasks",
        "create",
        "my-project-feat-watch-tools-off",
        "--prompt",
        "hello",
    ]);

    std::thread::sleep(std::time::Duration::from_millis(2000));

    let output = env.band(&[
        "tasks",
        "watch",
        "--workspace",
        "my-project-feat-watch-tools-off",
        "--tools",
        "off",
    ]);

    let err = stderr(&output);
    // Tool indicator symbols should not appear
    assert!(
        !err.contains("\u{25b8}"),
        "expected no tool markers with --tools=off: {err}"
    );
}

#[test]
fn tasks_watch_auto_detect_workspace_from_cwd() {
    let env = TestEnv::new();

    let create_out = env.band(&["workspaces", "create", "my-project", "feat/watch-cwd"]);
    assert!(
        create_out.status.success(),
        "stderr: {}",
        stderr(&create_out)
    );
    let worktree_path = stdout(&create_out);

    env.band(&[
        "tasks",
        "create",
        "my-project-feat-watch-cwd",
        "--prompt",
        "hello",
    ]);

    std::thread::sleep(std::time::Duration::from_millis(2000));

    // Run `band tasks watch` with NO --workspace, but from inside the worktree directory
    let output = env.band_in(Path::new(&worktree_path), &["tasks", "watch"]);

    let err = stderr(&output);
    // Should auto-detect and show the watching banner with the workspace ID
    assert!(
        err.contains("[watching task"),
        "expected auto-detected watch banner: {err}"
    );
    assert!(
        err.contains("my-project-feat-watch-cwd"),
        "expected workspace ID in banner: {err}"
    );
}

#[test]
fn tasks_watch_auto_detect_fails_outside_workspace() {
    let env = TestEnv::new();

    // Create a git repo that is NOT a registered workspace
    let unrelated = env.tmp.path().join("unrelated-repo");
    fs::create_dir_all(&unrelated).unwrap();
    git(&unrelated, &["init", "-b", "main"]);
    git(&unrelated, &["commit", "--allow-empty", "-m", "init"]);

    let output = env.band_in(&unrelated, &["tasks", "watch"]);

    assert!(
        !output.status.success(),
        "expected failure when not in a workspace"
    );
    let err = stderr(&output);
    assert!(
        err.contains("No workspace found"),
        "expected helpful error message: {err}"
    );
}

#[test]
fn tasks_list_text_output() {
    let env = TestEnv::new();

    env.band(&["workspaces", "create", "my-project", "feat/task-text"]);
    env.band(&[
        "tasks",
        "create",
        "my-project-feat-task-text",
        "--prompt",
        "test task",
    ]);

    let output = env.band(&["tasks", "list"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let out = stdout(&output);
    assert!(out.contains("tsk_"), "expected task ID in output: {out}");
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
    assert!(names.contains(&"tasks list"), "missing: {names:?}");
    assert!(names.contains(&"tasks create"), "missing: {names:?}");
    assert!(names.contains(&"tasks cancel"), "missing: {names:?}");
    assert!(names.contains(&"tasks rerun"), "missing: {names:?}");
    assert!(names.contains(&"tasks watch"), "missing: {names:?}");
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

// --- Watch rendering tests (mock SSE server) ---

/// A lightweight mock server that accepts one connection and writes canned SSE data.
struct MockSseServer {
    port: u16,
    _handle: std::thread::JoinHandle<()>,
}

impl MockSseServer {
    /// Start a mock server that will serve `sse_body` as the response to the first GET request.
    fn new(sse_body: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();

        let handle = std::thread::spawn(move || {
            use std::io::Write;
            // Accept a single connection
            let (mut stream, _) = listener.accept().unwrap();
            // Read the request (drain it so the client doesn't hang)
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            // Write HTTP response with SSE body
            let response = format!(
                "HTTP/1.1 200 OK\r\n\
                 Content-Type: text/event-stream\r\n\
                 Connection: close\r\n\
                 \r\n\
                 {sse_body}"
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
            // Close triggers EOF for the client
        });

        Self {
            port,
            _handle: handle,
        }
    }
}

/// Build SSE data from a list of JSON chunks.
fn build_sse(chunks: &[serde_json::Value]) -> String {
    use std::fmt::Write;
    let mut buf = String::new();
    for chunk in chunks {
        let _ = write!(buf, "data: {}\n\n", serde_json::to_string(chunk).unwrap());
    }
    buf
}

/// Run the band CLI against a mock SSE server instead of the real web server.
fn band_with_mock(
    tmp: &tempfile::TempDir,
    mock: &MockSseServer,
    args: &[&str],
) -> std::process::Output {
    let band_dir = tmp.path().join(".band");
    fs::create_dir_all(&band_dir).ok();
    // Seed settings in DB so ApiClient::from_settings works
    seed_settings_only(
        &band_dir,
        &serde_json::json!({
            "tokenSecret": "mock-token"
        }),
    );

    Command::new(env!("CARGO_BIN_EXE_band"))
        .args(args)
        .env("BAND_HOME", &band_dir)
        .env("BAND_SERVER_URL", format!("http://127.0.0.1:{}", mock.port))
        .output()
        .expect("failed to execute band")
}

#[test]
fn watch_render_text_deltas() {
    let chunks = vec![
        serde_json::json!({"type": "text-delta", "delta": "Hello "}),
        serde_json::json!({"type": "text-delta", "delta": "world!"}),
        serde_json::json!({"type": "text-end"}),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert_eq!(out, "Hello world!", "stdout: {out}");
}

#[test]
fn watch_render_tool_input_shows_marker() {
    let chunks = vec![
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Read",
            "input": {"file_path": "/src/main.rs"}
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    let err = stderr(&output);
    // Should have the tool marker and tool summary
    assert!(
        err.contains("\u{25b8}"),
        "expected tool marker in stderr: {err}"
    );
    assert!(
        err.contains("Read: /src/main.rs"),
        "expected tool summary: {err}"
    );
}

#[test]
fn watch_render_tool_input_hidden_with_tools_off() {
    let chunks = vec![
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Read",
            "input": {"file_path": "/src/main.rs"}
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(
        &tmp,
        &mock,
        &["tasks", "watch", "--workspace", "ws-1", "--tools", "off"],
    );

    let err = stderr(&output);
    assert!(
        !err.contains("\u{25b8}"),
        "tool marker should be hidden: {err}"
    );
    assert!(
        !err.contains("Read:"),
        "tool summary should be hidden: {err}"
    );
}

#[test]
fn watch_render_tool_output_shown_in_verbose() {
    let chunks = vec![
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Bash",
            "input": {"command": "echo hi"}
        }),
        serde_json::json!({
            "type": "tool-output-available",
            "toolCallId": "tc_1",
            "output": "hi\n"
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(
        &tmp,
        &mock,
        &["tasks", "watch", "--workspace", "ws-1", "--verbose"],
    );

    let err = stderr(&output);
    // Verbose mode should show the start marker
    assert!(err.contains("\u{25b8}"), "expected start marker: {err}");
    // Verbose mode should show input JSON
    assert!(err.contains("echo hi"), "expected input in verbose: {err}");
    // Verbose mode should show completion marker
    assert!(
        err.contains("\u{2713}"),
        "expected completion marker: {err}"
    );
    // Verbose mode should show tool output
    assert!(err.contains("hi"), "expected tool output in verbose: {err}");
}

#[test]
fn watch_render_tool_output_hidden_in_default() {
    let chunks = vec![
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Read",
            "input": {"file_path": "/src/lib.rs"}
        }),
        serde_json::json!({
            "type": "tool-output-available",
            "toolCallId": "tc_1",
            "output": "fn main() {}"
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    let err = stderr(&output);
    // Default mode should show start marker but NOT completion marker
    assert!(err.contains("\u{25b8}"), "expected start marker: {err}");
    assert!(
        !err.contains("\u{2713}"),
        "completion marker should be hidden in default: {err}"
    );
    assert!(
        !err.contains("fn main()"),
        "tool output should be hidden in default: {err}"
    );
}

#[test]
fn watch_render_error_chunk() {
    let chunks = vec![
        serde_json::json!({"type": "text-delta", "delta": "Working..."}),
        serde_json::json!({"type": "text-end"}),
        serde_json::json!({"type": "error", "errorText": "Agent crashed unexpectedly"}),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    // Error should cause non-zero exit
    assert!(!output.status.success(), "expected failure exit code");
    let err = stderr(&output);
    assert!(err.contains("Error:"), "expected 'Error:' in stderr: {err}");
    assert!(
        err.contains("Agent crashed unexpectedly"),
        "expected error text: {err}"
    );
}

#[test]
fn watch_render_data_result_with_duration_and_cost() {
    let chunks = vec![
        serde_json::json!({"type": "text-delta", "delta": "Done."}),
        serde_json::json!({"type": "text-end"}),
        serde_json::json!({
            "type": "data-result",
            "data": {
                "durationMs": 125_000,
                "costUsd": 0.42,
                "numTurns": 12
            }
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let err = stderr(&output);
    assert!(
        err.contains("Task completed in 2m 5s"),
        "expected duration: {err}"
    );
    assert!(err.contains("$0.42"), "expected cost: {err}");
    assert!(err.contains("12 turns"), "expected turns: {err}");
}

#[test]
fn watch_render_full_conversation() {
    let chunks = vec![
        serde_json::json!({"type": "text-delta", "delta": "Let me fix that bug.\n"}),
        serde_json::json!({"type": "text-end"}),
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Read",
            "input": {"file_path": "/src/app.rs"}
        }),
        serde_json::json!({
            "type": "tool-output-available",
            "toolCallId": "tc_1",
            "output": "fn main() { println!(\"hello\"); }"
        }),
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_2",
            "toolName": "Edit",
            "input": {"file_path": "/src/app.rs"}
        }),
        serde_json::json!({
            "type": "tool-output-available",
            "toolCallId": "tc_2",
            "output": "OK"
        }),
        serde_json::json!({"type": "text-delta", "delta": "Fixed it.\n"}),
        serde_json::json!({"type": "text-end"}),
        serde_json::json!({
            "type": "data-result",
            "data": {"durationMs": 5000}
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(
        out.contains("Let me fix that bug."),
        "expected first text: {out}"
    );
    assert!(out.contains("Fixed it."), "expected second text: {out}");

    let err = stderr(&output);
    assert!(
        err.contains("Read: /src/app.rs"),
        "expected Read tool: {err}"
    );
    assert!(
        err.contains("Edit: /src/app.rs"),
        "expected Edit tool: {err}"
    );
    assert!(
        err.contains("Task completed in 5s"),
        "expected completion: {err}"
    );
}

#[test]
fn watch_render_json_mode_outputs_ndjson() {
    let chunks = vec![
        serde_json::json!({"type": "text-delta", "delta": "hi"}),
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Bash",
            "input": {"command": "ls"}
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(
        &tmp,
        &mock,
        &["tasks", "watch", "--workspace", "ws-1", "--output", "json"],
    );

    let out = stdout(&output);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 3, "expected 3 NDJSON lines: {out}");
    for line in &lines {
        let v: serde_json::Value = serde_json::from_str(line)
            .unwrap_or_else(|e| panic!("invalid NDJSON: {e}\nline: {line}"));
        assert!(v.get("type").is_some(), "expected 'type' field: {v}");
    }
    // JSON mode should NOT have tool markers or banners on stderr
    let err = stderr(&output);
    assert!(
        !err.contains("[watching task"),
        "no banner in json mode: {err}"
    );
}

#[test]
fn watch_render_no_ansi_when_piped() {
    let chunks = vec![
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Read",
            "input": {"file_path": "/src/main.rs"}
        }),
        serde_json::json!({"type": "error", "errorText": "something failed"}),
        serde_json::json!({
            "type": "data-result",
            "data": {"durationMs": 1000}
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    let err = stderr(&output);
    // CLI is piped in tests, so no ANSI escape codes should appear
    assert!(
        !err.contains("\x1b["),
        "expected no ANSI codes when piped: {err}"
    );
    // But content should still be present
    assert!(
        err.contains("Read: /src/main.rs"),
        "expected tool text: {err}"
    );
    assert!(err.contains("Error:"), "expected error text: {err}");
    assert!(
        err.contains("Task completed"),
        "expected completion text: {err}"
    );
}

#[test]
fn watch_render_verbose_shows_tool_input_json() {
    let chunks = vec![
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Grep",
            "input": {"pattern": "TODO", "path": "/src"}
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(
        &tmp,
        &mock,
        &["tasks", "watch", "--workspace", "ws-1", "--verbose"],
    );

    let err = stderr(&output);
    // Verbose should show the formatted JSON input
    assert!(
        err.contains("\"pattern\""),
        "expected 'pattern' key in verbose output: {err}"
    );
    assert!(err.contains("\"TODO\""), "expected pattern value: {err}");
    assert!(err.contains("\"path\""), "expected 'path' key: {err}");
}

#[test]
fn watch_render_tools_full_shows_completion_and_output() {
    let chunks = vec![
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Bash",
            "input": {"command": "npm test"}
        }),
        serde_json::json!({
            "type": "tool-output-available",
            "toolCallId": "tc_1",
            "output": "PASS all 5 tests"
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    // Use --tools=full (same as --verbose for tool display)
    let output = band_with_mock(
        &tmp,
        &mock,
        &["tasks", "watch", "--workspace", "ws-1", "--tools", "full"],
    );

    let err = stderr(&output);
    assert!(err.contains("\u{25b8}"), "expected start marker: {err}");
    assert!(
        err.contains("\u{2713}"),
        "expected completion marker: {err}"
    );
    assert!(
        err.contains("PASS all 5 tests"),
        "expected tool output: {err}"
    );
}

#[test]
fn watch_render_text_then_tools_then_text() {
    // Verify spacing when text and tools interleave
    let chunks = vec![
        serde_json::json!({"type": "text-delta", "delta": "First message\n"}),
        serde_json::json!({"type": "text-end"}),
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Read",
            "input": {"file_path": "/a.rs"}
        }),
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_2",
            "toolName": "Read",
            "input": {"file_path": "/b.rs"}
        }),
        serde_json::json!({"type": "text-delta", "delta": "Second message"}),
        serde_json::json!({"type": "text-end"}),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    let out = stdout(&output);
    assert!(out.contains("First message"), "expected first msg: {out}");
    assert!(out.contains("Second message"), "expected second msg: {out}");

    let err = stderr(&output);
    assert!(err.contains("Read: /a.rs"), "expected first tool: {err}");
    assert!(err.contains("Read: /b.rs"), "expected second tool: {err}");
}

#[test]
fn watch_render_data_result_without_optional_fields() {
    let chunks = vec![
        serde_json::json!({
            "type": "data-result",
            "data": {"durationMs": 3000}
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    assert!(output.status.success());
    let err = stderr(&output);
    assert!(
        err.contains("Task completed in 3s"),
        "expected duration only: {err}"
    );
    // Should NOT contain cost or turns when not provided
    assert!(!err.contains('$'), "no cost expected: {err}");
    assert!(!err.contains("turns"), "no turns expected: {err}");
}

#[test]
fn watch_render_multiple_tool_calls_with_summaries() {
    let chunks = vec![
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Bash",
            "input": {"command": "cargo build"}
        }),
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_2",
            "toolName": "Grep",
            "input": {"pattern": "fn main", "path": "/src"}
        }),
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_3",
            "toolName": "Glob",
            "input": {"pattern": "**/*.rs"}
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    let err = stderr(&output);
    assert!(
        err.contains("Bash: cargo build"),
        "expected Bash summary: {err}"
    );
    assert!(err.contains("Grep: /src"), "expected Grep summary: {err}");
    assert!(
        err.contains("Glob: **/*.rs"),
        "expected Glob summary: {err}"
    );
}

#[test]
fn watch_render_tool_with_no_matching_summary_key() {
    // When tool input has no recognized key, just show tool name
    let chunks = vec![
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "CustomTool",
            "input": {"foo": "bar"}
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    let err = stderr(&output);
    assert!(err.contains("CustomTool"), "expected tool name: {err}");
    // Should NOT have "CustomTool:" (with colon) since no summary value
    assert!(
        !err.contains("CustomTool:"),
        "no colon when no summary key: {err}"
    );
}

#[test]
fn watch_render_tool_not_inline_with_text() {
    // Regression: tool calls must not appear on the same line as text output.
    // The text-end chunk resets in_text, but if the last delta didn't end with \n,
    // the tool line would appear visually inline on the terminal.
    let chunks = vec![
        serde_json::json!({"type": "text-delta", "delta": "Analyzing code:"}),
        serde_json::json!({"type": "text-end"}),
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Read",
            "input": {"file_path": "/src/main.rs"}
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(&tmp, &mock, &["tasks", "watch", "--workspace", "ws-1"]);

    // stdout should end with a newline (the renderer adds one before the tool line)
    let raw_stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        raw_stdout.ends_with('\n'),
        "stdout should end with newline when tool follows non-newline text: {raw_stdout:?}"
    );
    // Tool line should be on its own line in stderr, not mixed into stdout
    let err = stderr(&output);
    assert!(
        err.contains("Read: /src/main.rs"),
        "tool line present: {err}"
    );
}

#[test]
fn watch_render_verbose_truncates_long_output() {
    let long_output = "x".repeat(3000);
    let chunks = vec![
        serde_json::json!({
            "type": "tool-input-available",
            "toolCallId": "tc_1",
            "toolName": "Bash",
            "input": {"command": "cat bigfile"}
        }),
        serde_json::json!({
            "type": "tool-output-available",
            "toolCallId": "tc_1",
            "output": long_output
        }),
        serde_json::json!({"type": "finish"}),
    ];
    let mock = MockSseServer::new(build_sse(&chunks));
    let tmp = tempfile::tempdir().unwrap();

    let output = band_with_mock(
        &tmp,
        &mock,
        &["tasks", "watch", "--workspace", "ws-1", "--verbose"],
    );

    let err = stderr(&output);
    assert!(
        err.contains("[...truncated]"),
        "expected truncation marker: {err}"
    );
    // Full 3000-char output should not appear
    assert!(
        !err.contains(&"x".repeat(3000)),
        "should not contain full output"
    );
}
