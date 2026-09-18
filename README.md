# VendorClr-Dash

Create a new private project named VendorClr Dashboard. Build a frontend-first authenticated operations dashboard for a construction vendor-compliance service. Do not enable Lovable Cloud, provision a database, run migrations, or connect Supabase. Use a typed in-memory demo repository behind one DashboardRepository interface, and label backend-dependent behavior as demo-only.

Use Manrope for interface text and IBM Plex Mono for dates, limits, policy numbers, and counts. Use #0F172A, #2563EB, #F8FAFC, #15803D, #D97706, and #DC2626. Avoid gradients, oversized marketing cards, ornamental metrics, and excessive animation. The product should feel like a precise construction-risk operations console.

Create customer routes for overview, vendors, vendor detail, tasks, reports, and settings. Create administrator routes for overview, companies, compliance queue, leads, tasks, and access management. Add a demo role switcher that clearly says Demo mode; it must not imitate real authentication. Add loading, empty, error, and denied examples.

The signature component is a compact compliance rail showing COI, Additional Insured, Waiver of Subrogation, lien waiver, and renewal status on vendor rows and details. Provide meaningful sample construction vendors and requirements. All primary controls need visible focus, descriptive labels, and useful mobile layouts.

Use this structure:
src/app/App.tsx
src/app/router.tsx
src/components/shell/AppShell.tsx
src/components/compliance/ComplianceRail.tsx
src/components/compliance/ComplianceBadge.tsx
src/components/states/AsyncState.tsx
src/features/auth/AuthPages.tsx
src/features/overview/OverviewPage.tsx
src/features/vendors/VendorsPage.tsx
src/features/vendors/VendorDetailPage.tsx
src/features/vendors/VendorForm.tsx
src/features/tasks/TasksPage.tsx
src/features/reports/ReportsPage.tsx
src/features/settings/SettingsPage.tsx
src/features/admin/AdminOverviewPage.tsx
src/features/admin/CompaniesPage.tsx
src/features/admin/ComplianceQueuePage.tsx
src/features/admin/LeadsPage.tsx
src/features/admin/AccessPage.tsx
src/data/contracts.ts
src/data/demoRepository.ts
src/data/repository.ts
src/styles/tokens.css
src/test/setup.ts
src/tests/routes.test.tsx
src/tests/compliance-rail.test.tsx

Routes:
/login
/signup
/reset-password
/dashboard
/dashboard/vendors
/dashboard/vendors/:vendorId
/dashboard/tasks
/dashboard/reports
/dashboard/settings
/dashboard/admin
/dashboard/admin/companies
/dashboard/admin/compliance
/dashboard/admin/leads
/dashboard/admin/access

Add Vitest and Testing Library coverage for route rendering and the compliance rail. Do not claim that any upload, email, review, or export persisted. Finish by running tests and the production build, then report exact results and whether any backend was enabled.

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
