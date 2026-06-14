// Recorded Firecrawl /v1/scrape markdown fixtures for the IrCalendarEarningsProvider tests.
//
// `APPLE_IR_NO_FUTURE_DATE` is a REAL capture of https://investor.apple.com/investor-relations/
// default.aspx (rendered through the homeserver Firecrawl at 192.168.50.2:3002), trimmed to its
// leading content. On the capture date the page advertised only PAST results ("quarter ended March
// 28, 2026") and unrelated newsroom dates — no future earnings advisory — so the parser must return
// null (degrade-to-empty). This is the honest, common case: an IR landing page often carries no
// forward earnings date.
//
// `APPLE_IR_FUTURE_ADVISORY` is a representative earnings-advisory markdown in the canonical "to
// announce … results on <future date>" shape these IR/press pages use when a company HAS published
// its next report date — the positive parse path. (Future dates are well past `now` in the tests.)

export const APPLE_IR_NO_FUTURE_DATE = `[Skip to main content](https://investor.apple.com/investor-relations/default.aspx#maincontent)

News and Results
================

Investor Updates
----------------

### FY 26 Second Quarter Results

Apple announced results and business updates for the quarter ended March 28, 2026.

[View the press release](https://www.apple.com/newsroom/2026/04/apple-reports-second-quarter-results/)

Newsroom
--------

### WWDC26 highlights: Apple Intelligence, Siri AI, new parental controls, and more

June 9, 2026

Today, Apple previewed its upcoming software releases that will deliver the next generation of Apple Intelligence.

[Read more](https://www.apple.com/newsroom/2026/06/apple-unveils-next-generation-of-apple-intelligence-siri-ai-and-more/)
`;

export const APPLE_IR_FUTURE_ADVISORY = `Investor Relations
==================

### Upcoming Events

Apple Inc. (NASDAQ: AAPL) today announced that it will report fourth quarter financial results on
Thursday, October 29, 2026. Apple will provide live streaming of its Q4 2026 financial results
conference call beginning at 2:00 p.m. PT on October 29, 2026.

[Add to calendar](https://investor.apple.com/)
`;

// A press page rendered by Firecrawl with a "page not found" body (Firecrawl still returns HTTP 200
// + success:true, so the parser — not the transport — must yield null). Mirrors a real observed
// response when a guessed advisory URL 404s through the basic proxy.
export const PAGE_NOT_FOUND = `The page you’re looking for can’t be found.
===========================================

[Or see our site map](https://www.apple.com/sitemap/)
`;
