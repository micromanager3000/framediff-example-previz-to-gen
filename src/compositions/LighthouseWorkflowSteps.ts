import { defineHyperframesComposition } from "@framediff/hyperframes";
import source from "./LighthouseWorkflowSteps.html?raw";

export const lighthouseWorkflowStepsComp = defineHyperframesComposition(source, {
  id: "LighthouseWorkflowSteps",
  file: "src/compositions/LighthouseWorkflowSteps.html",
  module: "src/compositions/LighthouseWorkflowSteps.ts",
  exportName: "lighthouseWorkflowStepsComp",
  width: 400,
  height: 600,
  fps: 30,
  durationInFrames: 420,
  alpha: true,
  library: true,
});
