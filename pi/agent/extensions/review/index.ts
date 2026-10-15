import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReviewTool } from "./tool.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerTool(createReviewTool(Type));
}
