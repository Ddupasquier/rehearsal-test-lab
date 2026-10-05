# Add another database target

Add a provider only when it proves behavior the existing targets cannot.

1. Create `projects/<provider>` as a self-contained consumer.
2. Document whether it is a source, a disposable target, or both.
3. Give it isolated ports, resource names, credentials, and cleanup rules.
4. Reuse the canonical synthetic concepts, not provider-specific SQL copied blindly.
5. Add a positive lifecycle scenario and a deliberate failure-preservation scenario.
6. Make the project runnable without Supabase or another unrelated provider.
7. Add hosted credentials only after a local version is deterministic.

Every provider guide must answer:

- What can this test create or delete?
- Where are credentials stored?
- How does a new developer start from zero?
- How is success observed independently of CLI output?
- How is all provider-owned test state removed?
