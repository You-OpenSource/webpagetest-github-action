const WebPageTest = require("webpagetest");
const AdmZip = require("adm-zip");
const core = require("@actions/core");
const github = require("@actions/github");
const ejs = require("ejs");
const WPT_BUDGET = core.getInput("budget");
const WPT_OPTIONS = core.getInput("wptOptions");
const WPT_API_KEY = core.getInput("apiKey");
const WPT_URLS = core.getInput("urls").split("\n");
const WPT_LABEL = core.getInput("label");
const GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
const BASE_BRANCH = core.getInput("baseBranch") || "dev";
const fs = require("fs/promises");
const DIRECTORY = process.env.GITHUB_WORKSPACE;
const GH_EVENT_NAME = process.env.GITHUB_EVENT_NAME;
const METRICS = {
  TTFB: {
    label: "Time to First Byte",
    // i couldn't think of anything better to call it
    // if it's desc that means an decrease is good
    metricDir: "desc",
  },
  firstContentfulPaint: {
    label: "First Contentful Paint",
    metricDir: "desc",
  },
  TotalBlockingTime: {
    label: "Total Blocking Time",
    metricDir: "desc",
  },
  "chromeUserTiming.LargestContentfulPaint": {
    label: "Largest Contentful Paint",
    metricDir: "desc",
  },
  "chromeUserTiming.CumulativeLayoutShift": {
    label: "Cumulative Layout Shift",
    metricDir: "desc",
  },
};

const LIGHTHOUSE_METRICS = {
  "lighthouse.Performance": {
    label: "Performance",
    metricDir: "asc",
  },
  "lighthouse.Accessibility": {
    label: "Accessibility",
    metricDir: "asc",
  },
};

const STORED_METRIC_NAME = "perf-metrics.json";
const STORED_METRIC_DIRECTORY = `${DIRECTORY}/${STORED_METRIC_NAME}`;

const isReportSupported = () =>
  GH_EVENT_NAME == "pull_request" || GH_EVENT_NAME == "issue_comment";

const context = github.context;

let octokit;
octokit = new github.GitHub(GITHUB_TOKEN);

function extractZipAsync(AdmZipInstance) {
  return new Promise((resolve, reject) => {
    const entry = AdmZipInstance.getEntries()?.[0];
    AdmZipInstance.readAsTextAsync(entry.entryName, (data, error) => {
      if (error) {
        reject(error);
      } else {
        resolve(data);
      }
    });
  });
}

async function getDevMetrics() {
  try {
    core.info("Getting all artifacts");
    const results = await octokit.request(
      `GET /repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts?name=perf-metrics&per_page=100`,
      {
        owner: context.repo.owner,
        repo: context.repo.repo,
        headers: {
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    const artifacts = results?.data?.artifacts || [];
    core.info(`${artifacts?.length} artifacts found`);
    core.info("Getting latest artifact");
    const mostRecentBaseBranchArtifact = artifacts?.filter(
      ({ workflow_run }) => workflow_run.head_branch === BASE_BRANCH
    )?.[0];
    core.info(mostRecentBaseBranchArtifact);

    if (mostRecentBaseBranchArtifact?.id) {
      // we now want to download the artifact and it's JSON
      const zip = await octokit.actions.downloadArtifact({
        owner: context.repo.owner,
        repo: context.repo.repo,
        artifact_id: mostRecentBaseBranchArtifact.id,
        archive_format: "zip",
      });

      await fs.mkdir("./", { recursive: true });
      const unzipper = new AdmZip(Buffer.from(zip.data));
      const fileData = await extractZipAsync(unzipper);
      return JSON.parse(fileData) || {};
    }
  } catch (err) {
    core.info("Error getting artifact");
    core.info(err);
    return {};
  }
}

const runTest = (wpt, url, options) => {
  // clone options object to avoid WPT wrapper issue
  let tempOptions = JSON.parse(JSON.stringify(options));

  return new Promise((resolve, reject) => {
    core.info(`Submitting test for ${url} ...`);
    wpt.runTest(url, tempOptions, async (err, result) => {
      try {
        if (result) {
          core.debug(result);
          return resolve({ result: result, err: err });
        } else {
          return reject(err);
        }
      } catch (e) {
        core.info(e.statusText || JSON.stringify(e));
      }
    });
  });
};

const retrieveResults = (wpt, testId) => {
  return new Promise((resolve, reject) => {
    wpt.getTestResults(testId, (err, data) => {
      if (data) {
        return resolve(data);
      } else {
        return reject(err);
      }
    });
  });
};

/**
 * most of the functionality below was
 * modified based off https://github.com/amondnet/vercel-action
 */

function isPullRequestType(event) {
  return event.startsWith("pull_request");
}

async function findCommentsForEvent() {
  core.debug("find comments for event");
  if (context.eventName === "push") {
    core.debug('event is "commit", use "listCommentsForCommit"');
    return octokit.repos.listCommentsForCommit({
      ...context.repo,
      commit_sha: context.sha,
    });
  }
  if (isPullRequestType(context.eventName)) {
    core.debug(`event is "${context.eventName}", use "listComments"`);
    return octokit.issues.listComments({
      ...context.repo,
      issue_number: context.issue.number,
    });
  }
  core.error("not supported event_type");
  return [];
}

// modified based off https://github.com/amondnet/vercel-action
async function findPreviousComment(text) {
  if (!octokit) {
    return null;
  }
  const { data: comments } = await findCommentsForEvent();
  core.debug(`here are the comments \n ${JSON.stringify(comments)}`);

  const webPageTextResultsComment = comments.find((comment) =>
    comment.body.startsWith(text)
  );
  if (webPageTextResultsComment) {
    return webPageTextResultsComment.id;
  }
  return null;
}

const STARTS_WITH_STRING = "# WebPageTest Test Results";
async function createCommentOnCommit(body) {
  if (!octokit) {
    return;
  }

  // get comments first and see if one matches our template
  const previousCommentId = await findPreviousComment(STARTS_WITH_STRING);
  if (previousCommentId) {
    await octokit.repos.updateCommitComment({
      ...context.repo,
      comment_id: previousCommentId,
      body,
    });
  } else {
    await octokit.repos.createCommitComment({
      ...context.repo,
      commit_sha: context.sha,
      body,
    });
  }
}

async function createCommentOnPullRequest(body) {
  if (!octokit) {
    return;
  }

  // get comments first and see if one matches our template
  const previousCommentId = await findPreviousComment(STARTS_WITH_STRING);
  if (previousCommentId) {
    await octokit.issues.updateComment({
      ...context.repo,
      comment_id: previousCommentId,
      body,
    });
  } else {
    await octokit.issues.createComment({
      ...context.repo,
      issue_number: context.issue.number,
      body,
    });
  }
}

async function renderComment(data) {
  try {
    let markdown = await ejs.renderFile(
      `${__dirname}/templates/comment.md`,
      data
    );
    markdown.replace(/\%/g, "%25").replace(/\n/g, "%0A").replace(/\r/g, "%0D");

    const prNumber =
      GH_EVENT_NAME == "pull_request"
        ? context.payload.pull_request.number
        : GH_EVENT_NAME == "issue_comment"
        ? context.payload.issue.number
        : null;

    if (!prNumber)
      throw new Error('Incompatible event "' + GH_EVENT_NAME + '"');

    if (context.issue.number) {
      // this is a PR
      await createCommentOnPullRequest(markdown);
    } else if (context.eventName === "push") {
      // this a commit
      await createCommentOnCommit(markdown);
    }
  } catch (e) {
    console.log(e);
    core.setFailed(
      `Action failed with error: ${e.statusText || JSON.stringify(e)}`
    );
  }
}

function diffMetric(currValue, prevValue, showRawDifference = false) {
  const REPLACE_STRING = "$difference";
  const RETURN_TOKENS = {
    same: "",
    greater: `(📈 ${REPLACE_STRING}%)`,
    less: `(📉 ${REPLACE_STRING}%)`,
    rawDifference: `(${REPLACE_STRING})`,
  };

  if (!prevValue || !currValue) return RETURN_TOKENS["same"];

  const diff = currValue - prevValue;

  // we just want to return the difference as a number
  if (showRawDifference !== 0)
    return RETURN_TOKENS["rawDifference"].replace(REPLACE_STRING, diff);

  const diffInPercent = ((diff / prevValue) * 100).toFixed(2);

  if (diff > 0) {
    return RETURN_TOKENS["greater"].replace(REPLACE_STRING, diffInPercent);
  } else if (diff < 0) {
    return RETURN_TOKENS["less"].replace(REPLACE_STRING, diffInPercent);
  }

  return RETURN_TOKENS["same"];
}

async function collectData(results, runData, devMetrics) {
  const newDevMetrics = {};
  let testData = {
    url: results.data.url,
    testLink: results.data.summary,
    waterfall: results.data.median.firstView.images.waterfall,
    metrics: [],
    customMetrics: [],
    shouldFlagBundleChange: false,
  };
  for (const [key, value] of Object.entries(METRICS)) {
    core.debug(key);
    core.debug(value);
    const testValue = results.data.median.firstView[key];
    if (testValue) {
      const { label } = value;
      testData.metrics.push({
        name: label,
        value: `${testValue.toFixed(2)} ${diffMetric(
          testValue,
          devMetrics?.[key]
        )}`,
      });
      newDevMetrics[key] = testValue;
    }
  }

  // lets get the custom metrics we want to track
  // core bundle sizes
  if (results.data.median.firstView["breakdown"]) {
    const key = "total_js_compressed";
    const testValue = results.data.median.firstView?.breakdown?.js?.bytes;
    if (testValue) {
      const label = "Total JS (compressed)";
      const devMetric = devMetrics?.[key] || testValue;
      testData.customMetrics.push({
        name: label,
        value: `${testValue} bytes ${diffMetric(testValue, devMetric, true)}`,
      });

      if (Math.abs(testValue - devMetric) >= 10000) {
        testData.shouldFlagBundleChange = true;
      }

      newDevMetrics[key] = testValue;
    }
  }

  if (results?.data?.lighthouse?.audits) {
    const lighthouseAudits = results.data.lighthouse.audits;

    // total # of 3rd party requests
    let num3rdPartyRequests = 0;
    const metricName = "3rd-party-requests";
    lighthouseAudits["third-party-summary"]?.details?.items.forEach((item) => {
      num3rdPartyRequests += (item?.subItems?.items?.length || 0) + 1;
    });
    testData.customMetrics.push({
      name: "# of 3rd party reqs",
      value: `${num3rdPartyRequests} ${diffMetric(
        num3rdPartyRequests,
        devMetrics?.[metricName]
      )}`,
    });
    newDevMetrics[metricName] = num3rdPartyRequests;
  }

  // write the new dev metrics to the file
  core.info("Writing new dev metrics!");
  try {
    await fs.writeFile(STORED_METRIC_NAME, JSON.stringify(newDevMetrics));
  } catch (err) {
    core.info("Error writing new dev metrics!");
    core.info(err);
  }

  runData["tests"].push(testData);
}
async function run() {
  const wpt = new WebPageTest("www.webpagetest.org", WPT_API_KEY);
  const oldDevMetrics = await getDevMetrics();

  //TODO: make this configurable
  let options = {
    firstViewOnly: true,
    runs: 3,
    location: "Dulles:Chrome",
    connectivity: "4G",
    pollResults: 5,
    timeout: 240,
    emulateMobile: true,
  };
  if (WPT_OPTIONS) {
    let settings = require(`${DIRECTORY}/${WPT_OPTIONS}`);
    if (typeof settings === "object" && settings !== null) {
      core.debug(settings);
      options = {
        ...options,
        ...settings,
      };
    } else {
      core.setFailed(
        "The specified WebPageTest settings aren't a valid JavaScript object"
      );
    }
  }
  if (WPT_BUDGET) {
    options.specs = require(`${DIRECTORY}/${WPT_BUDGET}`);
  }
  if (WPT_LABEL) {
    options.label = WPT_LABEL;
  }

  core.startGroup("WebPageTest Configuration");
  core.info(`WebPageTest settings: ${JSON.stringify(options, null, "  ")}`);
  core.endGroup();

  core.startGroup(`Testing urls in WebPageTest..`);
  //for our commit
  let runData = {};
  runData["tests"] = [];

  Promise.all(
    WPT_URLS.map(async (url) => {
      try {
        await runTest(wpt, url, options).then(async (result) => {
          try {
            if (result.result.testId) {
              //test submitted with specs
              core.info(
                "Tests successfully completed for " +
                  url +
                  ". Full results at https://" +
                  wpt.config.hostname +
                  "/result/" +
                  result.result.testId
              );

              let testResults = await retrieveResults(
                wpt,
                result.result.testId
              );
              await collectData(testResults, runData, oldDevMetrics);

              // testspecs also returns the number of assertion fails as err
              // > 0 means we need to fail
              if (result.err && result.err > 0) {
                if (result.err == 1) {
                  core.setFailed("One performance budget not met.");
                } else {
                  core.setFailed(result.err + " performance budgets not met.");
                }
              }
              return;
            } else if (result.result.data) {
              //test was submitted without testspecs
              core.info(
                "Tests successfully completed for " +
                  url +
                  ". Full results at " +
                  result.result.data.summary
              );

              if (isReportSupported()) {
                let testResults = await retrieveResults(
                  wpt,
                  result.result.data.id
                );
                await collectData(testResults, runData, oldDevMetrics);
              }
              return;
            } else {
              return;
            }
          } catch (e) {
            console.log(e);
            core.setFailed(
              `Action failed with error: ${e.statusText || JSON.stringify(e)}`
            );
          }
        });
      } catch (e) {
        console.log(e);
        core.setFailed(
          `Action failed with error: ${e.statusText || JSON.stringify(e)}`
        );
      }
    })
  ).then(() => {
    if (isReportSupported()) {
      core.info("Writing comment!");
      renderComment(runData);
    }
  });

  return;
}

run();
