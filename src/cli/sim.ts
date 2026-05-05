import { runSimulation } from "../coordinator.js";

runSimulation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
