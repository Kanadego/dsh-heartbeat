// src/core/open-path.ts
import { spawn } from "child_process";
function openerFor(platform) {
  if (platform === "win32") return { cmd: "cmd", args: (f) => ["/c", "start", "", f] };
  if (platform === "darwin") return { cmd: "open", args: (f) => [f] };
  return { cmd: "xdg-open", args: (f) => [f] };
}
function spawnDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {
    });
    child.unref();
  } catch {
  }
}
function openPath(file, opener = openerFor(process.platform)) {
  spawnDetached(opener.cmd, opener.args(file));
}

export {
  openerFor,
  openPath
};
//# sourceMappingURL=chunk-OCBE2AKW.js.map