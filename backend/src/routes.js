/**
 * Automation API routes — mounted at /api/automation.
 *
 * Endpoints:
 *   GET  /info              – lists available providers and services
 *   POST /start             – creates and starts an automation task
 *   POST /stop/:taskId      – cancels a running task
 *   GET  /stream/:taskId    – streams live task events via SSE
 *   GET  /results/:taskId   – returns final status and results
 */
import { Router } from "express";
import { emailProviders, registrationServices } from "./engine/registry.js";
import {
  createTask,
  getTask,
  cancelTask,
  resolvePendingCaptcha,
  resolvePendingTvboomDone,
  rejectPendingTvboomDone,
} from "./engine/taskStore.js";
import { runTask } from "./engine/runner.js";
import logger from "./logger.js";

const router = Router();

// ── Info ─────────────────────────────────────────────────────────────────────
// Returns available providers and services so the UI can populate its selectors.

router.get("/info", (_req, res) => {
  res.json({
    providers: emailProviders.map((p) => p.meta),
    services: registrationServices.map((s) => s.meta),
  });
});

// ── Start task ───────────────────────────────────────────────────────────────
// Body: { providerId: string, serviceIds: string[] }
// Creates a task and fires it off asynchronously — the client tracks progress via SSE.

router.post("/start", async (req, res) => {
  const { providerId, serviceIds } = req.body;

  if (!providerId || !Array.isArray(serviceIds) || !serviceIds.length) {
    return res
      .status(400)
      .json({ error: "`providerId` and `serviceIds[]` are required." });
  }

  const { taskId } = createTask();
  logger.info(`[Route] Starting task ${taskId}`);

  // Run without awaiting so the taskId can be returned immediately
  runTask(taskId, providerId, serviceIds).catch((err) =>
    logger.error(`[Route] Unhandled task error: ${err.message}`),
  );

  res.json({ taskId });
});

// ── Stop task ────────────────────────────────────────────────────────────────

router.post("/stop/:taskId", async (req, res) => {
  await cancelTask(req.params.taskId);
  res.json({ ok: true });
});

// ── Stream (SSE) ─────────────────────────────────────────────────────────────
// Streams live task events to the client using Server-Sent Events.

router.get("/stream/:taskId", (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: "Task not found" });

  // SSE requires these headers; X-Accel-Buffering disables Nginx proxy buffering
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Keep the connection alive through idle periods
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 20000);

  const sendEvent = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  const onDone = () => {
    clearInterval(keepAlive);
    res.write(`data: ${JSON.stringify({ type: "stream_end" })}\n\n`);
    res.end();
  };

  task.emitter.on("event", sendEvent);
  task.emitter.once("done", onDone);

  // Clean up listeners if the client disconnects before the task finishes
  req.on("close", () => {
    clearInterval(keepAlive);
    task.emitter.off("event", sendEvent);
    task.emitter.off("done", onDone);
  });
});

// ── Captcha relay ─────────────────────────────────────────────────────────────
// The frontend solves the reCAPTCHA widget and POSTs the token here.
// Body: { token: string }

router.post("/captcha/:taskId", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "`token` is required." });

  const ok = resolvePendingCaptcha(req.params.taskId, token);
  if (!ok)
    return res.status(404).json({ error: "No captcha pending for this task." });

  res.json({ ok: true });
});

// ── TVBoom registration relay ─────────────────────────────────────────────────
// Frontend POSTs here after the user completes (done) or cancels (cancel) the iframe registration.

const tvboomRelay = (fn) => (req, res) => {
  const ok = fn(req.params.taskId);
  return ok
    ? res.json({ ok: true })
    : res.status(404).json({ error: "No TVBoom registration pending." });
};

router.post("/tvboom-done/:taskId", tvboomRelay(resolvePendingTvboomDone));
router.post("/tvboom-cancel/:taskId", tvboomRelay(rejectPendingTvboomDone));

// ── Results ───────────────────────────────────────────────────────────────────

router.get("/results/:taskId", (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: "Task not found" });
  res.json({ status: task.status, results: task.results });
});

export default router;
