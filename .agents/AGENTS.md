# Agent Behavioral Rules & Constraints

## Rule 1: Preserve Account Tab Selector & Core UI Features
- **NEVER** remove or hide the Account Tab Switcher Bar (`#account-tabs-container`). Account tabs are rendered dynamically from `bot_accounts.json`.
- **NEVER** introduce Javascript syntax errors or remove existing event handlers that break client-side initialization (`init-multi`, `renderAccountTabs()`).
- **Audit Script First**: Always read the entire script before making edits, and only touch code strictly required for the specific request.
