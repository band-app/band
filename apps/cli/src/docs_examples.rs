//! Checks the public docs against the CLI itself.
//!
//! - Every `band ...` command in a code block of a public docs page must parse with
//!   the clap definition in `main.rs`.
//! - The checked-in `cli-schema.json` that the website renders must equal the
//!   output of `band schema`.
//! - Every top-level command must be covered by a CLI reference page.

use super::Cli;
use clap::error::ErrorKind;
use clap::Parser;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn read_dir_files(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == ext))
        .collect();
    out.sort();
    out
}

/// A guide in `docs/` is a public page when its frontmatter has a `section`.
fn is_public_guide(text: &str) -> bool {
    text.strip_prefix("---\n")
        .and_then(|rest| rest.split("\n---").next())
        .is_some_and(|front| front.lines().any(|l| l.starts_with("section:")))
}

fn doc_files() -> Vec<PathBuf> {
    let root = repo_root();
    let mut files = Vec::new();
    for p in read_dir_files(&root.join("docs"), "md") {
        if is_public_guide(&fs::read_to_string(&p).unwrap()) {
            files.push(p);
        }
    }
    files.extend(read_dir_files(
        &root.join("apps/website/src/content/cli"),
        "md",
    ));
    for name in ["index", "faq", "comparison"] {
        files.push(root.join(format!("apps/website/src/pages/{name}.astro")));
    }
    files
}

/// Splits a shell line into words. Quotes group, `\` escapes, an unquoted `#` at the
/// start of a word ends the line. Returns the words and whether each was quoted.
fn split_words(line: &str) -> Vec<(String, bool)> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut in_word = false;
    let mut quote: Option<char> = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else if c == '\\' && q == '"' && matches!(chars.peek(), Some('"' | '\\' | '$')) {
                    cur.push(chars.next().unwrap());
                } else {
                    cur.push(c);
                }
            }
            None => match c {
                '\'' | '"' => {
                    quote = Some(c);
                    quoted = true;
                    in_word = true;
                }
                '\\' => {
                    if let Some(n) = chars.next() {
                        cur.push(n);
                        in_word = true;
                    }
                }
                '#' if !in_word => break,
                c if c.is_whitespace() => {
                    if in_word {
                        words.push((std::mem::take(&mut cur), quoted));
                        quoted = false;
                        in_word = false;
                    }
                }
                _ => {
                    cur.push(c);
                    in_word = true;
                }
            },
        }
    }
    if in_word {
        words.push((cur, quoted));
    }
    words
}

fn is_shell_operator(word: &str, quoted: bool) -> bool {
    !quoted
        && (matches!(word, "|" | "||" | "&&" | ";" | "&" | "<")
            || word.starts_with('>')
            || word.starts_with("2>")
            || word.starts_with("<<")
            || word.starts_with("&>"))
}

/// The `band` argument lists found in a text. Each is (line number, arguments).
fn examples(path: &Path, text: &str) -> Vec<(usize, Vec<String>)> {
    let astro = path.extension().is_some_and(|e| e == "astro");
    let mut lines: Vec<(usize, String)> = Vec::new();
    if astro {
        let mut inside = false;
        for (i, l) in text.lines().enumerate() {
            if l.contains("<pre") {
                inside = true;
            }
            if inside {
                let plain = decode(&strip_tags(l));
                lines.push((i + 1, plain));
            }
            if l.contains("</pre>") {
                inside = false;
            }
        }
    } else {
        let mut fence: Option<bool> = None;
        for (i, l) in text.lines().enumerate() {
            let t = l.trim_start();
            if let Some(info) = t.strip_prefix("```") {
                fence = match fence {
                    Some(_) => None,
                    None => Some(matches!(
                        info.trim(),
                        "sh" | "bash" | "shell" | "zsh" | "console"
                    )),
                };
            } else if fence == Some(true) {
                lines.push((i + 1, l.to_string()));
            }
        }
    }

    let mut out = Vec::new();
    let mut idx = 0;
    while idx < lines.len() {
        let (no, first) = lines[idx].clone();
        let mut joined = first.trim().to_string();
        while joined.ends_with('\\') && idx + 1 < lines.len() {
            joined.pop();
            idx += 1;
            joined.push(' ');
            joined.push_str(lines[idx].1.trim());
        }
        idx += 1;
        let joined = joined.strip_prefix("$ ").unwrap_or(&joined);
        let mut words = split_words(joined).into_iter().peekable();
        // Leading VAR=value assignments.
        while words.peek().is_some_and(|(w, q)| {
            !q && w.contains('=') && !w.starts_with('-') && !w.starts_with("band")
        }) {
            words.next();
        }
        if words.next().is_none_or(|(w, _)| w != "band") {
            continue;
        }
        let args: Vec<String> = words
            .take_while(|(w, q)| !is_shell_operator(w, *q))
            .map(|(w, _)| w)
            .collect();
        out.push((no, args));
    }
    out
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

fn decode(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

#[test]
fn docs_examples_parse() {
    let mut failures = Vec::new();
    let mut count = 0;
    for path in doc_files() {
        let text = fs::read_to_string(&path).unwrap();
        for (line, args) in examples(&path, &text) {
            count += 1;
            let mut argv = vec!["band".to_string()];
            argv.extend(args.iter().cloned());
            if let Err(e) = Cli::try_parse_from(&argv) {
                if matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) {
                    continue;
                }
                let first = e.to_string().lines().next().unwrap_or("").to_string();
                failures.push(format!(
                    "{}:{line}: band {}\n    {first}",
                    path.strip_prefix(repo_root()).unwrap().display(),
                    args.join(" ")
                ));
            }
        }
    }
    assert!(count > 0, "no band examples found; the extractor is broken");
    assert!(
        failures.is_empty(),
        "{} of {count} docs examples do not parse:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn website_schema_matches_the_cli() {
    let live = super::build_schema(None).unwrap();
    let path = repo_root().join("apps/website/src/data/cli-schema.json");
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(
        saved, live,
        "apps/website/src/data/cli-schema.json is stale. Run apps/website/scripts/gen-cli-schema.sh"
    );
}

#[test]
fn every_command_has_a_reference_page() {
    let live = super::build_schema(None).unwrap();
    let top: BTreeSet<String> = live["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            c["name"]
                .as_str()
                .unwrap()
                .split(' ')
                .next()
                .unwrap()
                .to_string()
        })
        .collect();
    let mut covered = BTreeSet::new();
    for p in read_dir_files(&repo_root().join("apps/website/src/content/cli"), "md") {
        let text = fs::read_to_string(p).unwrap();
        let front = text
            .strip_prefix("---\n")
            .unwrap()
            .split("\n---")
            .next()
            .unwrap()
            .to_string();
        for line in front.lines() {
            if let Some(list) = line.strip_prefix("commands:") {
                for c in list
                    .trim()
                    .trim_matches(|c| c == '[' || c == ']')
                    .split(',')
                {
                    let c = c.trim();
                    if !c.is_empty() {
                        covered.insert(c.to_string());
                    }
                }
            }
        }
    }
    let missing: Vec<_> = top.difference(&covered).collect();
    assert!(
        missing.is_empty(),
        "commands with no CLI reference page: {missing:?}"
    );
}
