---
description: Safety and correctness review before merging
---

Review the current changes against the hard rules in CLAUDE.md.

Check specifically:
- Any secret, token, or key committed to the repo or embedded in code
- Any OAuth token written into a table column instead of Vault
- Any bypass of `claim_due_posts` that could allow double-posting
- Any account-creation automation, CAPTCHA/OTP handling, or proxy rotation
- Any scraping or use of undocumented/private platform endpoints
- Errors that abort the whole batch instead of failing one post
- `any` types that should be `unknown` and narrowed
- Missing migration for a schema change

Report findings by severity. Do not fix anything until I confirm.
