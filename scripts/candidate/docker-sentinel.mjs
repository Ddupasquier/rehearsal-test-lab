import { randomUUID } from "node:crypto";
import { runCommand } from "./process.mjs";

export function createDockerSentinel() {
  const suffix = randomUUID().slice(0, 8);
  const names = {
    container: `rehearsal-lab-sentinel-${suffix}`,
    network: `rehearsal-lab-sentinel-${suffix}`,
    volume: `rehearsal-lab-sentinel-${suffix}`,
  };
  const label = `com.rehearsal-test-lab.sentinel=${suffix}`;
  const created = [];
  let identities;
  try {
    runCommand("docker", [
      "network",
      "create",
      "--label",
      label,
      names.network,
    ]);
    created.push(["network", "rm", names.network]);
    runCommand("docker", ["volume", "create", "--label", label, names.volume]);
    created.push(["volume", "rm", names.volume]);
    runCommand("docker", [
      "create",
      "--name",
      names.container,
      "--label",
      label,
      "--network",
      names.network,
      "--mount",
      `source=${names.volume},target=/sentinel`,
      "postgres:17-alpine",
      "true",
    ]);
    created.push(["rm", names.container]);
    identities = {
      container: inspect("container", names.container),
      network: inspect("network", names.network),
      volume: inspect("volume", names.volume),
    };
  } catch (error) {
    for (const args of created.reverse()) {
      try {
        runCommand("docker", args);
      } catch {
        // Preserve the original creation failure; every name is unique and labeled.
      }
    }
    throw error;
  }

  return {
    names,
    identities,
    verify() {
      for (const type of ["container", "network", "volume"]) {
        if (inspect(type, names[type]) !== identities[type]) {
          throw new Error(`Unrelated Docker ${type} ${names[type]} changed.`);
        }
      }
      return { preserved: true, resources: names };
    },
    remove() {
      const failures = [];
      for (const [type, args] of [
        ["container", ["rm", names.container]],
        ["network", ["network", "rm", names.network]],
        ["volume", ["volume", "rm", names.volume]],
      ]) {
        try {
          runCommand("docker", args);
        } catch (error) {
          failures.push(`${type}: ${error.message}`);
        }
      }
      if (failures.length) throw new Error(failures.join("\n"));
    },
  };
}

function inspect(type, name) {
  const noun = type === "container" ? "container" : type;
  const { stdout } = runCommand("docker", [noun, "inspect", name]);
  const [details] = JSON.parse(stdout);
  const id =
    type === "volume" ? `${details.Name}:${details.Mountpoint}` : details.Id;
  if (!id) throw new Error(`Docker did not return an ID for ${type} ${name}.`);
  return id;
}
