# WebPageTest Test Results

Automatically triggered by [WebPageTest](https://www.webpagetest.org)'s GitHub Action (forked You.com version).

<% tests.forEach((test) => { %>

## Page Tested:<%- test.url %>

**Full test results: <%- test.testLink %>**

### WebPageTest Metrics

| <% test.metrics.forEach((metric) => { %><%- metric.name %> | <% }); %>
| <% test.metrics.forEach((metric) => { %>--- | <% }); %>
| <% test.metrics.forEach((metric) => { %><%- metric.value %> | <% }); %>

### Bundle Size

| <% test.customMetrics.forEach((metric) => { %><%- metric.name %> | <% }); %>
| <% test.customMetrics.forEach((metric) => { %>--- | <% }); %>
| <% test.customMetrics.forEach((metric) => { %><%- metric.value %> | <% }); %>

<% if (test.shouldFlagBundleChange) { %>
**The bundle size change from this PR is more than 10kb. Consider dynamically importing any new components to reduce this**
<% } %>
<% }); %>
