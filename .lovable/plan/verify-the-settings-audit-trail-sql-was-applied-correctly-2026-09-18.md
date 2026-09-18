# Verify the Settings audit-trail SQL was applied correctly

The change-history SQL (`docs/operations/pending-migrations/20260918000100_requirement_settings_audit.sql`) was applied by hand to the external database. This workspace has no direct connection to that database, so it cannot inspect the trigger definition itself. This plan verifies the result functionally instead, and fixes anything that turns out to be missing.

## Step 1 — Functional check (no code changes)

1. In the app, sign in as an owner or risk manager and open Dashboard → Settings.
2. Change one requirement (for example, raise the General liability — each occurrence minimum) and save.
3. Confirm the "Change history" panel on the same page shows a new entry with the rule name, new amount, and previous amount.
4. Turn one requirement off and save again; confirm a "removed" entry appears.

If both entries appear, the trigger and the widened audit_log constraints are in place — nothing further to do. The history panel was built to read these rows automatically; no app change is needed.

## Step 2 — If the check fails, pinpoint the cause

- Save works but no history entry appears → the trigger or function is missing. Re-apply the SQL file and re-test.
- Save itself fails with a constraint error mentioning `audit_log_action_check` or `audit_log_target_type_check` → the constraint-widening half did not apply. Re-apply the two `ALTER TABLE` blocks from the same file.
- Save fails with a permissions error → unrelated to this change; investigate RLS on requirement_profile_rules separately.

## Step 3 — Regression safety

Run the existing database test suite (`audit-log.test.ts` and friends) against a local test database to confirm the new trigger does not break existing audit behavior, and confirm the app test suite and build stay green.

## Technical details

- Files involved: `docs/operations/pending-migrations/20260918000100_requirement_settings_audit.sql` (already applied by you), `src/data/repositories/requirementSettings.ts` (`loadRequirementAuditHistory`), `src/features/settings/SettingsPage.tsx` (history panel).
- The trigger is idempotent-safe to re-apply except `CREATE TRIGGER`, which errors if run twice — if re-applying, that error on an otherwise successful run is expected and harmless.
- No new migrations, packages, or UI work are expected from this plan; it is verification plus targeted repair only.
