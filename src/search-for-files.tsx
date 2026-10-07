import { ActionPanel, List, Action, getPreferenceValues, environment, showToast, Toast, Icon } from "@raycast/api";
import { useCachedPromise, useCachedState, usePromise } from "@raycast/utils";
import path, { basename } from "path";
import { useEffect, useMemo, useRef, useState } from "react";
import { FdIndexType, parseSearchQuery } from "./lib/parse-search-query";
import os from "os";
import fs from "fs";
import afs from "fs/promises";
import assert from "assert";
import sanitizeFilename from "sanitize-filename";
import { randomInt, randomUUID } from "crypto";
import { buildFdIndex, filterIndex, findExecutable, MISSING_CLI_MESSAGE, MissingCliError } from "./lib/cli";

type Prefs = {
  includeDirectories: boolean;
  includeHidden: boolean;
  ignoreSpacesInSearch: boolean;
  followSymlinks: boolean;
  customSearchDirs: string;
};

const MAX_FZF_RESULTS = 200;
const FZF_DEBOUNCE_MS = 200;

// Kept in the extension's support directory and passed with --ignore-file, so the user's
// global ~/.config/fd/ignore is left alone. Anchored patterns are resolved against "/"
// (fd runs with cwd "/"), so absolute paths work as written.
function fdIgnorePatterns(home: string): string[] {
  return [
    "/nix/",
    "/System/",
    "/Library/",
    "/private/",
    "/usr/",
    path.join(home, "Library/*"),
    `!${path.join(home, "Library/CloudStorage/")}`,
    "*.photoslibrary/",
  ];
}

export default function Command() {
  const abortableFd = useRef<AbortController>(new AbortController());
  const abortableFzf = useRef<AbortController>(new AbortController());
  const prefs = getPreferenceValues<Prefs>();

  const [searchText, setSearchText] = useState("");
  const [searchRoot, setSearchRoot] = useCachedState<string>("searchRootKey", os.homedir());
  const parsedSearch = useMemo(
    () => parseSearchQuery(searchText, prefs.ignoreSpacesInSearch, os.homedir()),
    [searchText, prefs.ignoreSpacesInSearch],
  );
  const [debouncedQuery, setDebouncedQuery] = useState(parsedSearch.query);
  const [resultsIndexType, setResultsIndexType] = useState<FdIndexType | null>(null);
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(parsedSearch.query), FZF_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [parsedSearch.query]);
  useEffect(() => {
    setResultsIndexType(null);
  }, [parsedSearch.indexType]);

  // Locate the Homebrew-installed fd and fzf. Not cached, so installing them later is
  // picked up the next time the command opens.
  const { data: cli, error: cliError } = usePromise(
    async () => ({ fd: findExecutable("fd"), fzf: findExecutable("fzf") }),
    [],
    {
      onError: (error) => {
        if (error instanceof MissingCliError) {
          showToast({
            style: Toast.Style.Failure,
            title: "fd and fzf are required",
            message: "Install them with: brew install fd fzf",
          });
        } else {
          showToast({ style: Toast.Style.Failure, title: "Couldn't locate fd/fzf", message: String(error) });
        }
      },
    },
  );
  const fdPath = cli?.fd;
  const fzfPath = cli?.fzf;

  // cleanup old .temp files (older than 10min)
  // In this extension when user exits during indexing, it will leave
  // temp files behind.
  // The cleanup needs to be done on mount as the launcher may kill the
  // extension without calling unmount functions nor sending signals when user exits extension.
  // Issue #2022
  useEffect(() => {
    let canceled = false;
    const CutoffMs = 10 * 60 * 1000;
    const now = Date.now();

    (async () => {
      const allFiles = await afs.readdir(environment.supportPath);
      const tempFiles = allFiles.filter((f) => f.endsWith(".temp"));
      for (const filename of tempFiles) {
        if (canceled) break;

        const filepath = path.join(environment.supportPath, filename);
        const stats = await afs.stat(filepath);

        const ageMs = now - (stats.mtimeMs || stats.birthtimeMs);
        if (ageMs > CutoffMs) {
          console.log(`temp file age: ${ageMs.toFixed(0)}ms, removing ${filepath}`);
          await afs.rm(filepath, {
            force: true,
          });
        }
      }
    })().catch((error) => console.error(`temp file cleanup failed: ${error}`));

    return () => {
      canceled = true;
    };
  }, []);

  // Get fdOutput filepath
  const { data: fdOutput, isLoading: isFdOutputLoading } = useCachedPromise(
    async (searchRoot?: string, fdPath?: string, indexType?: FdIndexType) => {
      assert(searchRoot !== undefined);
      assert(fdPath !== undefined);
      assert(indexType !== undefined);

      await afs.mkdir(environment.supportPath, { recursive: true });
      const ignoreFile = path.join(environment.supportPath, "fd-ignore");
      await afs.writeFile(ignoreFile, fdIgnorePatterns(os.homedir()).join("\n") + "\n");

      let optionalArgs: string[] = ["--ignore-file", ignoreFile];
      if (indexType === "directory") {
        optionalArgs = [...optionalArgs, "--type", "d"];
      } else if (indexType === "file") {
        optionalArgs = [...optionalArgs, "--type", "f"];
      } else if (!prefs.includeDirectories) {
        optionalArgs = [...optionalArgs, "--type", "file"];
      }
      if (prefs.includeHidden) {
        optionalArgs = [...optionalArgs, "--hidden"];
      }
      if (prefs.followSymlinks) {
        optionalArgs = [...optionalArgs, "--follow"];
      }

      const searchDirs = searchRoot.split(" ").filter(Boolean);

      // Final file fzf is reading from
      const fdOutput = path.join(environment.supportPath, `fd-out-${sanitizeFilename(searchRoot)}-${indexType}.txt`);
      // File to write to during the indexing
      const fdOutputTemp = `${fdOutput}.${Date.now()}${randomInt(10000)}.temp`;

      const toast = await showToast({
        title: "Indexing",
        style: Toast.Style.Animated,
      });
      if (fs.existsSync(fdOutput)) {
        toast.message = "updating index of files using fd";
      } else {
        toast.message = "creating index of files using fd";
      }

      try {
        await buildFdIndex(
          fdPath,
          [...optionalArgs, "--print0", ".", ...searchDirs],
          fdOutput,
          fdOutputTemp,
          abortableFd.current?.signal,
        );
      } finally {
        toast.hide();
      }

      return { filepath: fdOutput, randomUUID: randomUUID(), indexType };
    },
    [searchRoot, fdPath, parsedSearch.indexType],
    {
      execute: searchRoot !== undefined && fdPath !== undefined,
      abortable: abortableFd,
      keepPreviousData: true,
    },
  );

  // Get filteredPaths from fzf output.
  // usePromise drops results from superseded calls, and aborting kills the previous fzf.
  const { data: filteredPaths, isLoading: isFilteredPathsLoading } = usePromise(
    async (query: string, fzfPath?: string, fdOutput?: string, _?: string) => {
      assert(fzfPath !== undefined);
      assert(fdOutput !== undefined);
      assert(_ !== undefined); // required by linter

      if (!query) {
        return [];
      }

      // Results are capped inside the shell pipeline: memory limits would otherwise
      // terminate the extension on short queries. Issue #21580
      const filteredResults = await filterIndex(
        fzfPath,
        query,
        fdOutput,
        MAX_FZF_RESULTS,
        abortableFzf.current?.signal,
      );
      console.log(`fzf returned ${filteredResults.length} results`);
      return filteredResults;
    },
    // randomUUID is used to trigger fzf on updated index list from fd
    [debouncedQuery, fzfPath, fdOutput?.filepath, fdOutput?.randomUUID],
    {
      execute:
        fzfPath !== undefined &&
        fdOutput !== undefined &&
        !isFdOutputLoading &&
        fdOutput.indexType === parsedSearch.indexType &&
        debouncedQuery.length > 0,
      abortable: abortableFzf,
      onData: () => {
        setResultsIndexType(parsedSearch.indexType);
      },
    },
  );

  const isIndexReady = fdOutput !== undefined && fdOutput.indexType === parsedSearch.indexType;
  const isResultsCurrent = resultsIndexType === parsedSearch.indexType;
  const displayPaths = debouncedQuery && isIndexReady && isResultsCurrent ? filteredPaths : undefined;
  const homeDir = os.homedir();

  return (
    <List
      navigationTitle="Search Files"
      isLoading={
        (cli === undefined && cliError === undefined) ||
        isFdOutputLoading ||
        isFilteredPathsLoading ||
        (cli !== undefined && debouncedQuery.length > 0 && (!isIndexReady || !isResultsCurrent))
      }
      searchBarPlaceholder={"Search files — use -d or -f for directories/files only"}
      onSearchTextChange={setSearchText}
      filtering={false} // disable builtin filtering as we use a custom one
      searchBarAccessory={
        <List.Dropdown tooltip="Search" value={searchRoot} onChange={setSearchRoot}>
          <List.Dropdown.Item title="Home (~)" value={homeDir} />
          <List.Dropdown.Item title="Everything (/)" value={"/"} />
          <List.Dropdown.Item title={`Custom Directories`} value={prefs.customSearchDirs} />
        </List.Dropdown>
      }
    >
      {cliError ? (
        <List.EmptyView
          icon={Icon.ExclamationMark}
          title="fd and fzf are required"
          description={cliError instanceof MissingCliError ? MISSING_CLI_MESSAGE : String(cliError)}
        />
      ) : null}
      {displayPaths?.map((filepath) => {
        const filename = basename(filepath);
        const isUnderHome = filepath === homeDir || filepath.startsWith(homeDir + path.sep);
        return (
          <List.Item
            key={filepath}
            title={isUnderHome ? "~" + filepath.slice(homeDir.length) : filepath}
            subtitle={filename}
            quickLook={{ path: filepath, name: filename }}
            actions={
              <ActionPanel>
                <Action.Open title="Open" target={filepath} />
                <Action.ShowInFinder title="Show in Finder" path={filepath} />
                <Action.OpenWith path={filepath} shortcut={{ modifiers: ["cmd"], key: "o" }} />
                <Action.CopyToClipboard
                  title="Copy Path to Clipboard"
                  content={filepath}
                  shortcut={{ modifiers: ["cmd"], key: "c" }}
                />
                <Action.ToggleQuickLook shortcut={{ modifiers: ["cmd"], key: "y" }} />
              </ActionPanel>
            }
          />
        );
      })}
    </List>
  );
}
