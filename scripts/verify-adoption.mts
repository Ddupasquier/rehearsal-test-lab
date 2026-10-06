const args = process.argv.slice(2);
if (args.length === 1 && ["--help", "-h"].includes(args[0] ?? "")) {
  console.log(`Usage: npm run adoption:verify -- /absolute/path/to/candidate.tgz

Proves an ordinary library app works before Rehearsal installation, then uses
public init/setup, reviewed declarations, and real application proofs. Runs in
an isolated workspace; reports remain under test-results/adoption/.`);
} else {
  if (args.length !== 1) throw new Error("Pass one exact candidate artifact.");
  process.argv = [
    process.execPath,
    process.argv[1] ?? "scripts/verify-adoption.mts",
    "--adoption",
    ...args,
  ];
  await import("./verify-candidate.mts");
}
