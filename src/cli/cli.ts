import {
  readdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from "fs";
import { basename, dirname, join, relative, isAbsolute } from "path";
import { compiler } from "../compiler/index.js";
import { isParseError } from "../parser/index.js";

export type UserConfig = Partial<Config>;

type Config = {
  /** Directory to search for `.ets` templates when no files are passed. */
  source: string;
  /**
   * Directory to write generated `.ts` files into. When unset, each file is
   * written next to its template (`<template>.ts`).
   */
  outDir?: string;
  /**
   * Base directory used to preserve the input tree structure underneath
   * `outDir`. When unset, generated files are flattened into `outDir` by
   * basename. Only meaningful together with `outDir`.
   */
  root?: string;
  /**
   * Explicit list of `.ets` files to compile. When empty, `source` is
   * searched recursively.
   */
  files: string[];
};

type Args = {
  flags: Record<string, string | undefined>;
  positionals: string[];
};

const HELP = `Usage: ets [options] [files...]

Compiles embedded-typescript (.ets) templates to .ts modules.

Arguments:
  files          Explicit .ets files to compile. When omitted, the source
                 directory is searched recursively for .ets files.

Options:
  --source <dir>   Directory searched for .ets files when no files are passed.
                   Defaults to the current working directory.
  --out-dir <dir>  Directory to write generated .ts files into. When omitted,
                   each file is written next to its template.
  --root <dir>     Base directory used to preserve the input tree structure
                   underneath --out-dir. When omitted, outputs are flattened
                   into --out-dir by basename. Only meaningful with --out-dir.
  --help           Show this message.
`;

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | undefined> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }

    // Boolean flag (e.g. --help) or a `--flag value` pair. We treat the next
    // argument as the value unless it looks like another flag.
    const hasValue = i + 1 < argv.length && !argv[i + 1].startsWith("--");
    if (hasValue) {
      flags[body] = argv[i + 1];
      i++;
    } else {
      flags[body] = "";
    }
  }

  return { flags, positionals };
}

function getConfigFilePath(): string | undefined {
  const cwd = process.cwd();
  for (const ext of [".js", ".mjs", ".cjs"]) {
    const path = join(cwd, "ets.config") + ext;
    if (existsSync(path)) {
      return path;
    }
  }
}

async function getConfig(args: Args): Promise<Config> {
  const cwd = process.cwd();

  const defaultConfig: Config = {
    source: cwd,
    files: [],
  };

  const configFilePath = getConfigFilePath();
  let userConfig: UserConfig = {};
  if (configFilePath) {
    console.info(`Using configuration file at '${configFilePath}'.`);
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      userConfig = (await import(configFilePath)).default;
    } catch (e) {
      console.error(`Failed to load configuration file:`);
      console.log(e);
      process.exit(1);
    }

    const unknownKeys = Object.keys(userConfig).filter(
      // eslint-disable-next-line no-prototype-builtins
      (key) => !defaultConfig.hasOwnProperty(key)
    );
    if (unknownKeys.length) {
      console.warn(
        `Found unknown configuration options: ${unknownKeys
          .map((k) => `'${k}'`)
          .join(", ")}.`
      );
    }
    console.info();
  }

  // Command line flags take precedence over the configuration file.
  const cliConfig: UserConfig = {};
  if (args.flags.source !== undefined) {
    cliConfig.source = args.flags.source;
  }
  if (args.flags["out-dir"] !== undefined) {
    cliConfig.outDir = args.flags["out-dir"];
  }
  if (args.flags.root !== undefined) {
    cliConfig.root = args.flags.root;
  }
  if (args.positionals.length) {
    cliConfig.files = args.positionals;
  }

  return {
    ...defaultConfig,
    ...userConfig,
    ...cliConfig,
  };
}

function findFiles(entry: string, ext: string): string[] {
  return readdirSync(entry)
    .flatMap((file) => {
      const filepath = join(entry, file);
      if (statSync(filepath).isDirectory()) {
        return findFiles(filepath, ext);
      }
      return filepath;
    })
    .filter((file) => file.endsWith(ext));
}

/**
 * Resolves the output path for a template.
 *
 * - No `outDir`: written next to the template (`<template>.ts`).
 * - `outDir` without `root`: flattened into `outDir` by basename.
 * - `outDir` with `root`: the template's path relative to `root` is preserved
 *   underneath `outDir`.
 */
function destFor(template: string, config: Config): string {
  const { outDir, root } = config;
  if (outDir === undefined) {
    return template + ".ts";
  }

  if (root === undefined) {
    return join(outDir, basename(template)) + ".ts";
  }

  const rel = relative(root, template);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Template '${template}' is not contained within --root '${root}'. ` +
        `Either widen --root or drop it to flatten outputs into --out-dir.`
    );
  }
  return join(outDir, rel) + ".ts";
}

export async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help !== undefined) {
    console.log(HELP);
    return;
  }

  const config = await getConfig(args);
  const templates = config.files.length
    ? config.files
    : findFiles(config.source, ".ets");

  // Guard against two templates resolving to the same output file, which would
  // otherwise silently clobber one another (e.g. flattening same-named files
  // from different directories).
  const destinations = new Map<string, string>();
  for (const template of templates) {
    let dest: string;
    try {
      dest = destFor(template, config);
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
    const existing = destinations.get(dest);
    if (existing !== undefined) {
      console.error(
        `error: '${template}' and '${existing}' both compile to '${dest}'.`
      );
      process.exit(1);
    }
    destinations.set(dest, template);
  }

  const created = new Set<string>();
  const updated = new Set<string>();
  const unchanged = new Set<string>();
  templates.forEach((template) => {
    const destFile = destFor(template, config);
    const templatePath = `./${basename(template)}`;
    const out = compiler(readFileSync(template, "utf8"), templatePath);
    if (isParseError(out)) {
      console.error(`error: ${out.error}`);
      console.error(
        `   --> ${templatePath}:${out.position.start.line}:${out.position.start.column}`
      );
      console.error(out.context);
      console.warn();
      return;
    }

    function writeFileIfChange(filepath: string, contents: string): void {
      mkdirSync(dirname(filepath), { recursive: true });
      if (!existsSync(filepath)) {
        writeFileSync(filepath, contents);
        created.add(filepath);
      } else if (contents !== readFileSync(filepath).toString()) {
        writeFileSync(filepath, contents);
        updated.add(filepath);
      } else {
        unchanged.add(filepath);
      }
    }

    writeFileIfChange(destFile, out);
  });

  if (created.size) {
    console.log(
      `Created:
${Array.from(created)
  .sort()
  .map((name) => ` - ${name}`)
  .join("\n")}
`
    );
  }

  if (updated.size) {
    console.log(
      `Updated:
${Array.from(updated)
  .sort()
  .map((name) => ` - ${name}`)
  .join("\n")}
`
    );
  }

  if (unchanged.size) {
    console.log(`Unchanged: ${unchanged.size}`);
  }
}
