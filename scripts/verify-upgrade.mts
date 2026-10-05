const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) {
  console.log(`Usage: npm run upgrade:verify -- /absolute/path/to/previous.tgz /absolute/path/to/candidate.tgz

Requires a previous release of beta.13 or newer for this scoped UUID fixture.
Builds usable PostgreSQL and Supabase state with the previous release, then
upgrades the same consumers and verifies preserved configuration and baselines,
reset, migrations, application proofs, and cleanup. Both exact artifacts are
recorded under test-results/upgrade-acceptance/.`);
} else {
  if (args.length !== 2)
    throw new Error(
      "Pass exactly two artifacts: previous release, then newer candidate.",
    );
  process.argv = [
    process.execPath,
    process.argv[1] ?? "scripts/verify-upgrade.mts",
    "--upgrade",
    ...args,
  ];
  await import("./verify-candidate.mts");
}
