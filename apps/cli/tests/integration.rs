use std::fs;
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// The CLI now delegates all state operations to the web server.
/// These tests start a real web server (from apps/web/dist), seed it
/// with a temp HOME, then run CLI commands against it.

struct TestEnv {
    /// The .band directory (used as BAND_HOME for the CLI)
    band_dir: PathBuf,
    /// The fake HOME directory (parent of .band, used as HOME for the server)
    _home_dir: PathBuf,
    repo_path: PathBuf,
    server_process: Child,
    _tmp: tempfile::TempDir,
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

        // Seed state.json with this project
        let state = serde_json::json!({
            "projects": [{
                "name": "my-project",
                "path": repo_path.to_string_lossy(),
                "defaultBranch": "main",
                "worktrees": []
            }]
        });
        fs::write(
            band_dir.join("state.json"),
            serde_json::to_string_pretty(&state).unwrap(),
        )
        .unwrap();

        // Find a free port
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };

        // Seed settings.json with token and port
        let settings = serde_json::json!({
            "tokenSecret": token,
            "webServerPort": port,
            "worktreesDir": band_dir.join("worktrees").to_string_lossy(),
        });
        fs::write(
            band_dir.join("settings.json"),
            serde_json::to_string_pretty(&settings).unwrap(),
        )
        .unwrap();

        // Start the web server
        let web_dist =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/web/dist/start-server.mjs");
        assert!(
            web_dist.exists(),
            "Web server not built. Run: pnpm -F @band/web build"
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

        // Wait for "listening" on stdout
        let stdout = child.stdout.take().unwrap();
        let reader = BufReader::new(stdout);
        let mut found = false;
        for line in reader.lines() {
            let line = line.unwrap_or_default();
            if line.contains("listening") {
                found = true;
                break;
            }
        }
        assert!(found, "web server did not emit 'listening'");

        Self {
            band_dir,
            _home_dir: home_dir,
            repo_path,
            server_process: child,
            _tmp: tmp,
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

    fn state_json(&self) -> serde_json::Value {
        let data = fs::read_to_string(self.band_dir.join("state.json")).unwrap();
        serde_json::from_str(&data).unwrap()
    }
}

impl Drop for TestEnv {
    fn drop(&mut self) {
        let _ = self.server_process.kill();
        let _ = self.server_process.wait();
    }
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

#[test]
fn projects_lists_registered_project() {
    let env = TestEnv::new();
    let output = env.band(&["projects"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("my-project"), "expected project name: {out}");
}

#[test]
fn create_makes_worktree_and_returns_path() {
    let env = TestEnv::new();
    let output = env.band(&["create", "my-project", "feat/test"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let path = stdout(&output);
    assert!(
        path.contains("feat/test"),
        "expected path with branch: {path}"
    );

    // Worktree directory exists on disk
    assert!(Path::new(&path).exists(), "worktree dir should exist");

    // State was updated
    let state = env.state_json();
    let worktrees = &state["projects"][0]["worktrees"];
    assert_eq!(worktrees.as_array().unwrap().len(), 1);
    assert_eq!(worktrees[0]["branch"], "feat/test");
}

#[test]
fn create_is_idempotent() {
    let env = TestEnv::new();

    let out1 = env.band(&["create", "my-project", "feat/idem"]);
    assert!(out1.status.success(), "stderr: {}", stderr(&out1));

    let out2 = env.band(&["create", "my-project", "feat/idem"]);
    assert!(out2.status.success(), "stderr: {}", stderr(&out2));

    // Both return the same path
    assert_eq!(stdout(&out1), stdout(&out2));
}

#[test]
fn create_with_base_branch() {
    let env = TestEnv::new();

    // Create a commit on main so there's something to branch from
    let marker = env.repo_path.join("marker.txt");
    fs::write(&marker, "hello").unwrap();
    git(&env.repo_path, &["add", "marker.txt"]);
    git(&env.repo_path, &["commit", "-m", "add marker"]);

    let output = env.band(&["create", "my-project", "feat/from-main", "--base", "main"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let path = stdout(&output);
    // The new worktree should contain the marker file
    assert!(
        Path::new(&path).join("marker.txt").exists(),
        "worktree should have marker.txt from main"
    );
}

#[test]
fn create_unknown_project_fails() {
    let env = TestEnv::new();
    let output = env.band(&["create", "nonexistent", "feat/x"]);

    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("not found"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn list_shows_created_worktrees() {
    let env = TestEnv::new();
    env.band(&["create", "my-project", "feat/a"]);
    env.band(&["create", "my-project", "feat/b"]);

    let output = env.band(&["list"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    let out = stdout(&output);
    assert!(out.contains("feat/a"), "should list feat/a: {out}");
    assert!(out.contains("feat/b"), "should list feat/b: {out}");
}

#[test]
fn list_filters_by_project() {
    let env = TestEnv::new();
    env.band(&["create", "my-project", "feat/filtered"]);

    let output = env.band(&["list", "my-project"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));
    assert!(stdout(&output).contains("feat/filtered"));

    let output = env.band(&["list", "nonexistent"]);
    assert!(!output.status.success());
    assert!(stderr(&output).contains("not found"));
}

#[test]
fn remove_cleans_up_worktree_and_state() {
    let env = TestEnv::new();

    let create_out = env.band(&["create", "my-project", "feat/rm"]);
    assert!(
        create_out.status.success(),
        "stderr: {}",
        stderr(&create_out)
    );
    let path = stdout(&create_out);

    let output = env.band(&["remove", "my-project", "feat/rm"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    // Worktree removed from state
    let state = env.state_json();
    let worktrees = &state["projects"][0]["worktrees"];
    assert_eq!(worktrees.as_array().unwrap().len(), 0);

    // Worktree directory removed from disk
    assert!(!Path::new(&path).exists(), "worktree dir should be gone");
}

#[test]
fn remove_unknown_branch_fails() {
    let env = TestEnv::new();
    let output = env.band(&["remove", "my-project", "nonexistent"]);

    assert!(!output.status.success());
    assert!(
        stderr(&output).contains("not found"),
        "stderr: {}",
        stderr(&output)
    );
}

#[test]
fn remove_unknown_project_fails() {
    let env = TestEnv::new();
    let output = env.band(&["remove", "nonexistent", "main"]);

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

    // Write a .band/config.json in the repo with a setup script
    let band_dir = env.repo_path.join(".band");
    fs::create_dir_all(&band_dir).unwrap();
    fs::write(
        band_dir.join("config.json"),
        r#"{ "setup": "touch setup-ran.txt" }"#,
    )
    .unwrap();
    git(&env.repo_path, &["add", ".band/config.json"]);
    git(&env.repo_path, &["commit", "-m", "add config"]);

    let output = env.band(&["create", "my-project", "feat/setup"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let path = stdout(&output);
    assert!(
        Path::new(&path).join("setup-ran.txt").exists(),
        "setup script should have created setup-ran.txt"
    );
}

#[test]
fn teardown_script_runs_on_remove() {
    let env = TestEnv::new();

    // Write a .band/config.json with a teardown that creates a marker in BAND_HOME
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

    let create_out = env.band(&["create", "my-project", "feat/teardown"]);
    assert!(create_out.status.success());

    let output = env.band(&["remove", "my-project", "feat/teardown"]);
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    assert!(
        marker_path.exists(),
        "teardown script should have created marker"
    );
}

#[test]
fn run_creates_worktree_and_dispatches_task() {
    let env = TestEnv::new();
    let output = env.band(&["run", "my-project", "feat/run", "--prompt", "hello world"]);

    assert!(output.status.success(), "stderr: {}", stderr(&output));

    let path = stdout(&output);
    // Worktree directory exists on disk
    assert!(Path::new(&path).exists(), "worktree dir should exist");

    // State was updated
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
fn run_unknown_project_fails() {
    let env = TestEnv::new();
    let output = env.band(&["run", "nonexistent", "feat/x", "--prompt", "hello"]);

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

    let output = env.band(&["create", "my-project", "feat/fail-setup"]);
    // Should still succeed — setup failure is non-fatal
    assert!(output.status.success(), "stderr: {}", stderr(&output));

    // Path still printed
    let path = stdout(&output);
    assert!(Path::new(&path).exists());
}

#[test]
fn notify_silently_succeeds_when_server_unreachable() {
    // Use a completely isolated env with wrong port so server is unreachable
    let tmp = tempfile::tempdir().expect("create tempdir");
    let band_home = tmp.path().join("band-home");
    fs::create_dir_all(&band_home).unwrap();

    let settings = serde_json::json!({
        "tokenSecret": "fake-token",
        "webServerPort": 19999,
    });
    fs::write(
        band_home.join("settings.json"),
        serde_json::to_string_pretty(&settings).unwrap(),
    )
    .unwrap();

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

    // Should succeed (exit 0) even when server is unreachable
    assert!(
        output.status.success(),
        "notify should not fail when server is down. stderr: {}",
        stderr(&output)
    );
}
