import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { openComposition } from "./helpers";

const mutableGenerationFiles = [
  "framediff.generations.json",
  "src/gen/harborShot.gen.json",
] as const;
let generationFileSnapshots = new Map<string, string>();

test.beforeEach(async () => {
  generationFileSnapshots = new Map(await Promise.all(mutableGenerationFiles.map(async (file) => [
    file,
    await readFile(file, "utf8"),
  ] as const)));
});

test.afterEach(async () => {
  for (const [file, original] of generationFileSnapshots) {
    if (await readFile(file, "utf8") !== original) await writeFile(file, original);
  }
});

test("a draft take appears only after Add Take", async ({ page }) => {
  await openComposition(page, "harborShot", "http://127.0.0.1:4175/");
  await expect(page).toHaveTitle("FrameDiff — Previz to Generation");
  await expect(page.locator(".top-status")).toHaveText("ready");

  await expect(page.getByRole("button", { name: "+ Add take", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "↳ Draft from latest", exact: true })).toHaveCount(0);
  await expect(page.getByText("HISTORICAL TAKE 5", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "take 5 in use", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: / draft$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back to current draft", exact: true })).toHaveCount(0);
  await expect(page.getByRole("slider", { name: "Synchronized comparison frame", exact: true })).toBeVisible();
  await expect(page.getByLabel("Generated take 5", { exact: true })).toBeVisible();
  const bakedPreviz = page.getByLabel("Baked previz for take 5", { exact: true });
  await expect(bakedPreviz).toBeVisible();
  await expect(bakedPreviz).toHaveAttribute("src", "/__framediff-cache/sha256%3A2bcf5047aaa3b81168c5f468da6ef4981f064387ebf87ee2b6a05f76eaf4b2a3");
  await expect(page.getByLabel("Synchronized comparison of HarborPreviz and take 5").locator(".synchronized-composition-preview")).toHaveCount(0);
  await expect(
    page.getByLabel("Synchronized comparison of HarborPreviz and take 5").getByText("HarborPreviz", { exact: true }),
  ).toBeVisible();
  const synchronizedFrame = page.getByRole("slider", { name: "Synchronized comparison frame", exact: true });
  await synchronizedFrame.fill("90");
  await expect(synchronizedFrame).toHaveValue("90");
  await expect.poll(() => page.getByLabel("Generated take 5", { exact: true }).evaluate(
    (video: HTMLVideoElement) => Math.round(video.currentTime * 10) / 10,
  )).toBe(3);
  await expect.poll(() => bakedPreviz.evaluate(
    (video: HTMLVideoElement) => Math.round(video.currentTime * 10) / 10,
  )).toBe(3);

  await page.getByRole("button", { name: "+ Add take", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Generation model", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Reference type", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Reference source", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove video reference HarborPreviz", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "take 4 generated", exact: true }).click();
  await expect(page.getByText("HISTORICAL TAKE 4", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Take from This", exact: true })).toBeVisible();
  await expect(page.getByLabel("Baked previz for take 4", { exact: true })).toHaveAttribute("src", /__framediff-cache/);

  const draft = page.getByRole("tab", { name: "take 6 draft", exact: true });
  await draft.click();
  const prompt = page.getByRole("textbox", { name: "Generation prompt", exact: true });
  await expect(prompt).toBeEditable();
  await expect(prompt).toBeFocused();
  await expect(draft).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("draft-preview-slate")).toBeVisible();
  await expect(page.locator(".gen-preview img, .gen-preview video, .gen-preview audio")).toHaveCount(0);

  await draft.click();
  await expect(prompt).toBeFocused();
});

test("a take without a baked previz links back to the previz instead of mounting it live", async ({ page }) => {
  await page.route("**/__framediff/gen/jobs*", async (route) => {
    if (!route.request().url().includes("gen=harborShot")) return route.continue();
    const response = await route.fetch();
    const body = await response.json() as { takes: Array<{ generator: { take: number; inputs?: Array<{ contentHash?: string }> } }> };
    await route.fulfill({
      response,
      json: {
        ...body,
        takes: body.takes.map((take) => take.generator.take === 5
          ? { ...take, generator: { ...take.generator, inputs: take.generator.inputs?.map(({ contentHash: _contentHash, ...input }) => input) } }
          : take),
      },
    });
  });
  await openComposition(page, "harborShot", "http://127.0.0.1:4175/");

  const comparison = page.getByLabel("Synchronized comparison of HarborPreviz and take 5");
  await expect(comparison.getByRole("button", { name: /Bake previz to see it here/ })).toBeVisible();
  await expect(comparison.locator(".synchronized-composition-preview")).toHaveCount(0);
  await expect(comparison.getByLabel("Baked previz for take 5", { exact: true })).toHaveCount(0);

  await comparison.getByRole("button", { name: /Bake previz to see it here/ }).click();
  await expect(page.locator('.composition-row[data-composition-key="harbor-previz"]').first()).toHaveClass(/active/);
});

test("an active attempt creates no successor draft until Add Take", async ({ page }) => {
  const activeJobs: { id: string; status: "queued"; at: string }[] = [];
  let editedPrompt: string | undefined;
  await page.route("**/__framediff/secrets", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { providers: { fal: { set: true } } } });
  });
  await page.route("**/__framediff/edit", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    editedPrompt = "A revised active-attempt draft.";
    await route.fulfill({ json: { ok: true, receipt: { id: "e2e-edit", label: "Edit draft", before: [], after: [] } } });
  });
  await page.route("**/__framediff/gen/submit", async (route) => {
    const index = activeJobs.length + 1;
    const job = {
      id: `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`,
      status: "queued" as const,
      at: `2026-08-14T12:0${index}:00.000Z`,
    };
    activeJobs.push(job);
    await route.fulfill({ json: { job } });
  });
  await page.route("**/__framediff/gen/jobs*", async (route) => {
    if (!route.request().url().includes("gen=lighthouseKeeper")) return route.continue();
    const response = await route.fetch();
    const body = await response.json() as { jobs: unknown[]; takes: unknown[]; prompt?: string; drafts?: unknown[]; activeDraftId?: string };
    const { drafts: _drafts, activeDraftId: _activeDraftId, ...submittedBody } = body;
    await route.fulfill({
      json: activeJobs.length
        ? { ...submittedBody, prompt: editedPrompt ?? body.prompt, jobs: [...body.jobs, ...activeJobs], drafts: [] }
        : body,
    });
  });

  // Use an asset-backed recipe so this scenario isolates submission state. Harbor Shot's
  // comp-backed video reference intentionally invokes the real browser encoder before submit.
  await openComposition(page, "lighthouse-keeper", "http://127.0.0.1:4175/");
  await expect(page.getByRole("tab", { name: / draft$/ })).toHaveCount(0);
  await page.getByRole("button", { name: "+ Add take", exact: true }).click();
  const draft = page.getByRole("tab", { name: "take 2 draft", exact: true });
  await draft.click();
  const prompt = page.getByRole("textbox", { name: "Generation prompt", exact: true });
  await prompt.fill("A revised active-attempt draft.");
  await expect(prompt).toBeEditable();

  const generate = page.getByRole("button", { name: /Generate ·/ });
  await generate.focus();
  await expect(generate).toBeFocused();
  await generate.press("Enter");
  await expect(page.locator(".take-tabs > button.generating")).toHaveCount(1);
  await expect(draft).toHaveCount(0);
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId("submitted-take-summary")).toBeVisible();
  await expect(page.getByTestId("submitted-take-preview")).toBeVisible();
  await expect(page.getByRole("tab", { name: "take 2 submitting", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "+ Add take", exact: true }).click();
  const nextDraft = page.getByRole("tab", { name: "take 3 draft", exact: true });
  await expect(nextDraft).toHaveAttribute("aria-selected", "true");
  await expect(prompt).toBeEditable();
  await expect(generate).toBeEnabled();
  await generate.click();
  await expect(nextDraft).toHaveCount(0);
  await expect.poll(() => activeJobs.length).toBe(2);
  await expect(page.locator(".take-tabs > button.generating")).toHaveCount(2);
  expect(activeJobs.map((job) => job.id)).toEqual([
    "00000001-0000-4000-8000-000000000000",
    "00000002-0000-4000-8000-000000000000",
  ]);
  await expect(page.locator(".take-tabs > button.generating").nth(0)).toHaveAccessibleName("take 2 submitting");
  await expect(page.locator(".take-tabs > button.generating").nth(1)).toHaveAccessibleName("take 3 submitting");
  await expect(page.getByRole("tab", { name: / draft$/ })).toHaveCount(0);
  await expect(page.getByTestId("submitted-take-preview")).toBeVisible();
});

test("failed attempts stay in take-number order with generated takes", async ({ page }) => {
  await openComposition(page, "lighthouse-dialogue", "http://127.0.0.1:4175/");

  const takes = page.getByRole("tablist", { name: "Generation takes" }).getByRole("tab");
  await expect(takes).toHaveCount(2);
  await expect(takes.nth(0)).toHaveAccessibleName("take 1 failed");
  await expect(takes.nth(1)).toHaveAccessibleName("take 2 in use");
  await expect(page.getByRole("tab", { name: / draft$/ })).toHaveCount(0);
});

test("generative rows advertise their output kind and input comps link to their source", async ({ page }) => {
  await openComposition(page, "harborShot", "http://127.0.0.1:4175/");

  // The rail marks every generative comp with its locked output kind.
  await expect(page.locator('.composition-row[data-composition-key="harborShot"] .out-badge').first()).toHaveText("video");
  await expect(page.locator('.composition-row[data-composition-key="lighthouse-dialogue-audio"] .out-badge').first()).toHaveText("audio");
  await expect(page.locator('.composition-row[data-composition-key="lighthouse-keeper"] .out-badge').first()).toHaveText("image");
  await expect(page.locator('.composition-row[data-composition-key="lighthouse-workflow"] .out-badge')).toHaveCount(0);

  // Upstream aliases are navigation-only. Their @role already carries the media kind,
  // so they neither repeat the output badge nor masquerade as draggable compositions.
  const mirror = page.locator('.composition-row.via-ref[data-composition-key="harbor-previz"]');
  await expect(mirror).toHaveAttribute("draggable", "false");
  await expect(mirror).toContainText("@Video1");
  await expect(mirror.locator(".out-badge")).toHaveCount(0);

  // Search returns a composition once instead of repeating its root and mirror alias.
  const railSearch = page.getByRole("searchbox", { name: "Find a composition" });
  await railSearch.fill("HarborPreviz");
  await expect(page.locator('.composition-list').first().locator('.composition-row[data-composition-key="harbor-previz"]')).toHaveCount(1);
  await railSearch.fill("");

  // A comp-backed input reference is a link into its source composition; the geometry
  // line stays behind as the input-handling toggle.
  await page.getByRole("button", { name: "+ Add take", exact: true }).click();
  await expect(page.getByRole("button", { name: "Adjust how HarborPreviz is adapted for the model", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open composition HarborPreviz", exact: true }).click();
  await expect(page.locator('.composition-row[data-composition-key="harbor-previz"]').first()).toHaveClass(/active/);
});

test("compact desktop rail keeps representative composition names readable", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openComposition(page, "lighthouse-workflow", "http://127.0.0.1:4175/");
  await expect(page.getByRole("button", { name: "Open compositions and media" })).toHaveCount(0);
  await expect(page.locator(".left-panel")).toBeVisible();

  for (const key of ["lighthouse-workflow-steps", "lighthouse-dialogue-audio"]) {
    const name = page.locator(`.composition-list`).first().locator(`.composition-row[data-composition-key="${key}"] .name`).first();
    await expect(name).toBeVisible();
    const metrics = await name.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      text: element.textContent ?? "",
      title: element.parentElement?.getAttribute("title") ?? "",
    }));
    expect(metrics.clientWidth / metrics.scrollWidth).toBeGreaterThanOrEqual(.9);
    expect(metrics.title).toContain(metrics.text);
  }
});

test("legacy phone-local geometry keeps the pinned Lighthouse take visible", async ({ page }) => {
  await openComposition(page, "lighthouse-workflow", "http://127.0.0.1:4175/");

  const editPreview = page.locator('.workspace:not(.generate-workspace) > .preview-panel .preview-runtime-host');
  const finalFrame = editPreview.locator('[data-fd-id="workflow-final"]');
  const finalVideo = finalFrame.locator("video[data-gen-output]");
  await expect(finalFrame).toHaveCount(1);
  await expect(finalVideo).toHaveCount(1);
  await expect.poll(() => finalFrame.evaluate((frame) => {
    const phone = frame.closest<HTMLElement>(".phone")!;
    const video = frame.querySelector<HTMLVideoElement>("video[data-gen-output]")!;
    const frameRect = frame.getBoundingClientRect();
    const phoneRect = phone.getBoundingClientRect();
    const overlapWidth = Math.max(0, Math.min(frameRect.right, phoneRect.right) - Math.max(frameRect.left, phoneRect.left));
    const overlapHeight = Math.max(0, Math.min(frameRect.bottom, phoneRect.bottom) - Math.max(frameRect.top, phoneRect.top));
    return {
      layoutSpace: frame.getAttribute("data-fd-layout-space"),
      layoutLocalX: frame.getAttribute("data-fd-layout-local-x"),
      layoutLocalY: frame.getAttribute("data-fd-layout-local-y"),
      visibleInsidePhone: overlapWidth * overlapHeight / Math.max(1, frameRect.width * frameRect.height) > 0.9,
      hasPinnedSource: video.currentSrc.includes("/__framediff-cache/"),
    };
  })).toEqual({
    layoutSpace: null,
    layoutLocalX: null,
    layoutLocalY: null,
    visibleInsidePhone: true,
    hasPinnedSource: true,
  });
});

test("a source-owned code scene owns frame logic without owning a timeline", async ({ page }) => {
  await openComposition(page, "lighthouse-workflow-steps", "http://127.0.0.1:4175/");

  await expect(page.getByText("scene · video · 400×600 · 420f", { exact: true })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Preview frame" })).toBeVisible();
  await expect(page.getByRole("group", { name: /Timeline/ })).toHaveCount(0);

  const codeScenePreview = page.locator('.workspace:not(.generate-workspace) > .preview-panel .preview-runtime-host');
  const codeSceneFrame = codeScenePreview.locator("hyperframes-player iframe").contentFrame();
  await page.getByRole("slider", { name: "Preview frame" }).fill("75");
  await expect(codeScenePreview.locator("hyperframes-player")).toHaveJSProperty("duration", 14);
  await expect(codeSceneFrame.locator('[data-hf-id="workflow-stage-2"]')).toHaveClass(/active/);
  await expect(codeSceneFrame.locator('[data-hf-id="workflow-stage-1"]')).not.toHaveClass(/active/);

  await openComposition(page, "lighthouse-workflow", "http://127.0.0.1:4175/");
  const sharedVisualLayer = page.locator('.lane[data-lane-id="v:2"]');
  await expect(sharedVisualLayer).toHaveAttribute("data-visual-rows", "4");
  const visualTops = await sharedVisualLayer.locator(".clip").evaluateAll((clips) =>
    clips.map((clip) => Math.round(clip.getBoundingClientRect().top)));
  expect(new Set(visualTops).size).toBe(4);

  const editPreview = page.locator('.workspace:not(.generate-workspace) > .preview-panel .preview-runtime-host');
  const nestedCodeScene = editPreview.locator(
    '[data-fd-id="workflow-steps"] [data-fd-id="LighthouseWorkflowSteps"]',
  );
  await expect(nestedCodeScene).toHaveCount(1);
  await expect(nestedCodeScene.locator("hyperframes-player iframe").contentFrame().locator('[data-hf-id="workflow-stage-1"]')).toHaveClass(/active/);

  const codeSceneClip = page.locator('.clip[data-item-id="workflow-steps"]');
  await expect(codeSceneClip).toBeVisible();
  await codeSceneClip.evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.getByRole("textbox", { name: "composition text" })).toHaveValue("lighthouse-workflow-steps");
  await expect(page.getByRole("spinbutton", { name: "width number" })).toHaveValue("400");
  await expect(page.getByRole("spinbutton", { name: "height number" })).toHaveValue("600");
  await expect(page.getByRole("spinbutton", { name: "corner radius number" })).toHaveValue("0");
});

test("image and audio compositions mount as live nested outputs", async ({ page }) => {
  await openComposition(page, "lighthouse-workflow", "http://127.0.0.1:4175/");

  const editPreview = page.locator('.workspace:not(.generate-workspace) > .preview-panel .preview-runtime-host');
  const referenceBoard = editPreview.locator('[data-fd-id="workflow-concept"]');
  await expect(referenceBoard).toHaveAttribute("data-fd-comp", "lighthouse-concept");
  await expect(referenceBoard.locator(".framediff-nested-host")).toHaveCount(1);
  await expect(referenceBoard.locator('[data-fd-id="LighthouseConcept"]')).toHaveCount(1);

  const audioLane = page.locator('.lane[data-lane-id="a:0"]');
  await expect(audioLane.locator('.clip[data-item-id="workflow-audio"]')).toHaveCount(1);
  const lockedAudio = editPreview.locator('[data-fd-id="workflow-audio"]');
  await expect(lockedAudio).toHaveAttribute("data-fd-live-audio-output", "");
  await expect(lockedAudio.locator('[data-fd-id="lighthouseDialogueAudio"]')).toHaveAttribute("data-fd-output", "audio");
  const lockedAudioMedia = lockedAudio.locator("audio[data-framediff-audio]");
  await expect(lockedAudioMedia).toHaveCount(1);
  await expect.poll(() => lockedAudioMedia.evaluate((audio: HTMLAudioElement) => audio.currentSrc)).toContain("/__framediff-cache/");

  await audioLane.locator('.clip[data-item-id="workflow-audio"]').click();
  await expect(page.locator(".canvas-selection")).toHaveCount(0);

  const approvalCard = page.locator('.clip[data-item-id="workflow-audio-card"]');
  await expect(approvalCard).toBeVisible();
  const approvalCardNode = editPreview.locator('[data-fd-id="workflow-audio-card"]');
  const approvalCardBounds = await approvalCardNode.boundingBox();
  expect(approvalCardBounds).not.toBeNull();
  await page.mouse.click(
    approvalCardBounds!.x + approvalCardBounds!.width / 2,
    approvalCardBounds!.y + approvalCardBounds!.height / 2,
  );
  await expect(page.getByLabel("Selected Audio approval card")).toBeVisible();
  await expect(page.locator(".resize-handle")).toHaveCount(8);
});

test("a JSON-authored audio-output composition controls preview and export gain", async ({ page }) => {
  const timelineFile = "src/compositions/LighthouseWorkflow.timeline.json";
  const htmlFile = "src/compositions/LighthouseWorkflow.html";
  const originalTimeline = await readFile(timelineFile, "utf8");
  const originalHtml = await readFile(htmlFile, "utf8");
  try {
    await openComposition(page, "lighthouse-workflow", "http://127.0.0.1:4175/");

    const timeline = JSON.parse(originalTimeline) as { items: Array<{ id: string; volume?: number }> };
    expect(timeline.items.find((item) => item.id === "workflow-audio")?.volume).toBe(1);
    expect(originalHtml).not.toContain("data-fd-volume");

    await page.locator('.clip[data-item-id="workflow-audio"]').evaluate((element) =>
      (element as HTMLButtonElement).click());
    await expect(page.getByRole("heading", { name: "COMPOSITION AUDIO" })).toBeVisible();
    const volume = page.getByRole("spinbutton", { name: "volume number" });
    await expect(volume).toHaveValue("1");

    const editPreview = page.locator('.workspace:not(.generate-workspace) > .preview-panel .preview-runtime-host');
    await expect(editPreview).toHaveCount(1);
    const approvalAudio = editPreview.locator('[data-fd-id="workflow-audio"] audio[data-framediff-audio]');
    await expect(approvalAudio).toHaveCount(1);
    await expect.poll(() => approvalAudio.evaluate((audio: HTMLAudioElement) => ({
      clipVolume: audio.dataset.fdVolume,
      previewVolume: audio.volume,
      exportVolume: audio.dataset.framediffVolume,
    }))).toEqual({
      clipVolume: "1",
      previewVolume: 1,
      exportVolume: "1",
    });

    await volume.fill("0.25");
    await volume.press("Tab");
    await expect.poll(async () => {
      const document = JSON.parse(await readFile(timelineFile, "utf8")) as { items: Array<{ id: string; volume?: number }> };
      return document.items.find((item) => item.id === "workflow-audio")?.volume;
    }).toBe(0.25);
    await expect.poll(() => approvalAudio.evaluate((audio: HTMLAudioElement) => ({
      previewVolume: audio.volume,
      exportVolume: audio.dataset.framediffVolume,
    }))).toEqual({ previewVolume: 0.25, exportVolume: "0.25" });
    expect(await readFile(htmlFile, "utf8")).toBe(originalHtml);

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(async () => readFile(timelineFile, "utf8")).toBe(originalTimeline);
    await expect.poll(() => approvalAudio.evaluateAll((audio) =>
      audio.map((element) => (element as HTMLAudioElement).dataset.framediffVolume))).toEqual(["1"]);

    // The final generated video supplies picture only. The locked audio composition is the sole
    // audio authority in the edit, so the two outputs cannot double up.
    const finalVideo = editPreview.locator('[data-fd-id="workflow-final"] video[data-framediff-video]');
    await expect(finalVideo).toHaveCount(1);
    await expect.poll(() => finalVideo.evaluate((video: HTMLVideoElement) => ({
      previewVolume: video.volume,
      exportVolume: video.dataset.framediffVolume,
    }))).toEqual({
      previewVolume: 0,
      exportVolume: "0",
    });

    await page.locator('.clip[data-item-id="workflow-audio"]').evaluate((element) =>
      (element as HTMLButtonElement).click());
    await expect(page.getByText(
      "Removes only this timeline placement. The source composition remains available. Undo restores it.",
      { exact: true },
    )).toBeVisible();
    await page.getByRole("button", { name: "DELETE FROM TIMELINE" }).click();
    await page.getByRole("button", { name: "CONFIRM DELETE" }).click();

    await expect.poll(async () => {
      const document = JSON.parse(await readFile(timelineFile, "utf8")) as { items: Array<{ id: string }> };
      return document.items.some((item) => item.id === "workflow-audio");
    }).toBe(false);
    await expect(page.locator('.clip[data-item-id="workflow-audio"]')).toHaveCount(0);
    await expect(page.locator('.clip[data-item-id="workflow-audio-card"]')).toHaveCount(1);
    await expect(finalVideo).toHaveCount(1);
    await expect.poll(() => finalVideo.evaluate((video: HTMLVideoElement) => ({
      display: getComputedStyle(video).display,
      readyState: video.readyState,
      source: video.currentSrc,
    }))).toMatchObject({
      display: "block",
      readyState: 4,
      source: expect.stringContaining("/__framediff-cache/"),
    });
    const libraryAudio = page.locator('.library-zone .composition-row[data-composition-key="lighthouse-dialogue-audio"]');
    await expect(libraryAudio).toHaveCount(1);
    await expect(page.getByText(
      "Removed Locked dialogue performance from the timeline. lighthouseDialogueAudio remains available.",
      { exact: true },
    )).toBeVisible();

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(async () => readFile(timelineFile, "utf8")).toBe(originalTimeline);
    await expect.poll(async () => readFile(htmlFile, "utf8")).toBe(originalHtml);
    await expect(page.locator('.clip[data-item-id="workflow-audio"]')).toHaveCount(1);
    await expect(finalVideo).toHaveCount(1);
  } finally {
    if (await readFile(timelineFile, "utf8") !== originalTimeline) await writeFile(timelineFile, originalTimeline);
    if (await readFile(htmlFile, "utf8") !== originalHtml) await writeFile(htmlFile, originalHtml);
  }
});
