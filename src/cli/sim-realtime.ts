import { runRealtimeSimulation } from "../realtime/coordinator.js";

runRealtimeSimulation().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
