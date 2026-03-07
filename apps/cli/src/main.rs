mod git;
mod shell;
mod state;

use clap::{Parser, Subcommand};
use std::process;

#[derive(Parser)]
#[command(name = "band", about = "Band CLI — programmatic workspace management")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Create a new workspace (git worktree + state registration)
    Create {
        /// Project name
        project: String,
        /// Branch name
        branch: String,
        /// Base branch to create from (defaults to project's default branch)
        #[arg(long)]
        base: Option<String>,
    },
    /// List workspaces, optionally filtered by project
    List {
        /// Project name (optional filter)
        project: Option<String>,
    },
    /// Remove a workspace (git worktree + state cleanup)
    Remove {
        /// Project name
        project: String,
        /// Branch name
        branch: String,
    },
    /// List registered projects
    Projects,
}

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Create {
            project,
            branch,
            base,
        } => cmd_create(&project, &branch, base.as_deref()),
        Commands::List { project } => cmd_list(project.as_deref()),
        Commands::Remove { project, branch } => cmd_remove(&project, &branch),
        Commands::Projects => cmd_projects(),
    };

    if let Err(e) = result {
        eprintln!("error: {e}");
        process::exit(1);
    }
}

fn cmd_create(project: &str, branch: &str, base: Option<&str>) -> Result<(), String> {
    let worktree_path = state::with_locked_state(|app_state| {
        let proj = app_state
            .projects
            .iter_mut()
            .find(|p| p.name == project)
            .ok_or_else(|| format!("Project '{project}' not found"))?;

        // Already tracked — return existing path
        if let Some(wt) = proj.worktrees.iter().find(|wt| wt.branch == branch) {
            return Ok(wt.path.clone());
        }

        let target_path = state::worktrees_dir().join(project).join(branch);
        let target_path_str = target_path.to_string_lossy().to_string();

        // Only create the git worktree if it doesn't already exist on disk
        if !target_path.exists() {
            let base_branch = base.unwrap_or(&proj.default_branch);
            git::create_worktree(&proj.path, branch, &target_path_str, Some(base_branch))?;
        }

        proj.worktrees.push(state::WorktreeState {
            branch: branch.to_string(),
            path: target_path_str.clone(),
            head: None,
        });

        Ok(target_path_str)
    })?;

    // Run setup script if configured — failure is non-fatal
    let config = state::load_project_config(&worktree_path);
    if let Some(setup) = &config.setup {
        if let Err(e) = shell::run_script(setup, &worktree_path) {
            eprintln!("Setup script failed for {project}/{branch}: {e}");
        }
    }

    // Print the worktree path to stdout on success
    println!("{worktree_path}");
    Ok(())
}

fn cmd_list(project_filter: Option<&str>) -> Result<(), String> {
    state::with_locked_state_read(|app_state| {
        let projects: Vec<_> = if let Some(name) = project_filter {
            app_state
                .projects
                .iter()
                .filter(|p| p.name == name)
                .collect()
        } else {
            app_state.projects.iter().collect()
        };

        if let Some(name) = project_filter {
            if projects.is_empty() {
                return Err(format!("Project '{name}' not found"));
            }
        }

        for proj in projects {
            for wt in &proj.worktrees {
                println!("{}\t{}\t{}", proj.name, wt.branch, wt.path);
            }
        }
        Ok(())
    })
}

fn cmd_remove(project: &str, branch: &str) -> Result<(), String> {
    let (worktree_path, project_path) = state::with_locked_state(|app_state| {
        let proj = app_state
            .projects
            .iter_mut()
            .find(|p| p.name == project)
            .ok_or_else(|| format!("Project '{project}' not found"))?;

        let wt = proj
            .worktrees
            .iter()
            .find(|wt| wt.branch == branch)
            .ok_or_else(|| format!("Worktree '{branch}' not found in project '{project}'"))?;

        let worktree_path = wt.path.clone();
        let project_path = proj.path.clone();

        proj.worktrees.retain(|wt| wt.branch != branch);

        Ok((worktree_path, project_path))
    })?;

    // Load config before removing the worktree (teardown script lives in it)
    let config = state::load_project_config(&worktree_path);

    // Clean up status file
    let status_file = state::status_dir().join(format!("{project}-{branch}.json"));
    let _ = std::fs::remove_file(status_file);

    // Run teardown script before removing worktree so it can access project files
    if let Some(teardown) = &config.teardown {
        if let Err(e) = shell::run_script(teardown, &worktree_path) {
            eprintln!("Teardown script failed for {project}/{branch}: {e}");
        }
    }

    // Remove git worktree
    if std::path::Path::new(&worktree_path).exists() {
        if let Err(e) = git::remove_worktree(&project_path, &worktree_path) {
            eprintln!("Warning: failed to remove git worktree: {e}");
        }
    }

    Ok(())
}

fn cmd_projects() -> Result<(), String> {
    state::with_locked_state_read(|app_state| {
        for proj in &app_state.projects {
            let wt_count = proj.worktrees.len();
            println!(
                "{}\t{}\t{} worktree{}",
                proj.name,
                proj.path,
                wt_count,
                if wt_count == 1 { "" } else { "s" }
            );
        }
        Ok(())
    })
}
