import * as cp from "child_process";
import { readFile, rm, rmSync } from "fs";
import { basename, resolve, sep } from "path";
import { promisify } from "util";
import { Target } from "@winglang/compiler";
import { std, simulator } from "@winglang/sdk";
import chalk from "chalk";
import debug from "debug";
import { nanoid } from "nanoid";
import { compile, CompileOptions } from "./compile";
import { generateTmpDir, withSpinner } from "../util";

const log = debug("wing:test");

const ENV_WING_TEST_RUNNER_FUNCTION_ARNS = "WING_TEST_RUNNER_FUNCTION_ARNS";
const ENV_WING_TEST_RUNNER_FUNCTION_ARNS_AWSCDK = "WingTestRunnerFunctionArns";

/**
 * @param path path to the test/s file
 * @returns the file name and parent dir in the following format: "folder/file.ext"
 */
const generateTestName = (path: string) => path.split(sep).slice(-2).join("/");

/**
 * Options for the `test` command.
 */
export interface TestOptions extends CompileOptions {
  clean: boolean;
}

export async function test(entrypoints: string[], options: TestOptions): Promise<number> {
  const startTime = Date.now();
  const results: { testName: string; results: std.TestResult[] }[] = [];
  const testFile = async (entrypoint: string) => {
    const testName = generateTestName(entrypoint);
    try {
      const singleTestResults: std.TestResult[] | void = await testOne(entrypoint, options);
      results.push({ testName, results: singleTestResults ?? [] });
    } catch (error) {
      console.log((error as Error).message);
      results.push({
        testName: generateTestName(entrypoint),
        results: [{ pass: false, path: "", error: (error as Error).message, traces: [] }],
      });
    }
  };
  await Promise.all(entrypoints.map(testFile));
  printResults(results, Date.now() - startTime);

  // if we have any failures, exit with 1
  for (const testSuite of results) {
    for (const r of testSuite.results) {
      if (r.error) {
        return 1;
      }
    }
  }

  return 0;
}

function printResults(
  testResults: { testName: string; results: std.TestResult[] }[],
  duration: number
) {
  const durationInSeconds = duration / 1000;
  const totalSum = testResults.length;
  const failing = testResults.filter(({ results }) => results.some(({ pass }) => !pass));
  const passing = testResults.filter(({ results }) => results.every(({ pass }) => !!pass));
  const failingTestsNumber = failing.reduce(
    (acc, { results }) => acc + results.filter(({ pass }) => !pass).length,
    0
  );
  const passingTestsNumber = testResults.reduce(
    (acc, { results }) => acc + results.filter(({ pass }) => !!pass).length,
    0
  );
  console.log(" "); // for getting a new line- \n does't seem to work :(
  const areErrors = failing.length > 0 && totalSum > 1;
  const showTitle = totalSum > 1;

  const res = [];

  if (showTitle) {
    // prints a list of the tests names with an icon
    res.push(`Results:`);
    res.push(...passing.map(({ testName }) => `    ${chalk.green("✓")} ${testName}`));
    res.push(...failing.map(({ testName }) => `    ${chalk.red("×")} ${testName}`));
  }

  if (areErrors) {
    // prints error messages form failed tests
    res.push(" ");
    res.push("Errors:");
    res.push(
      ...failing.map(({ testName, results }) =>
        [
          `At ${testName}`,
          results.filter(({ pass }) => !pass).map(({ error }) => chalk.red(error)),
        ].join("\n")
      )
    );
  }

  // prints a summary of how many tests passed and failed
  res.push(" ");
  res.push(
    `${chalk.dim("Tests")}${failingTestsNumber ? chalk.red(` ${failingTestsNumber} failed`) : ""}${
      failingTestsNumber && passingTestsNumber ? chalk.dim(" |") : ""
    }${passingTestsNumber ? chalk.green(` ${passingTestsNumber} passed`) : ""} ${chalk.dim(
      `(${failingTestsNumber + passingTestsNumber})`
    )}`
  );
  // prints a summary of how many tests files passed and failed
  res.push(
    `${chalk.dim("Test Files")}${failing.length ? chalk.red(` ${failing.length} failed`) : ""}${
      failing.length && passing.length ? chalk.dim(" |") : ""
    }${passing.length ? chalk.green(` ${passing.length} passed`) : ""} ${chalk.dim(
      `(${totalSum})`
    )}`
  );

  // prints the test duration
  res.push(
    `${chalk.dim("Duration")} ${Math.floor(durationInSeconds / 60)}m${(
      durationInSeconds % 60
    ).toFixed(2)}s`
  );

  console.log(res.filter((value) => !!value).join("\n"));
}

async function testOne(entrypoint: string, options: TestOptions) {
  const synthDir = await withSpinner(
    `Compiling ${generateTestName(entrypoint)} to ${options.target}...`,
    async () =>
      compile(entrypoint, {
        ...options,
        rootId: options.rootId ?? `Test.${nanoid(10)}`,
        testing: true,
        // since the test cleans up after each run, it's essential to create a temporary output directory-
        // at least one that is different then the usual compilation output dir,  otherwise we might end up cleaning up the user's actual resources.
        ...(options.target !== Target.SIM && { targetDir: `${await generateTmpDir()}/target` }),
      })
  );

  switch (options.target) {
    case Target.SIM:
      return testSimulator(synthDir, options);
    case Target.TF_AWS:
      return testTfAws(synthDir, options);
    case Target.AWSCDK:
      return testAwsCdk(synthDir, options);
    default:
      throw new Error(`unsupported target ${options.target}`);
  }
}

/**
 * Render a test report for printing out to the console.
 */
export function renderTestReport(entrypoint: string, results: std.TestResult[]): string {
  const out = new Array<string>();

  // find the longest `path` of all the tests
  const longestPath = results.reduce(
    (longest, result) => (result.path.length > longest ? result.path.length : longest),
    0
  );

  // if there are no inflight tests, add a dummy "pass" result
  // to indicate that compilation and preflight checks passed
  if (results.length === 0) {
    results.push({
      pass: true,
      path: "",
      traces: [],
    });
  }

  for (const result of results.sort(sortTests)) {
    const status = result.pass ? chalk.green("pass") : chalk.red("fail");

    const details = new Array<string>();

    // add any log messages that were emitted during the test
    for (const trace of result.traces) {
      // only show detailed traces if we are in debug mode
      if (trace.type === "resource" && process.env.DEBUG) {
        details.push(chalk.gray("[trace] " + trace.data.message));
      }
      if (trace.type === "log") {
        details.push(chalk.gray(trace.data.message));
      }
    }

    // if the test failed, add the error message and trace
    if (result.error) {
      details.push(...result.error.split("\n").map((l) => chalk.red(l)));
    }

    // construct the first row of the test result by collecting the various components and joining
    // them with spaces.

    const firstRow = new Array<string>();
    firstRow.push(status);

    // if we have details, surround the rows with a box, otherwise, just print a line
    if (details.length > 0) {
      firstRow.push(chalk.gray("┌"));
    } else {
      firstRow.push(chalk.gray("─"));
    }

    firstRow.push(basename(entrypoint));

    if (result.path?.length > 0) {
      firstRow.push(chalk.gray("»"));
      firstRow.push(chalk.whiteBright(result.path.padEnd(longestPath)));
    } else {
      firstRow.push(chalk.gray("(no tests)"));
    }

    // okay we are ready to print the test result

    // print the primary description of the test
    out.push(firstRow.join(" "));

    // print additional rows that are related to this test
    for (let i = 0; i < details.length; i++) {
      const left = i === details.length - 1 ? "└" : "│";
      out.push(`    ${chalk.gray(` ${left} `)}${details[i]}`);
    }
  }

  return out.join("\n");
}

function testResultsContainsFailure(results: std.TestResult[]): boolean {
  return results.some((r) => !r.pass);
}

function noCleanUp(synthDir: string) {
  console.log(
    chalk.yellowBright.bold(`Cleanup is disabled!\nOutput files available at ${resolve(synthDir)}`)
  );
}

async function testSimulator(synthDir: string, options: TestOptions) {
  const s = new simulator.Simulator({ simfile: synthDir });
  const { clean } = options;
  await s.start();

  const testRunner = s.getResource("root/cloud.TestRunner") as std.ITestRunnerClient;
  const tests = await testRunner.listTests();
  const filteredTests = pickOneTestPerEnvironment(tests);
  const results = new Array<std.TestResult>();

  // TODO: run these tests in parallel
  for (const path of filteredTests) {
    results.push(await testRunner.runTest(path));
  }

  await s.stop();

  const testReport = renderTestReport(synthDir, results);
  console.log(testReport);

  if (clean) {
    rmSync(synthDir, { recursive: true, force: true });
  } else {
    noCleanUp(synthDir);
  }

  return results;
}

async function testAwsCdk(synthDir: string, options: TestOptions): Promise<std.TestResult[]> {
  const { clean } = options;
  try {
    await isAwsCdkInstalled(synthDir);

    await withSpinner("cdk deploy", () => awsCdkDeploy(synthDir));

    const [testRunner, tests] = await withSpinner("Setting up test runner...", async () => {
      const testArns = await awsCdkOutput(
        synthDir,
        ENV_WING_TEST_RUNNER_FUNCTION_ARNS_AWSCDK,
        process.env.CDK_STACK_NAME!
      );

      const { TestRunnerClient } = await import(
        "@winglang/sdk/lib/shared-aws/test-runner.inflight"
      );
      const runner = new TestRunnerClient(testArns);

      const allTests = await runner.listTests();
      return [runner, pickOneTestPerEnvironment(allTests)];
    });

    const results = await withSpinner("Running tests...", async () => {
      const res = new Array<std.TestResult>();
      for (const path of tests) {
        res.push(await testRunner.runTest(path));
      }
      return res;
    });

    const testReport = renderTestReport(synthDir, results);
    console.log(testReport);

    if (testResultsContainsFailure(results)) {
      console.log("One or more tests failed. Cleaning up resources...");
    }

    return results;
  } catch (err) {
    console.warn((err as Error).message);
    return [{ pass: false, path: "", error: (err as Error).message, traces: [] }];
  } finally {
    if (clean) {
      await cleanupCdk(synthDir);
    } else {
      noCleanUp(synthDir);
    }
  }
}

async function cleanupCdk(synthDir: string) {
  await withSpinner("aws-cdk destroy", () => awsCdkDestroy(synthDir));
  rmSync(synthDir, { recursive: true, force: true });
}

async function isAwsCdkInstalled(synthDir: string) {
  try {
    await execCapture("cdk version --ci true", { cwd: synthDir });
  } catch (err) {
    throw new Error(
      "AWS-CDK is not installed. Please install AWS-CDK to run tests in the cloud (npm i -g aws-cdk)."
    );
  }
}

export async function awsCdkDeploy(synthDir: string) {
  await execCapture("cdk deploy --require-approval never --ci true -O ./output.json --app . ", {
    cwd: synthDir,
  });
}

export async function awsCdkDestroy(synthDir: string) {
  const removeFile = promisify(rm);
  await removeFile(synthDir.concat("/output.json"));
  await execCapture("cdk destroy -f --ci true --app ./", { cwd: synthDir });
}

async function awsCdkOutput(synthDir: string, name: string, stackName: string) {
  const readFileCmd = promisify(readFile);
  const file = await readFileCmd(synthDir.concat("/output.json"));
  const parsed = JSON.parse(Buffer.from(file).toString());
  return parsed[stackName][name];
}

async function testTfAws(synthDir: string, options: TestOptions): Promise<std.TestResult[] | void> {
  const { clean } = options;
  try {
    if (!isTerraformInstalled(synthDir)) {
      throw new Error(
        "Terraform is not installed. Please install Terraform to run tests in the cloud."
      );
    }

    await withSpinner("terraform init", async () => terraformInit(synthDir));

    await withSpinner("terraform apply", () => terraformApply(synthDir));

    const [testRunner, tests] = await withSpinner("Setting up test runner...", async () => {
      const testArns = await terraformOutput(synthDir, ENV_WING_TEST_RUNNER_FUNCTION_ARNS);
      const { TestRunnerClient } = await import(
        "@winglang/sdk/lib/shared-aws/test-runner.inflight"
      );
      const runner = new TestRunnerClient(testArns);

      const allTests = await runner.listTests();
      return [runner, pickOneTestPerEnvironment(allTests)];
    });

    const results = await withSpinner("Running tests...", async () => {
      const res = new Array<std.TestResult>();
      for (const path of tests) {
        res.push(await testRunner.runTest(path));
      }
      return res;
    });

    const testReport = renderTestReport(synthDir, results);
    console.log(testReport);

    if (testResultsContainsFailure(results)) {
      console.log("One or more tests failed. Cleaning up resources...");
    }

    return results;
  } catch (err) {
    console.warn((err as Error).message);
    return [{ pass: false, path: "", error: (err as Error).message, traces: [] }];
  } finally {
    if (clean) {
      await cleanupTf(synthDir);
    } else {
      noCleanUp(synthDir);
    }
  }
}

async function cleanupTf(synthDir: string) {
  await withSpinner("terraform destroy", () => terraformDestroy(synthDir));
  rmSync(synthDir, { recursive: true, force: true });
}

async function isTerraformInstalled(synthDir: string) {
  const output = await execCapture("terraform version", { cwd: synthDir });
  return output.startsWith("Terraform v");
}

export async function terraformInit(synthDir: string) {
  return execCapture("terraform init", { cwd: synthDir });
}

async function terraformApply(synthDir: string) {
  return execCapture("terraform apply -auto-approve", { cwd: synthDir });
}

async function terraformDestroy(synthDir: string) {
  return execCapture("terraform destroy -auto-approve", { cwd: synthDir });
}

async function terraformOutput(synthDir: string, name: string) {
  const output = await execCapture("terraform output -json", { cwd: synthDir });
  const parsed = JSON.parse(output);
  if (!parsed[name]) {
    throw new Error(`terraform output ${name} not found`);
  }
  return parsed[name].value;
}

function pickOneTestPerEnvironment(testPaths: string[]) {
  // Given a list of test paths like so:
  //
  // root/Default/env0/a/b/test:test1
  // root/Default/env0/d/e/f/test:test2
  // root/Default/env0/g/test:test3
  // root/Default/env1/a/b/test:test1
  // root/Default/env1/d/e/f/test:test2
  // root/Default/env1/g/test:test3
  // root/Default/env2/a/b/test:test1
  // root/Default/env2/d/e/f/test:test2
  // root/Default/env2/g/test:test3
  //
  // This function returns a list of test paths which uses each test name
  // exactly once and each "env" exactly once. In this case, the result would
  // be:
  //
  // root/Default/env0/a/b/test:test1
  // root/Default/env1/d/e/f/test:test2
  // root/Default/env2/g/test:test3

  const tests = new Map<string, string>();
  const envs = new Set<string>();

  for (const testPath of testPaths) {
    const testSuffix = testPath.substring(testPath.indexOf("env") + 1); // "<env #>/<path to test>"
    const env = testSuffix.substring(0, testSuffix.indexOf("/")); // "<env #>"
    const testName = testSuffix.substring(testSuffix.indexOf("/") + 1); // "<path to test>"

    if (envs.has(env)) {
      continue;
    }

    if (tests.has(testName)) {
      continue;
    }

    tests.set(testName, testPath);
    envs.add(env);
  }

  return Array.from(tests.values());
}

function sortTests(a: std.TestResult, b: std.TestResult) {
  if (a.pass && !b.pass) {
    return -1;
  }
  if (!a.pass && b.pass) {
    return 1;
  }
  return a.path.localeCompare(b.path);
}

const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Executes command and returns STDOUT. If the command fails (non-zero), throws an error.
 */
async function execCapture(command: string, options: { cwd: string }) {
  log(command);
  const exec = promisify(cp.exec);
  const { stdout, stderr } = await exec(command, {
    cwd: options.cwd,
    maxBuffer: MAX_BUFFER,
  });
  if (stderr) {
    throw new Error(stderr);
  }
  log(stdout);
  return stdout;
}
