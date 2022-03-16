import { assertEquals, ensureFileSync, JSON5, path } from "./deps.ts";
import mask from "./lib/mask.ts";

const trace = false;
const debug = (msg: string) => {
  if (trace) {
    console.log(msg);
  }
};

type SnapshotFn = (actual: unknown, masks?: string[], name?: string) => void;

type ExecMode = "validate" | "update" | "refresh";

interface TestContext extends Deno.TestContext {
  assertSnapshot: SnapshotFn;
  execMode: ExecMode;
}

type Test = (t: TestContext) => void | Promise<void>;
type TestDefinition = Omit<Deno.TestDefinition, "fn"> & {
  fn: Test;
};

/**
 * Wraps Deno.test so the test function accepts an argument of TestContext.
 * TestContext provides a test specific "assertSnapshot" function that can be used to
 */
interface SnapTestFn {
  (
    nameOrDef: string | TestDefinition,
    fn?: (t: TestContext) => void,
  ): void | Promise<void>;
}
function compose(): SnapTestFn {
  const execMode = snapshotMode();
  debug(`execMode: ${execMode}`);

  const contextMap: Record<string, boolean> = {};
  const snapshotsHaveUpdates: Record<string, boolean> = {};
  let count = 0;
  const getCount = () => ++count;
  const resetCount = () => {
    count = 0;
  };

  function readSnapshotsFromDisk(snapshotFile: string) {
    if (0 === Object.keys(contextMap).length && execMode === "refresh") {
      // First assertSnapshot in a given file and in refresh mode.
      // Empty the assertSnapshot file, clears any unused snapshots.
      // Clears any unused snapshots.
      Deno.writeTextFileSync(snapshotFile, JSON5.stringify({}));
      snapshotsHaveUpdates[snapshotFile] = true;
      return {};
    }
    ensureFileSync(snapshotFile);
    return JSON5.parse(Deno.readTextFileSync(snapshotFile) || `{}`);
  }

  return (nameOrFn, fn) => {
    // @TODO: Fix this weird typing
    const testDefinition = typeof nameOrFn === "string"
      ? { name: nameOrFn, fn: fn! }
      : nameOrFn;

    const assertSnapshot: SnapshotFn = (actual, masks = [], title) => {
      const snapshotFile = getSnapshotFileName();
      const snapshots = readSnapshotsFromDisk(snapshotFile);
      if (!Object.keys(contextMap).includes(testDefinition.name)) {
        resetCount();
      }

      const c = getCount();
      title = title && title !== testDefinition.name
        ? title
        : c === 1
        ? testDefinition.name
        : `${testDefinition.name}:#${c}`;
      debug(`\n Snapshot: ${title} ${c}`);
      if (Object.keys(contextMap).includes(title)) {
        throw new Error(
          `Duplicate assertSnapshot title - ${title} ${c} ${nameOrFn}\n`,
        );
      }
      const expected = snapshots[title] ?? null;
      const _actual = mask(actual, masks);
      contextMap[title] = true;
      switch (execMode) {
        case "refresh": {
          // if first attempt, delete
          snapshots[title] = _actual;
          snapshotsHaveUpdates[snapshotFile] = true;
          break;
        }
        case "validate": {
          if (expected) {
            compareSnapshots(_actual, expected, title);
          } else {
            snapshots[title] = _actual;
            snapshotsHaveUpdates[snapshotFile] = true;
          }
          break;
        }
        case "update": {
          try {
            compareSnapshots(_actual, expected, title);
          } catch {
            // There was assertSnapshot mismatch, but we are in update mode.
            // Prevents updating the file needlessly, reducing disk IO.
            snapshots[title] = _actual;
            snapshotsHaveUpdates[snapshotFile] = true;
          }
          break;
        }
      }
      Deno.writeTextFileSync(
        snapshotFile,
        JSON5.stringify(
          Object.fromEntries(
            Object.entries(snapshots).sort(([a], [b]) => {
              return a < b ? -1 : 1;
            }),
          ),
          { space: 2 },
        ),
      );
    };

    const context = {
      name: testDefinition.name,
      assertSnapshot,
      execMode,
    };
    return Deno.test({
      ...testDefinition,
      fn: (testContext: Deno.TestContext) =>
        testDefinition.fn({ ...context, ...testContext }),
    });
  };
}
export const test = compose();
export default test;

function getSnapshotFileName() {
  const testFile = path.fromFileUrl(Deno.mainModule);
  const parts = path.parse(testFile);
  return `${parts.dir}/${parts.name}.snap`;
}

/**
 * Given an input of Deno.args, determines update mode.
 * Usage: `snapshotMode(Deno.args)`
 */
export function snapshotMode(args: string[] = Deno.args): ExecMode {
  if (args.includes("-u") || args.includes("--update")) {
    return "update";
  }
  if (args.includes("-r") || args.includes("--refresh")) {
    return "refresh";
  }
  return "validate";
}

export function compareSnapshots(
  actual: unknown,
  expected: unknown,
  title: string,
) {
  try {
    // stringify+parse to ensure that "undefined" fields are removed.
    // `expected` has been through this process
    actual = JSON5.parse(JSON5.stringify(actual));
    assertEquals(actual, expected);
  } catch (err) {
    const message = `Snapshot mismatch:\n  ${title}\n  ${
      err.message
        .split("\n")
        .join("\n  ")
    }`;
    throw new Error(message);
  }
}
