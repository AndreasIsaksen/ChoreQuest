# Mobile UI review — October 7, 2026

Reviewed the current `main` EJS pages: login, overview, chores (list and calendar), requests, household, administration, error recovery, and Quick Chore.

## Changes

- Frame icon actions, completion controls, secondary links and expandable management actions. Give interactive controls at least 44px height, with 48px form fields and primary buttons on phones.
- Stack filters, shortcut navigation and paired primary actions on phones. Use 16px input text to avoid focus zoom on iOS, and allow long names and translated labels to wrap.
- Center mobile branding, welcome copy, page introductions and login headings. Keep task details and form labels left aligned; member cards and progress remain centered.
- Overview retains its summary-first purpose. Chores shows the actionable plan before points, statistics and future schedules. Member requests puts composition first; administrators see the review queue first. Administration starts with chore building, then points and history. Household retains the existing members-before-account-creation order. Device settings precede the footer.
- Use shared partials for repeated statistics and the request form. DOM order follows the mobile task priority, including keyboard and screen-reader navigation.

## Validation

- Node test runner: 26 passed, 9 PostgreSQL integration suites skipped because no test database was configured.
- Chromium with populated EJS fixtures: 352 checks across English/Norwegian, administrator/member, light/dark themes, and viewport widths 320, 375, 390, 599, 768, 1024 and 1440px. Dashboard checks include list and calendar views, document overflow and visible control heights. Login and error pages were checked at 320, 390, 768 and 1440px.
- Expanded Quick Chore dialog checked at 320 × 640px for width overflow and viewport fit. Mobile chores and dialog screenshots inspected.
- These are rendered fixture checks, not live database or physical-device testing. Native date/select pickers and iOS keyboard behavior still require device verification.
