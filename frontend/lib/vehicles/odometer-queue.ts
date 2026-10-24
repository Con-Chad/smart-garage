/**
 * Serialises odometer writes per vehicle within this process. The WiCAN
 * ingest and the API's OBD uploads both check "higher than the newest
 * reading" and then write; running them one at a time per vehicle keeps
 * two overlapping requests from both passing the check. The server is a
 * single Node process, so an in-memory queue is enough.
 */
const queues = new Map<string, Promise<unknown>>();

export function serialisedPerVehicle<T>(vehicleId: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(vehicleId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(task);
  queues.set(vehicleId, run);
  void run
    .finally(() => {
      if (queues.get(vehicleId) === run) queues.delete(vehicleId);
    })
    .catch(() => {});
  return run;
}
