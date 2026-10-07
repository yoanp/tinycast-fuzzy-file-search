import { execFile } from "child_process";
import fs from "fs";
import path from "path";

// Tinycast is a GUI app, so its PATH usually lacks Homebrew. Check the Homebrew
// prefixes first (Apple Silicon, then Intel), then whatever PATH we were given.
const KNOWN_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

export const MISSING_CLI_MESSAGE = "fd and fzf are required. Install them with: brew install fd fzf";

export class MissingCliError extends Error {
  constructor(name: string) {
    super(`'${name}' was not found. ${MISSING_CLI_MESSAGE}`);
    this.name = "MissingCliError";
  }
}

function isExecutableFile(filepath: string): boolean {
  try {
    return fs.statSync(filepath).isFile();
  } catch {
    return false;
  }
}

export function findExecutable(name: string): string {
  const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of [...KNOWN_BIN_DIRS, ...pathDirs]) {
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  throw new MissingCliError(name);
}

export class ShellError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | string | undefined,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ShellError";
  }
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Runs `script` with `/bin/sh -c`, passing `args` as positional parameters ($1, $2, ...)
 * so user input never gets interpolated into the script text.
 *
 * Tinycast's child_process shim ignores the `stdio` and `signal` options and hands back
 * stdout only once the process exits. So every redirection (index file in, index file out,
 * result cap) has to happen inside the script, and cancellation is done with kill().
 */
export function runShell(
  script: string,
  args: string[],
  options: { cwd?: string; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  const { cwd, signal } = options;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const child = execFile(
      "/bin/sh",
      ["-c", script, "sh", ...args],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        signal?.removeEventListener?.("abort", onAbort);
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");
        if (error) {
          const code = (error as { code?: number | string }).code;
          reject(new ShellError(`Exit code ${code}: ${err.trim() || error.message}`, code, err));
          return;
        }
        resolve({ stdout: out, stderr: err });
      },
    );

    function onAbort() {
      child.kill("SIGTERM");
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

// On SIGTERM, kill the pipeline started in the background below. The pipeline has to run
// in the background with `wait`, otherwise sh would only run the trap after it finished.
const KILL_CHILDREN_ON_TERM = `trap '/usr/bin/pkill -TERM -P $$ 2>/dev/null; [ -n "$tmp" ] && /bin/rm -f "$tmp"; exit 143' TERM`;

// $1 = final index file, $2 = temp file, $3... = fd executable and arguments.
// fd writes straight to disk; the index never passes through extension memory.
const FD_INDEX_SCRIPT = `${KILL_CHILDREN_ON_TERM}
out="$1"; tmp="$2"; shift 2
"$@" > "$tmp" &
wait $!
status=$?
if [ "$status" -ne 0 ]; then /bin/rm -f "$tmp"; exit "$status"; fi
/bin/mv -f "$tmp" "$out"`;

export function buildFdIndex(
  fdPath: string,
  fdArgs: string[],
  outputFile: string,
  tempFile: string,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  // Anchored patterns in --ignore-file are resolved against the cwd. Running from "/"
  // makes absolute patterns like "/Users/me/Library/*" match what they say.
  return runShell(FD_INDEX_SCRIPT, [outputFile, tempFile, fdPath, ...fdArgs], { cwd: "/", signal });
}

// $1 = fzf, $2 = query, $3 = index file, $4 = max results.
// `head` caps the output inside the pipeline, because Tinycast only returns stdout once
// the process exits and we cannot stop reading after N lines like upstream did.
const FZF_FILTER_SCRIPT = `${KILL_CHILDREN_ON_TERM}
"$1" --read0 --scheme=path --filter "$2" < "$3" | /usr/bin/head -n "$4" &
wait $!`;

export async function filterIndex(
  fzfPath: string,
  query: string,
  indexFile: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const { stdout, stderr } = await runShell(FZF_FILTER_SCRIPT, [fzfPath, query, indexFile, String(maxResults)], {
    signal,
  });
  // The pipeline's exit code is head's, so fzf failures only show up on stderr.
  // fzf prints nothing to stderr when there are simply no matches.
  if (!stdout && stderr.trim()) {
    throw new ShellError(`fzf failed: ${stderr.trim()}`, undefined, stderr);
  }
  return stdout.split("\n").filter(Boolean).slice(0, maxResults);
}
