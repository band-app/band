---
name: web-test
description: Test the Band web application by starting the dev server, navigating pages, and taking screenshots using agent-browser. Use when the user asks to "test the web app", "take screenshots of the app", "check how the app looks", "visual test", "test the UI", or "screenshot the pages".
allowed-tools: Bash(pnpm dev:web*), Bash(lsof *), Bash(kill *), Bash(npx agent-browser:*), Bash(agent-browser:*), Bash(curl *), Read
---

# Web App Testing with Screenshots

Test the Band web application by starting the dev server and using `agent-browser` to navigate pages and capture screenshots.

## Steps

### 1. Start the dev server and detect the port

Run from the repo root (`/Users/amirilovic/Projects/band`). Do NOT kill any existing server — Vite will automatically pick another port if 3456 is occupied.

```bash
pnpm dev:web &
```

**IMPORTANT:** Read the Vite startup output and parse the actual port from the `Local:` line, e.g.:

```
  Local:   http://localhost:3456/
```

or if 3456 was busy:

```
  Local:   http://localhost:3457/
```

Use whatever port Vite reports for all subsequent steps. Do NOT hardcode 3456.

Wait for the server to be ready by polling the detected port:

```bash
for i in $(seq 1 30); do
  curl -sf http://localhost:<PORT> > /dev/null 2>&1 && break
  sleep 1
done
```

If it does not respond after 30 seconds, report an error and stop.

### 2. Navigate and take screenshots

Use `agent-browser` to open pages and capture screenshots. Always wait for the page to fully load before taking a screenshot.

Use the port detected in step 1 for all URLs.

**Desktop viewport (default 1280x720):**

```bash
agent-browser open http://localhost:<PORT> && agent-browser wait --load networkidle && agent-browser screenshot desktop-dashboard.png
```

**Mobile viewport (375x812):**

```bash
agent-browser set viewport 375 812
agent-browser open http://localhost:<PORT> && agent-browser wait --load networkidle && agent-browser screenshot mobile-dashboard.png
```

### Key routes to test

Adjust based on what the user asks. Common routes:

| Route | Description |
|-------|-------------|
| `/` | Dashboard — project list |
| `/chat/<workspaceId>` | Workspace chat view |
| `/tasks` | Tasks page |
| `/cronjobs` | Cronjobs page |

To find valid workspace IDs for the chat route, first snapshot the dashboard and look for project links.

### 3. Interactive testing

If the user asks to test interactions (clicking, filling forms), use the standard agent-browser workflow:

```bash
agent-browser snapshot -i          # Get interactive element refs
agent-browser click @e1            # Interact using refs
agent-browser wait --load networkidle
agent-browser snapshot -i          # Re-snapshot after interaction
```

### 4. Report results

After capturing screenshots:
- Show the file paths of all screenshots taken
- Use the Read tool to display screenshots to the user
- Note any visual issues observed (broken layouts, overflow, missing content)

### 5. Cleanup

When done, always close the browser session and stop the dev server (using the port from step 1):

```bash
agent-browser close
kill $(lsof -ti:<PORT>) 2>/dev/null
```

## Tips

- Use `--color-scheme dark` if the app uses dark mode by default (Band does)
- Use `agent-browser screenshot --full` for full-page screenshots
- Use `agent-browser screenshot --annotate` to get numbered labels on interactive elements
- For responsive testing, test at multiple viewports: desktop (1280x720), tablet (768x1024), mobile (375x812)
- If the server requires authentication, the dev server on port 3456 typically runs without auth in development mode
