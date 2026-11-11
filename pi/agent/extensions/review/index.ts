import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiTools } from "../../lib/host/pi.mjs";
import { createReviewTool } from "./tool.mjs";

export default function (pi: ExtensionAPI) {
  registerPiTools(pi, [createReviewTool(Type)]);
}
