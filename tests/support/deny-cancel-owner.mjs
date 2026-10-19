import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

if (process.env.CANCEL_OWNER_REFUSAL_FIFO) {
  if (process.argv[2] === "review-worker") {
    // Block this owned worker at a pipe barrier before any provider execution.
    fs.openSync(process.env.CANCEL_OWNER_REFUSAL_FIFO, "r");
  }
  if (process.argv[2] === "adversarial-review") {
    const read = fs.readFileSync;
    fs.readFileSync = function (file, ...args) {
      if (file === `/proc/${process.pid}/stat`) {
        throw Object.assign(new Error("fixture owner identity denied"), { code: "EACCES" });
      }
      return read.call(this, file, ...args);
    };
    syncBuiltinESMExports();
    const once = process.once;
    process.once = function (event, listener) {
      const result = once.call(this, event, listener);
      if (event === "SIGINT") process.stderr.write("[fixture] interrupt handler ready\n");
      return result;
    };
  }
}
