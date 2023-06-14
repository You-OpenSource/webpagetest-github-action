# WebPageTest Test Results

Automatically triggered by [WebPageTest](https://www.webpagetest.org)'s GitHub Action (forked You.com version).

<% tests.forEach((test) => { %>

## Page Tested:<%- test.url %>

**Full test results: <%- test.testLink %>**

### WebPageTest Metrics
| <% test.metrics.forEach((metric) => { %><%- metric.name %> | <% }); %>
| <% test.metrics.forEach((metric) => { %>--- | <% }); %>
| <% test.metrics.forEach((metric) => { %><%- metric.value %> | <% }); %>
<br/>
### Lighthouse Metrics
| <% test.customMetrics.forEach((metric) => { %><%- metric.name %> | <% }); %>
| <% test.customMetrics.forEach((metric) => { %>--- | <% }); %>
| <% test.customMetrics.forEach((metric) => { %><%- metric.value %> | <% }); %>

<% }); %>
