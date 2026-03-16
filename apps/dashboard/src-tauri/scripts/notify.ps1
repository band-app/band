# Band hook for Claude Code on Windows - reports agent status changes
# This script is called by Claude Code lifecycle hooks.
# It looks up workspace identity from ~/.band/state.json and writes status to ~/.band/status/

$ErrorActionPreference = "Stop"

# Read hook input from stdin (Claude Code passes JSON with hook_event_name)
try {
    $stdinText = @($input) -join "`n"
    $parsed = $stdinText | ConvertFrom-Json
    $hookEvent = $parsed.hook_event_name
} catch {
    exit 0
}

if (-not $hookEvent) {
    exit 0
}

$stateFile = Join-Path $env:USERPROFILE ".band" "state.json"
$currentDir = (Get-Location).Path

# Look up project and branch from state.json (single source of truth)
$project = $null
$branch = $null
$worktreePath = $null

if (Test-Path $stateFile) {
    try {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json
        $resolvedCwd = (Resolve-Path $currentDir).Path.TrimEnd('\')
        foreach ($proj in $state.projects) {
            foreach ($wt in $proj.worktrees) {
                $wtPath = (Resolve-Path $wt.path -ErrorAction SilentlyContinue).Path.TrimEnd('\')
                if ($wtPath -and ($resolvedCwd -eq $wtPath -or $resolvedCwd.StartsWith("$wtPath\"))) {
                    $project = $proj.name
                    $branch = $wt.branch
                    $worktreePath = $wt.path
                    break
                }
            }
            if ($project) { break }
        }
    } catch {
        # Ignore parse errors
    }
}

if (-not $project -or -not $branch) {
    exit 0
}

$workspaceId = "$project-$($branch -replace '/', '-')"
$statusDir = Join-Path $env:USERPROFILE ".band" "status"
$statusFile = Join-Path $statusDir "$workspaceId.json"

# Map hook event to agent status
switch ($hookEvent) {
    "UserPromptSubmit"    { $status = "working" }
    "PostToolUse"         { $status = "working" }
    "PostToolUseFailure"  { $status = "working" }
    "Stop"                { $status = "needs_attention" }
    "PermissionRequest"   { $status = "needs_attention" }
    default               { exit 0 }
}

$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")

if (-not (Test-Path $statusDir)) {
    New-Item -ItemType Directory -Path $statusDir -Force | Out-Null
}

if (Test-Path $statusFile) {
    # Atomic update: read, modify, write to temp, then move
    try {
        $existing = Get-Content $statusFile -Raw | ConvertFrom-Json
        $existing.agent.status = $status
        $existing.agent.lastActivity = $now
        $tmpFile = Join-Path $statusDir ".tmp.$([System.IO.Path]::GetRandomFileName())"
        $existing | ConvertTo-Json -Depth 10 | Set-Content $tmpFile -Encoding UTF8
        Move-Item -Path $tmpFile -Destination $statusFile -Force
    } catch {
        # Ignore update errors
    }
} else {
    $statusObj = @{
        workspaceId = $workspaceId
        project = $project
        branch = $branch
        worktreePath = $worktreePath
        ide = "vscode"
        agent = @{
            name = "claude-code"
            status = $status
            lastActivity = $now
        }
    }
    $statusObj | ConvertTo-Json -Depth 10 | Set-Content $statusFile -Encoding UTF8
}
